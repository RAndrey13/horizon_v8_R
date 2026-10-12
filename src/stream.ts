// ---------------------------------------------------------------------------
// Stream: createStreamFn — replaces OpenClaw's HTTP transport (SSE/JSON-Patch)
// ---------------------------------------------------------------------------

import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import type { Account, SessionState } from "./types.js";
import { callDeepSeekWeb, uploadImageToDeepSeek, waitForFileReady } from "./client.js";
import { findToolCallStartBroad, isToolCallJsonStart, parseToolCallAll } from "./parser.js";
import { looksLikeToolCallMarkup } from "./toolparse.js";
import { normalizeMessageContent, formatMessages, formatLastTurn, cleanMinimalPrompt, stripOpenClawContextBlock, collectImageDataUrls } from "./sanitize.js";
import { buildRuntimeBlock, stripRuntimeMarkers } from "./runtime.js";
import { envBool } from "./env.js";
import { MODEL_CONFIGS, makeEmptyUsage, buildUsage, makeEmptyPartial } from "./models.js";
import { getSession, deriveSessionKey } from "./sessions.js";
import { selectAccount, markAccountFailure, markAccountSuccess, resetWebSession } from "./accounts.js";
import { decideSessionMode, tokenLimit, estimateTokens, countCompactionSummaries, latestCompactionSignature } from "./registry.js";
import { mylog } from "./logger.js";

// A body that starts like an actual tool-call envelope must never be shown as
// assistant text (fragments such as `{"tool_call` leak into chat and make the
// model repeat them). Anything else — even a JSON-looking answer — is content.
function isToolCallEnvelopeStart(text: string): boolean {
  return /^\s*(\{"tool_call|\{"tool\b|TOOL_CALL:|<tool_calls?\b|<invoke\b)/.test(text);
}

// Читает ответ DeepSeek целиком (SSE JSON-Patch или обычный JSON) и возвращает
// накопленный текст, reasoning и счётчик токенов. Используется и основным
// путём, и повтором при битом tool-call markup, чтобы логика чтения не
// дублировалась. Ничего не эмитит — только собирает состояние.
async function readBufferedStream(
  resp: Response,
  session: SessionState,
): Promise<{ content: string; reasoning: string; accUsage: number | null }> {
  let fullContent = "";
  let reasoningContent = "";
  let streamAccumulatedUsage: number | null = null;

  if (resp.body && resp.headers.get("content-type")?.includes("text/event-stream")) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const fragments: { id?: number; type?: string; content?: string }[] = [];
    let lastPath: string | null = null;

    const rebuildFragmentState = () => {
      // Change horizon-v8-stream-finaltext: any fragment that is NOT reasoning
      // counts as answer text. Previously only RESPONSE/SEARCH did, so a final
      // answer emitted under an unknown fragment type was dropped entirely.
      const responseText = fragments
        .filter((f) => f && f.type !== "THINK" && f.type !== "REASONING" && typeof f.content === "string")
        .map((f) => f.content as string)
        .join("");
      const thinkText = fragments
        .filter((f) => f && (f.type === "THINK" || f.type === "REASONING") && typeof f.content === "string")
        .map((f) => f.content as string)
        .join("");
      if (responseText) fullContent = responseText;
      reasoningContent = thinkText;
    };

    const appendFragments = (value: unknown) => {
      const incoming = Array.isArray(value) ? value : [value];
      for (const fragment of incoming) {
        if (fragment && typeof fragment === "object") fragments.push({ ...(fragment as any) });
      }
      rebuildFragmentState();
    };

    const applyPatchOps = (ops: unknown) => {
      if (!Array.isArray(ops)) return;
      for (const op of ops) {
        if (op && typeof op === "object" && (op as any).p === "fragments" && (op as any).o === "APPEND" && (op as any).v !== undefined) {
          appendFragments((op as any).v);
        } else if (op && typeof op === "object" && (op as any).p === "accumulated_token_usage" && typeof (op as any).v === "number") {
          streamAccumulatedUsage = (op as any).v;
        }
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith("data: ")) continue;
        const raw = t.slice(6);
        if (raw === "[DONE]") continue;
        try {
          const ev = JSON.parse(raw);
          if (ev.p !== undefined) lastPath = ev.p;
          if (ev.v && typeof ev.v === "object" && ev.v.response) {
            const r = ev.v.response;
            if (r.message_id) session.parentMessageId = String(r.message_id);
            if (Array.isArray(r.fragments)) {
              fragments.length = 0;
              appendFragments(r.fragments);
            }
          } else if (lastPath === "response/fragments" && ev.v !== undefined) {
            appendFragments(ev.v);
          } else if (lastPath === "response" && ev.v !== undefined) {
            applyPatchOps(ev.v);
          } else if (lastPath && /^response\/fragments\/\d+\/content$/.test(lastPath) && ev.v !== undefined && typeof ev.v !== "object") {
            // Change horizon-v8-stream-finaltext: numeric fragment index
            // (fragments/<n>/content) was not handled at all, so a delta that
            // addressed an existing fragment by id was silently ignored.
            const idx = Number(lastPath.split("/")[2]);
            let target = fragments.find((f) => f && f.id === idx);
            if (!target) { target = { id: idx, type: "RESPONSE", content: "" }; fragments.push(target); }
            target.content = `${target.content || ""}${ev.v}`;
            rebuildFragmentState();
          } else if (lastPath === "response/fragments/-1/content" && ev.v !== undefined && typeof ev.v !== "object") {
            // Change horizon-v8-stream-finaltext: DeepSeek sometimes streams the
            // whole final answer ONLY as `-1/content` deltas with no base
            // fragment. Create the last fragment instead of dropping the text.
            if (fragments.length === 0) {
              fragments.push({ type: "RESPONSE", content: "" });
            }
            const lastFragment = fragments[fragments.length - 1];
            lastFragment.content = `${lastFragment.content || ""}${ev.v}`;
            rebuildFragmentState();
          } else if (lastPath === "response/content" && ev.v !== undefined && typeof ev.v !== "object") {
            fullContent += ev.v;
          } else if (typeof ev.v === "number" && (lastPath || "").endsWith("accumulated_token_usage")) {
            streamAccumulatedUsage = ev.v;
          }
        } catch {}
      }
    }
  } else {
    const bodyText = await resp.text();
    // HTML guard: DeepSeek (or an intermediary) sometimes answers with a
    // login/WAF page instead of the JSON envelope. Such a body must never
    // become assistant text.
    const bodyCt = resp.headers.get("content-type") || "";
    if (bodyCt.includes("text/html") || bodyText.trimStart().startsWith("<")) {
      throw new Error(`DeepSeek: HTML response instead of API (HTTP ${resp.status}, ct=${bodyCt || "none"})`);
    }
    // Safety net: never emit a JSON error envelope as assistant text.
    let env: any;
    try { env = JSON.parse(bodyText); } catch {}
    const envCode = env?.data?.biz_code ?? env?.biz_code;
    const envTop = typeof env?.code === "number" ? env.code : 0;
    if ((typeof envCode === "number" && envCode !== 0) || envTop !== 0) {
      throw new Error(`DeepSeek: envelope error code=${envTop} biz_code=${envCode} ${env?.data?.biz_msg ?? env?.biz_msg ?? env?.msg ?? ""}`);
    }
    fullContent = bodyText;
  }

  return { content: fullContent, reasoning: reasoningContent, accUsage: streamAccumulatedUsage };
}

export interface StreamDeps {
  accounts: Account[];
  sessions: Map<string, SessionState>;
  rrRef: { value: number };
  inFlightRef: { value: number };
  persist: () => void;
}

export function createStreamFn(ctx: any, deps: StreamDeps) {
  const { accounts, sessions, rrRef, inFlightRef, persist } = deps;
  return async (model: any, context: any, options?: any) => {
    // Change horizon-v8-log-stream-call: warn-level marker fires on EVERY
    // stream call regardless of the hz_log info gate, so one live run proves
    // whether the plugin is reached at all (info markers are gated off after
    // a restart).
    mylog("warn", `[horizon_v8] stream call model=${model?.id ?? model?.name ?? "?"} lane=${(context as any)?.lane ?? "?"}`);
          const stream = createAssistantMessageEventStream();
          const sid = model?.id || "deepseek-default";
          const mc = MODEL_CONFIGS[sid];
          if (!mc) {
            // Unknown model, return error
            const empty = makeEmptyUsage();
            const errMsg = `Unknown model: ${sid}`;
            stream.push({
              type: "error",
              reason: "error",
              error: {
                role: "assistant", content: [{ type: "text", text: "" }],
                api: "openai-completions", provider: "horizon_v8", model: sid,
                usage: empty, stopReason: "error", errorMessage: errMsg, timestamp: Date.now(),
              },
            });
            return stream;
          }

          let account: Account | null = null;
          (async () => {
            inFlightRef.value++;
            try {
              const rawSystemPrompt = context.systemPrompt || "";
              const messages = context.messages || [];
              const tools = context.tools || [];
              // Рантайм-данные берём из исходного промпта ядра, затем вырезаем
              // из него дублирующие маркеры и старый блок "## Runtime", чтобы
              // наш хвост был единственным.
              const runtimeBlock = buildRuntimeBlock({ sid, systemPrompt: rawSystemPrompt, messages, ctx, context });
              const systemPrompt = stripRuntimeMarkers(rawSystemPrompt);

              // Ключ реестра: реальный id сессии OpenClaw приходит per-call в
              // options.sessionId (StreamFn signature: model, context, options).
              // Fallback-цепочка: options.sessionId -> ctx.sessionKey ->
              // deriveSessionKey(agentDir, model). Последний ключ общий для всех
              // сессий агента+модели, поэтому используется только как крайний случай.
              const openclawSessionId = options?.sessionId ? String(options.sessionId) : "";
              const ctxSessionKey = ctx?.sessionKey ? String(ctx.sessionKey) : "";
              // Stable session key (change horizon-v8-stable-session-key):
              // ctx.sessionKey is constant for the whole chat; options.sessionId
              // may vary per call; the derived key is now agent-scoped and no
              // longer embeds the model id (a model switch used to fork a new
              // web chat). Priority: ctx.sessionKey -> options.sessionId -> derived.
              const keyBranch = ctxSessionKey ? "ctx.sessionKey" : (openclawSessionId ? "options.sessionId" : "derived");
              const sessionKey = ctxSessionKey
                || openclawSessionId
                || deriveSessionKey(ctx?.agentDir || ctx?.workspaceDir);
              mylog("info", `[horizon_v8] session key branch=${keyBranch} key=${sessionKey}`);
              const session = getSession(sessions, sessionKey);
              if (session.openclawSessionId !== sessionKey) session.openclawSessionId = sessionKey;
              // Model change = new web chat (change horizon-v8-rotate-on-model).
              // A DeepSeek web chat is bound to ONE model type (chat/expert/...);
              // it cannot switch mid-session. So when OpenClaw falls back to a
              // different model, we start a fresh web session and send the full
              // prompt on the next turn (useMinimal stays false because id=null).
              const currentModelType = String(mc.model_type || sid);
              if (session.modelType && session.modelType !== currentModelType) {
                mylog("info", `[horizon_v8] model changed (${session.modelType} -> ${currentModelType}); rotating web session`);
                resetWebSession(session);
              }
              session.modelType = currentModelType;
              // Компакт ядра = новая web-сессия: старая история у DeepSeek уже
              // неактуальна (истина в сводке), а её кэш только грузит систему.
              // Триггер — СИГНАТУРА сводки, а не счётчик: после любого компакта
              // в окне ровно одна сводка, поэтому count>prev сработал бы лишь
              // единожды. Сменившийся текст сводки ловит и повторные компакты.
              const compactSig = latestCompactionSignature(messages);
              if (compactSig && compactSig !== (session.lastCompactionSig ?? "")) {
                session.compactions = countCompactionSummaries(messages);
                session.lastCompactionSig = compactSig;
                mylog("info", `[horizon_v8] compact detected (summaries=${session.compactions}); rotating web session`);
                resetWebSession(session);
              }
              const limit = tokenLimit();
              const decision = decideSessionMode(session, limit);
              if (decision.mode === "recreate") {
                mylog("info", `[horizon_v8] registry rotate key=${sessionKey} reason=${decision.reason} turns=${session.turns} tokOpenclaw=${session.tokensOpenclaw} tokDeepseek=${session.tokensDeepseek}`);
                resetWebSession(session);
              }
              // The full prompt is always assembled (fallback + comparison dump);
              // minimal is sent only on repeat turns while the flag is on.
              const fullPrompt = formatMessages(messages, systemPrompt, tools, runtimeBlock);
              // Structural tail only (change horizon-v8-minimal-followup): the
              // minimal prompt is built solely by formatLastTurn(context.messages).
              // The old text fallback via fullPrompt.lastIndexOf("\nUser: ") is
              // removed: an empty tail simply leaves useMinimal=false and the
              // turn goes full (first turn / recreate).
                            // Minimal follow-up (repeat turns only): the structural tail from
// formatLastTurn — Observation-only after a tool round-trip, or the
// current user turn otherwise. Empty -> useMinimal=false -> full.
let minimalPrompt = formatLastTurn(messages);
              const parentNum = session.parentMessageId != null && session.parentMessageId !== ""
                ? Number(session.parentMessageId) : null;
              const hasParent = parentNum !== null && Number.isFinite(parentNum) && parentNum > 0;
              const hasAssistant = messages.some((m: any) => m?.role === "assistant");
              const followupEnabled = envBool("HORIZON_MINIMAL_FOLLOWUP", true);
              // Change horizon-v8-tools-in-minimal: the minimal follow-up tail
              // (formatLastTurn) contains NO tool definitions, so a continuation
              // turn would reach the model with zero knowledge of the tools and
              // it answers with prose instead of a call. When tools are offered,
              // always send the full prompt that carries the TOOL REQUEST SYSTEM
              // block; minimal is allowed only when there are no tools at all.
              const hasTools = (tools?.length ?? 0) > 0;
              const useMinimal =
                followupEnabled &&
                decision.mode === "continue" &&
                hasParent &&
                hasAssistant &&
                !hasTools &&
                minimalPrompt.trim().length > 0;
              const minRaw = minimalPrompt.length;
              const prompt = useMinimal ? minimalPrompt : fullPrompt;
              mylog("info", `[horizon_v8] flag=${followupEnabled ? "1" : "0"} parent=${session.parentMessageId ?? "null"} minRaw=${minRaw} minLen=${minimalPrompt.length} useMinimal=${useMinimal}`);
              mylog("info", `[horizon_v8] registry key=${sessionKey} mode=${decision.mode}(${decision.reason}) turns=${session.turns} tokOpenclaw=${session.tokensOpenclaw} tokDeepseek=${session.tokensDeepseek} limit=${limit} web=${session.id ?? "-"}`);
              account = selectAccount(accounts, session, rrRef);

              mylog("info", `[horizon_v8] ${sid} ${prompt.length}ch`);

              // Upload any images from the raw messages and pass their file
              // ids as ref_file_ids. Without this DeepSeek sees only text and
              // hallucinates the picture.
              let refFileIds: string[] = [];
              try {
                const images = collectImageDataUrls(messages);
                if (images.length > 0) {
                  mylog("info", `[horizon_v8] ${sid} uploading ${images.length} image(s)`);
                  for (const dataUrl of images) {
                    try {
                      const id = await uploadImageToDeepSeek(dataUrl, account);
                      const ready = await waitForFileReady(id, account);
                      if (ready) refFileIds.push(id);
                      else mylog("warn", `[horizon_v8] image ${id} not ready, skipped`);
                    } catch (e: any) {
                      mylog("warn", `[horizon_v8] image upload failed: ${e?.message || e}`);
                    }
                  }
                }
              } catch (e: any) {
                mylog("warn", `[horizon_v8] image collection failed: ${e?.message || e}`);
              }

              // Change horizon-v8-log-webcall: warn-level breadcrumbs around
              // the network call, so a stream that dies silently between entry
              // and try/catch still leaves a trace (info is gated off).
              mylog("warn", `[horizon_v8] entering web call sid=${sid} model=${mc.model_type} thinking=${mc.thinking_enabled}`);
              const resp = await callDeepSeekWeb(
                prompt, session, account,
                mc.model_type, mc.thinking_enabled, mc.search_enabled,
                refFileIds, fullPrompt,
                { accounts, persist },
              );
              mylog("warn", `[horizon_v8] web call returned sid=${sid}`);

              let fullContent = "";
              let reasoningContent = "";
              let contentIndex = 0;
              let thinkingIndex = -1;
              let streamAccumulatedUsage: number | null = null;

              const emit = (event: any) => stream.push(event);

              {
                const buffered = await readBufferedStream(resp, session);
                fullContent = buffered.content;
                reasoningContent = buffered.reasoning;
                streamAccumulatedUsage = buffered.accUsage;
                mylog("warn", `[horizon_v8] stream read done sid=${sid} text=${fullContent.length}ch reasoning=${reasoningContent.length}ch`);
                // Change horizon-v8-log-reply-head: show the FIRST 200 chars of the
                // model's raw reply, so we can tell prose from tool-call markup.
                mylog("warn", `[horizon_v8] reply head (first 200): ${fullContent.slice(0, 200)}`);
              }

              // === Разбор markup ДО эмита ====================================
              // Как в FreeDeepseekAPI: стрим прочитан ПОЛНОСТЬЮ, markup разобран
              // до первого эмита. Если markup похож на вызов, но не парсится
              // (обрезан/битый) — НЕ отдаём его как текст: делаем один повтор
              // со строгим промптом. Если и повтор не удался — безопасная
              // ошибка, а не утечка DSML/JSON в чат.
              // Форма tools приходит в двух видах:
              //  - OpenAI-обёртка: { type: "function", function: { name, ... } }
              //  - нормализованный Context.tools от OpenClaw: { name, description, parameters }
              // Раньше учитывался только первый — на плоском массиве набор всегда
              // был пуст, и вызовы инструментов молча не разбирались.
              const allowedToolNames = new Set<string>(
                (tools || [])
                  .map((t: any) => (t?.type === "function" && t?.function) ? t.function.name : t?.name)
                  .filter((n: any) => typeof n === "string" && n.length > 0)
                  .map((n: string) => String(n)),
              );
              // Change horizon-v8-log-tools-offered: count the tools the plugin
              // actually received. tools=0 => the tool list never reaches the
              // plugin; tools>0 but prose reply => the model ignored them.
              mylog("warn", `[horizon_v8] tools offered=${allowedToolNames.size}`);
              // Финализация идёт с выключенными инструментами (tools=[]). В этом
              // режиме markup вызова парсить/эмитить нельзя: хост ждёт только
              // видимый ответ, а прежний безусловный parseToolCallAll на таком
              // ходу выдавал tool-use из финализирующего текста.
              let toolCalls = allowedToolNames.size > 0 ? parseToolCallAll(fullContent) : [];
              if (allowedToolNames.size > 0 && toolCalls.some((tc) => !allowedToolNames.has(tc.name))) {
                // Change horizon-v8-per-call-filter: keep the calls we CAN run instead
                // of zeroing the whole batch. A single stray/unknown name used to drop
                // every valid call in the same turn and force a strict retry.
                const kept = toolCalls.filter((tc) => allowedToolNames.has(tc.name));
                // Change horizon-v8-log-unknown-names: name the rejected tools so a
                // failure says WHICH unknown tool the model asked for. Previously the
                // log only said "unknown tool", which made root-causing impossible.
                const unknownNames = toolCalls.filter((tc) => !allowedToolNames.has(tc.name)).map((tc) => tc.name).join(", ");
                if (kept.length > 0) {
                  mylog("info", `[horizon_v8] model requested unknown tool; dropped ${toolCalls.length - kept.length} unknown call(s) [${unknownNames}], kept ${kept.length}`);
                  toolCalls = kept;
                } else {
                  mylog("info", `[horizon_v8] model requested unknown tool(s) [${unknownNames}]; treating markup as broken`);
                  // Change horizon-v8-log-raw-markup: dump the model's raw text so a
                  // failure shows the EXACT markup shape and tool name, not just a
                  // parsed (possibly mis-parsed) name.
                  mylog("info", `[horizon_v8] raw unknown-tool markup (first 400): ${fullContent.slice(0, 400)}`);
                  toolCalls = [];
                }
              }
              let toolCall = toolCalls.length > 0 ? toolCalls[0] : null;
              let markupUnrepairable = false;

              if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                // Change horizon-v8-no-fork-on-error: the strict retry MUST go
                // into the SAME web session (the model sees its own truncated
                // turn and corrects itself). resetWebSession here used to fork
                // a fresh chat and lose the accumulated context.
                mylog("info", `[horizon_v8] tool-call markup detected but invalid/truncated (${fullContent.length} chars); retrying with strict prompt on the SAME web session`);
                await new Promise((r) => setTimeout(r, 1000));
                const strictPrompt = `[STRICT INSTRUCTION] Your previous reply was cut off and contained incomplete tool-call markup, so it could not be parsed. Do NOT continue or repeat the broken fragment. Reissue the ENTIRE response from scratch as a SINGLE strict JSON object and nothing else: {"tool_call":{"name":"<function>","arguments":{...}}}. Requirements: valid JSON only; double-quoted keys and strings; no markdown code fences; no DSML/XML tags; no commentary before or after the object; keep argument values short.`;
                try {
                  // Change horizon-v8-strict-retry-no-thinking: the strict retry
                  // MUST run with thinking OFF. With thinking on, deepseek-reasoner
                  // re-wraps the answer in DSML/<tool_calls> and the retry fails the
                  // same way as the first attempt.
                  const retryResp = await callDeepSeekWeb(
                    strictPrompt, session, account!,
                    mc.model_type, false, mc.search_enabled,
                    refFileIds, strictPrompt,
                    { accounts, persist },
                  );
                  const retryBuffered = await readBufferedStream(retryResp, session);
                  const retryCalls = parseToolCallAll(retryBuffered.content)
                    .filter((tc) => allowedToolNames.has(tc.name));
                  if (retryCalls.length > 0) {
                    mylog("info", `[horizon_v8] strict retry succeeded: ${retryCalls[0].name}`);
                    fullContent = retryBuffered.content;
                    reasoningContent = retryBuffered.reasoning;
                    streamAccumulatedUsage = retryBuffered.accUsage;
                    toolCalls = retryCalls;
                    toolCall = retryCalls[0];
                  } else {
                    mylog("warn", "[horizon_v8] strict retry still broken; returning safe error instead of leaking markup");
                    mylog("warn", `[horizon_v8] raw first-attempt markup (first 400): ${fullContent.slice(0, 400)}`);
                    mylog("warn", `[horizon_v8] raw strict-retry markup (first 400): ${retryBuffered.content.slice(0, 400)}`);
                    markupUnrepairable = true;
                    fullContent = "";
                    toolCalls = [];
                    toolCall = null;
                  }
                } catch (e: any) {
                  mylog("warn", `[horizon_v8] strict retry failed: ${e?.message || e}`);
                  markupUnrepairable = true;
                  fullContent = "";
                  toolCalls = [];
                  toolCall = null;
                }
              }

              // === Эмит ======================================================
              emit({ type: "start", partial: makeEmptyPartial("assistant", sid) });

              if (markupUnrepairable) {
                // Не смогли распарсить и повтор не помог: явная ошибка вместо
                // утечки обрывков markup в чат. Клиент увидит причину и сможет
                // повторить запрос.
                const emptyUsage = makeEmptyUsage();
                const msg = "Модель вернула некорректный tool-call markup; повтор со строгим промптом не помог. Запрос не выполнен.";
                stream.push({
                  type: "error", reason: "error",
                  error: {
                    role: "assistant", content: [{ type: "text", text: "" }],
                    api: "openai-completions", provider: "horizon_v8", model: sid,
                    usage: emptyUsage, stopReason: "error", errorMessage: msg, timestamp: Date.now(),
                  },
                });
                mylog("error", `[horizon_v8] ${msg}`);
                return;
              }

              if (reasoningContent.trim()) {
                thinkingIndex = contentIndex;
                emit({ type: "thinking_start", contentIndex: thinkingIndex, partial: makeEmptyPartial("assistant", sid) });
                emit({ type: "thinking_delta", contentIndex: thinkingIndex, delta: reasoningContent, partial: makeEmptyPartial("assistant", sid) });
                emit({ type: "thinking_end", contentIndex: thinkingIndex, content: reasoningContent, partial: makeEmptyPartial("assistant", sid) });
              }

              const usage = buildUsage(prompt, fullContent, reasoningContent, streamAccumulatedUsage, session.tokensDeepseek);
              // Чистый текст ответа. Режем по анкору ВСЕГДА: markup не должен
              // попадать в чат, даже если вызов битый и не распарсился (иначе
              // обрывки DSML/JSON утекают пользователю — исходный симптом).
              const tcs = findToolCallStartBroad(fullContent);
              const rawText = tcs === -1 ? fullContent : fullContent.slice(0, tcs);
              let textContent: string =
                isToolCallJsonStart(rawText) || isToolCallEnvelopeStart(rawText) ? "" : rawText;
              // Safety net: never lose the reply (только для случая без видимого контента).
              if (!toolCall) {
                if (!textContent.trim() && !fullContent.trim() && reasoningContent.trim()) {
                  textContent = reasoningContent;
                }
              }

              if (toolCalls.length > 0) {
                const stamp = Date.now();
                const blocks = toolCalls.map((tc, i) => ({
                  tcId: toolCalls.length === 1
                    ? `call_${stamp}_${Math.random().toString(36).substring(2, 8)}`
                    : `call_${stamp}_${i}_${Math.random().toString(36).substring(2, 8)}`,
                  name: tc.name,
                  args: tc.args,
                }));
                const contentBlocks = blocks.map((b) => ({ type: "toolCall" as const, id: b.tcId, name: b.name, arguments: b.args }));
                emit({
                  type: "text_end", contentIndex, content: "",
                  partial: { role: "assistant", content: contentBlocks, api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse" as const, timestamp: Date.now() },
                });
                let ci = contentIndex;
                for (const b of blocks) {
                  emit({
                    type: "toolcall_start", contentIndex: ci,
                    partial: { role: "assistant", content: [], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse" as const, timestamp: Date.now() },
                  });
                  emit({
                    type: "toolcall_end", contentIndex: ci,
                    toolCall: { type: "toolCall" as const, id: b.tcId, name: b.name, arguments: b.args },
                    partial: { role: "assistant", content: [], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse" as const, timestamp: Date.now() },
                  });
                  ci++;
                }
                emit({
                  type: "done", reason: "toolUse" as const,
                  message: { role: "assistant", content: contentBlocks, api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "toolUse", timestamp: Date.now() },
                });
                mylog("info", `[horizon_v8] tool calls emitted: ${blocks.length}`);
              } else {
                if (textContent) {
                  emit({ type: "text_start", contentIndex, partial: makeEmptyPartial("assistant", sid) });
                  emit({ type: "text_delta", contentIndex, delta: textContent, partial: makeEmptyPartial("assistant", sid) });
                }
                emit({
                  type: "text_end", contentIndex, content: textContent,
                  partial: { role: "assistant", content: [{ type: "text", text: textContent }], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "stop", timestamp: Date.now() },
                });
                stream.end({
                  role: "assistant", content: [{ type: "text", text: textContent }], api: "openai-completions", provider: "horizon_v8", model: sid, usage, stopReason: "stop", timestamp: Date.now(),
                });
              }

              // parentMessageId: сохраняем id из стрима (см. emit-цикл), не сбрасываем
              session.messageCount++;
              // --- Registry counters (change horizon-v8-session-registry) -----
              // Rotation is driven by the AUTHORITATIVE DeepSeek counter
              // (accumulated_token_usage from the response stream), not by the
              // chars/4 estimate. tokensOpenclaw is kept only as a loose fuse.
              session.turns += 1;
              session.tokensOpenclaw += estimateTokens(prompt.length);
              if (streamAccumulatedUsage !== null) {
                session.tokensDeepseek = streamAccumulatedUsage;
                session.tokensRefreshedAt = Date.now();
              }
              // No history_messages fallback on purpose: when the stream carries
              // no counter we keep the previous value. If the counter ever falls
              // behind far enough for DeepSeek to reject the session, the error
              // surfaces upstream and we handle it then (force-recreate/compact)
              // rather than polling history_messages on every 10th turn.
              // Optional message-count fuse. Disabled by default (0): the real
              // token counter plus failure-retry handle rotation now.
              const maxSessionMsgs = Number(process.env.HORIZON_MAX_SESSION_MSGS) || 0;
              if (maxSessionMsgs > 0 && session.messageCount >= maxSessionMsgs) {
                mylog("info", `[horizon_v8] session ${session.id} reached ${session.messageCount} msgs, recreating`);
                resetWebSession(session);
              }
              mylog("info", `[horizon_v8] counters turn=${session.turns} msg=${session.messageCount} tokDS=${session.tokensDeepseek} tokOC=${session.tokensOpenclaw} streamUsage=${streamAccumulatedUsage ?? "n/a"}`);
              if (account) markAccountSuccess(account);
              persist();

              mylog("info", `[horizon_v8] Done ${fullContent.length}ch (toolCalls=${toolCalls.length})`);
            } catch (e: any) {
              mylog("warn", `[horizon_v8] stream threw sid=${sid}: ${e?.message || e}`);
              mylog("error", `[horizon_v8] Stream error: ${e.message}`);
              // Account failover is handled inside callDeepSeekWeb (every account
              // is marked there). Only mark here for failures that happened
              // OUTSIDE that call (image upload, stream read), so a failed
              // account is never counted twice.
              if (account && !e?.__horizonAccountsMarked) {
                markAccountFailure(account, persist, e?.message ? String(e.message).slice(0, 200) : "stream error");
              }
              const empty = makeEmptyUsage();
              stream.push({
                type: "error", reason: "error",
                error: { role: "assistant", content: [{ type: "text", text: "" }], api: "openai-completions", provider: "horizon_v8", model: model?.id || "unknown", usage: empty, stopReason: "error", errorMessage: e.message, timestamp: Date.now() },
              });
            } finally {
              inFlightRef.value--;
            }
          })();

          return stream;
        };
}
