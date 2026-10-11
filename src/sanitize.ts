// ---------------------------------------------------------------------------
// Sanitize / prompt shaping: runtime-context cleanup, tool defs, message formatting
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type { ChatWindowHistoryEntry } from "./types.js";
import { STRIP_CHAT_WINDOW, RUNTIME_CONTEXT_MARKERS, CHAT_WINDOW_START_MARKERS, RUNTIME_CONTEXT_END_MARKER, stripInternalContextMarkers, indexOfAny, includesAny, RESTORE_HISTORY, ASSISTANT_SENDER_SET, TIME_TOKEN_RE, EXTRA_SYSTEM_FILES, SMART_TRUNCATE, DEFAULT_TRUNCATE_SPEC, TRUNCATE_SPECS } from "./env.js";
import { mylog } from "./logger.js";

/** Removes the selected chat-window block, preserving Conversation info and the END marker. */
function stripChatWindowFromRuntimeContext(text: string): string {
  const startIdx = indexOfAny(text, CHAT_WINDOW_START_MARKERS);
  if (startIdx === -1) return text;
  let head = text.slice(0, startIdx);
  head = head.replace(/[ \t]*\n+[ \t]*$/, "\n");
  const endIdx = text.indexOf(RUNTIME_CONTEXT_END_MARKER, startIdx);
  if (endIdx === -1) return head;
  return head + RUNTIME_CONTEXT_END_MARKER + text.slice(endIdx + RUNTIME_CONTEXT_END_MARKER.length);
}

// ---------------------------------------------------------------------------
// Runtime-context history parse & restore (opt-in, HORIZON_RESTORE_HISTORY=1)
// ---------------------------------------------------------------------------

/** Парсит записи блока "Conversation context ..." → строки #id … Sender: body. */
function parseChatWindowHistoryEntries(text: string): ChatWindowHistoryEntry[] {
  const startIdx = indexOfAny(text, CHAT_WINDOW_START_MARKERS);
  if (startIdx === -1) return [];
  const endIdx = text.indexOf(RUNTIME_CONTEXT_END_MARKER, startIdx);
  const block = endIdx === -1 ? text.slice(startIdx) : text.slice(startIdx, endIdx);
  const entries: ChatWindowHistoryEntry[] = [];
  let current: ChatWindowHistoryEntry | null = null;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const idMatch = line.match(/^#(?:session:[0-9a-f-]+|\d+)\s+(.*)$/);
    if (idMatch) {
      // Новая запись: "<timestamp/флаги> <Sender>: <body>". Разделитель — первое ": ".
      const rest = idMatch[1];
      const sepIdx = rest.indexOf(": ");
      if (sepIdx === -1) { current = null; continue; }
      const prefix = rest.slice(0, sepIdx);
      const body = rest.slice(sepIdx + 2).trim();
      const tokens = prefix.split(/\s+/).filter(Boolean);
      while (tokens.length > 0 && TIME_TOKEN_RE.test(tokens[0])) tokens.shift();
      const sender = tokens.join(" ").trim();
      current = sender && body ? { sender, body } : null;
      if (current) entries.push(current);
    } else if (current && line.trim()) {
      // Продолжение многострочного тела записи
      current.body += "\n" + line.trimEnd();
    }
  }
  return entries;
}

/** Превращает записи блока в строки "User: …"/"Assistant: …" (пропуская #session и пустые). */
function chatWindowEntriesToRoleLines(entries: ChatWindowHistoryEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const senderLower = e.sender.toLowerCase();
    if (senderLower.startsWith("#")) continue; // внутренние статусы (#session и т.п.)
    if (senderLower === "session" || senderLower.includes("session")) continue;
    // Тело записи может нести экранированные ядром внутренние маркеры
    // (напр. пустой блок [[OPENCLAW_INTERNAL_CONTEXT_BEGIN]] ... END) — это
    // "дубль истории": после вырезки тело пустое, запись пропускаем.
    const body = stripInternalContextMarkers(e.body).trim();
    if (!body) continue;
    const role = ASSISTANT_SENDER_SET.has(senderLower) ? "Assistant" : "User";
    out.push(`${role}: ${body}`);
  }
  return out;
}

/** Считает "содержательные" user/assistant-ходы до индекса (без tool-обвязки и пустых). */
function countMeaningfulPriorMessages(messages: any[], uptoIdx: number): number {
  let count = 0;
  for (let i = 0; i < uptoIdx; i++) {
    const m = messages[i] as any;
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = normalizeMessageContent(m.content);
    if (!content || !content.trim()) continue;
    if (m.role === "assistant" && m.content && Array.isArray(m.content)) {
      const hasText = (m.content as any[]).some((b) => b?.type === "text" || b?.type === "thinking");
      if (!hasText) continue; // только tool-call — не считаем ходом
    }
    count++;
  }
  return count;
}

/** Ищет индекс последнего user-сообщения, несущего runtime-контекстный блок. */
function findRuntimeContextUserIndex(messages: any[]): number {
  let idx = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    if (m?.role !== "user") continue;
    const content = normalizeMessageContent(m.content);
    if (includesAny(content, RUNTIME_CONTEXT_MARKERS) && includesAny(content, CHAT_WINDOW_START_MARKERS)) idx = i;
  }
  return idx;
}

/** Вставляет пометку о восстановлении истории в JSON-блок "Conversation info" (untrusted metadata). */
function markRestoredInConversationInfo(text: string): string {
  if (!text || text.includes('"HORIZON_RESTORE_HISTORY"')) return text;
  const marker = "Conversation info (untrusted metadata):";
  const markerIdx = text.indexOf(marker);
  if (markerIdx === -1) return text;
  const braceIdx = text.indexOf("{", markerIdx);
  if (braceIdx === -1) return text;
  const prop = '"HORIZON_RESTORE_HISTORY": "true"';
  return text.slice(0, braceIdx + 1) + "\n  " + prop + "," + text.slice(braceIdx + 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Умная обрезка Observation по имени инструмента (head/tail + пометка).
function smartTruncate(toolName: string, content: string): string {
  if (!content) return "";
  // Ошибки: короткий сигнал вместо стектрейса/дампера.
  if (/^(failed|error|ошибка|✗|⚠️)/i.test(content.trimStart())) {
    const firstLine = content.trimStart().split(/\n/)[0] || "";
    return firstLine.length > 200 ? firstLine.slice(0, 200) + "..." : firstLine;
  }
  const spec = TRUNCATE_SPECS[toolName] || DEFAULT_TRUNCATE_SPEC;
  if (content.length <= spec.head + spec.tail) return content;
  // Граница обрезки помечается явно и машинно-понятно: сколько показано,
  // сколько пропущено и как добрать остаток (повторить инструмент с offset).
  if (spec.tail <= 0) {
    return content.slice(0, spec.head) +
      `\n...[TRUNCATED: показаны первые ${spec.head} из ${content.length} символов. ` +
      `Это граница обрезки — чтобы получить остаток, повтори инструмент с offset=${spec.head}]...`;
  }
  const head = content.slice(0, spec.head);
  const tail = content.slice(-spec.tail);
  const omitted = content.length - spec.head - spec.tail;
  return `${head}\n...[TRUNCATED: пропущено ${omitted} символов (показаны первые ${spec.head} и последние ${spec.tail} из ${content.length}). ` +
    `Середина не показана — чтобы добрать данные, повтори инструмент с offset=${spec.head}]...\n${tail}`;
}

function truncateObservation(toolName: string | undefined, content: string): string {
  if (!SMART_TRUNCATE) return content; // сжатие отключено — отдаём результат целиком
  return smartTruncate(toolName || "unknown", content);
}

export function normalizeMessageContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") return part.text || "";
      if (part.type === "tool_result") return `[Tool Result ${part.tool_use_id || ""}]\n${normalizeMessageContent(part.content)}`;
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return "[Image attached]";
      return part.text || part.content || JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    try { return JSON.stringify(content); } catch {}
  }
  return String(content);
}

// Collect base64 data-URLs of images from the raw messages (before formatMessages
// flattens everything into a single prompt string). client.ts uploads each of
// these to DeepSeek Web and puts the resulting file ids into ref_file_ids.
function imagePartToDataUrl(part: any): string | null {
  if (!part || typeof part !== "object") return null;
  const type = part.type;
  if (type === "image_url" || type === "input_image" || type === "image") {
    const direct = part.image_url?.url ?? part.image_url ?? part.url;
    if (typeof direct === "string") {
      if (direct.startsWith("data:")) return direct;
      if (direct.startsWith("http://") || direct.startsWith("https://")) return direct;
    }
    const b64 = part.data ?? part.base64 ?? part.source?.data;
    if (typeof b64 === "string" && b64.length > 0) {
      if (b64.startsWith("data:")) return b64;
      const mime = part.mimeType ?? part.media_type ?? part.source?.media_type ?? "image/png";
      return "data:" + mime + ";base64," + b64;
    }
  }
  return null;
}

export function collectImageDataUrls(messages: any[]): string[] {
  const urls: string[] = [];
  for (const msg of messages || []) {
    const content = (msg as any)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const url = imagePartToDataUrl(part);
      if (url) urls.push(url);
    }
  }
  return urls;
}
/**
 * Сообщение-сводка ядра (компакт или branch). Ядро отдаёт её двумя формами:
 *  - role="compactionSummary" с полем `summary`;
 *  - role="user" с content, начинающимся на COMPACTION_SUMMARY_PREFIX.
 * Вторая форма — та, что реально приходит в context.messages (convertToLlm).
 */
function isSummaryRole(m: any): boolean {
  if (!m) return false;
  if (m.role === "compactionSummary" || m.role === "branchSummary") return true;
  if (m.role === "user") {
    const t = typeof m.content === "string" ? m.content : normalizeMessageContent(m.content);
    return t.includes(COMPACTION_SUMMARY_PREFIX) || t.includes(BRANCH_SUMMARY_PREFIX);
  }
  return false;
}

/**
 * Чистое тело сводки: поле summary (форма compactionSummary) или content
 * user-сообщения, из которого снят служебный префикс ядра и теги <summary>.
 */
function summaryText(m: any): string {
  let body = typeof m?.summary === "string" && m.summary.trim()
    ? m.summary
    : normalizeMessageContent(m?.content);
  body = body.split(COMPACTION_SUMMARY_PREFIX).join("");
  body = body.split(BRANCH_SUMMARY_PREFIX).join("");
  body = body.replace(/<\/?summary>/g, "");
  return body.trim();
}

/**
 * Хвост после сводки отдаёт рантайм OpenClaw (бюджет keepRecentTokens): он
 * уже обрезан по токенам, пары toolCall/toolResult не разорваны, cut выровнен
 * по началу хода. Плагин НЕ должен резать его повторно по счётчику сообщений —
 * прежний `.slice(-3)` брал наугад середину хода и оставлял обрывок
 * незавершённой работы, из-за чего модель после компакта повторяла уже
 * сделанное.
 *
 * Здесь только страховка: если хвост заканчивается терминальной ошибкой
 * ассистента, её отбрасываем, чтобы модель не приняла сбой за «доделай».
 */
function trimIncompleteTail(msgs: any[]): any[] {
  let end = msgs.length;
  while (end > 0) {
    const m = msgs[end - 1] as any;
    if (m?.role === "assistant" && m?.stopReason === "error") {
      end--;
      continue;
    }
    break;
  }
  return end === msgs.length ? msgs : msgs.slice(0, end);
}

// ---------------------------------------------------------------------------
// Compact debug dump (диагностика, временно).
// Пишет СЫРОЙ context.messages на диск, чтобы разобрать, что ядро реально
// кладёт в окно после компакта: где сводка, где preserved-хвост
// ("## Recent turns preserved verbatim"), где живые сообщения. Ничего не
// режет и не меняет промпт — только сохраняет объект для разбора.
// Путь: HORIZON_COMPACT_DUMP_PATH, иначе /root/horizon_v8_compact_dump.json.
// Рядом дописывается .jsonl — по строке на каждый ход со сводкой (история).
function dumpCompactDebug(messages: any[], summaryMsgs: any[], loopMessages: any[]): void {
  try {
    const path = (process.env.HORIZON_COMPACT_DUMP_PATH || "").trim();
    if (!path) return; // opt-in only: no default path
    const safe = (m: any) => {
      const role = m?.role;
      let content = m?.content;
      if (Array.isArray(content)) {
        content = content.map((b: any) => {
          if (b?.type === "image" || b?.image_url || b?.source?.data) return { type: b?.type ?? "image", redacted: true };
          return b;
        });
      } else if (typeof content === "string" && content.length > 40000) {
        content = content.slice(0, 40000) + `\n...[truncated ${content.length} chars]`;
      }
      let summary = m?.summary;
      if (typeof summary === "string" && summary.length > 40000) summary = summary.slice(0, 40000) + "...[truncated]";
      return {
        role,
        ...(typeof summary === "string" ? { summary } : {}),
        stopReason: m?.stopReason,
        toolCallId: m?.toolCallId,
        toolName: m?.toolName,
        name: m?.name,
        content,
      };
    };
    const bodies = summaryMsgs.map((m: any) => summaryText(m));
    const markers = bodies.map((b) => ({
      len: b.length,
      hasPreservedVerbatim: b.includes("## Recent turns preserved verbatim"),
      hasTurnContextSplit: b.includes("Turn Context (split turn):"),
      hasTruncatedMarker: b.includes("[Earlier preserved messages truncated]"),
      tail: b.slice(Math.max(0, b.length - 600)),
    }));
    const payload = {
      ts: new Date().toISOString(),
      total: messages.length,
      summaryCount: summaryMsgs.length,
      loopCount: loopMessages.length,
      markers,
      summaryMsgs: summaryMsgs.map(safe),
      loopMessages: loopMessages.map(safe),
      allMessages: messages.map(safe),
    };
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
    appendFileSync(path + ".jsonl", JSON.stringify({ ts: payload.ts, total: payload.total, summaryCount: payload.summaryCount, markers: markers.map((x) => ({ len: x.len, verbatim: x.hasPreservedVerbatim, truncated: x.hasTruncatedMarker })) }) + "\n", "utf8");
    mylog("warn", `[horizon_v8] compact debug dump: ${path} (total=${payload.total} summaries=${summaryMsgs.length} verbatim=${markers.some((m) => m.hasPreservedVerbatim)})`);
  } catch (e: any) {
    mylog("warn", `[horizon_v8] compact debug dump failed: ${e?.message || e}`);
  }
}

// Сырой дамп context.messages КАК ЕГО ОТДАЛО ЯДРО: без обрезок, без
// редактирования полей, без вырезания base64. Только защита от circular
// и BigInt, чтобы JSON.stringify не упал. Путь: HORIZON_RAW_DUMP_PATH,
// иначе /root/horizon_v8_raw_messages.json.
function dumpRawMessages(messages: any[]): void {
  try {
    const path = (process.env.HORIZON_RAW_DUMP_PATH || "").trim();
    if (!path) return; // opt-in only: no default path
    const seen = new WeakSet();
    const json = JSON.stringify(messages, (_k, v) => {
      if (typeof v === "bigint") return String(v);
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }, 2);
    writeFileSync(path, json, "utf8");
    mylog("warn", `[horizon_v8] raw messages dump: ${path} (n=${messages.length}, bytes=${json.length})`);
  } catch (e: any) {
    mylog("warn", `[horizon_v8] raw messages dump failed: ${e?.message || e}`);
  }
}

export function formatMessages(messages: any[], systemPrompt: string | undefined, tools: any[], runtimeBlock?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`System: ${systemPrompt}`);
  const toolDefs = formatToolDefinitions(tools);
  if (toolDefs) parts.push(toolDefs);
  if (runtimeBlock) parts.push(runtimeBlock);
  for (const f of EXTRA_SYSTEM_FILES) {
    try {
      const content = readFileSync(f, "utf8").trim();
      if (content) parts.push(content);
    } catch (e: any) {
      mylog("warn", `[horizon_v8] cannot read extra system file ${f}: ${e?.message || e}`);
    }
  }
  // Восстановление истории при потере сессии (до цикла сообщений)
  let restoredLines: string[] | null = null;
  const blockMsgIdx = RESTORE_HISTORY ? findRuntimeContextUserIndex(messages) : -1;
  const blockMsg = blockMsgIdx !== -1 ? (messages[blockMsgIdx] as any) : null;
  if (RESTORE_HISTORY && blockMsg) {
    const prior = countMeaningfulPriorMessages(messages, blockMsgIdx);
    const blockContent = normalizeMessageContent(blockMsg.content);
    const entries = parseChatWindowHistoryEntries(blockContent);
    if (prior <= 1 && entries.length > 2) {
      restoredLines = chatWindowEntriesToRoleLines(entries);
      mylog("info", `[horizon_v8] session history lost (prior=${prior}, block=${entries.length}) → restored ${restoredLines.length} lines; Conversation info marked`);
    }
  }
  if (restoredLines && restoredLines.length > 0) parts.push(...restoredLines);

  // Компакт ядра: после сводки вся прежняя история неактуальна (истина в
  // сводке), поэтому в промпт идёт СВОДКА + только последние сообщения
  // текущего диалога, а не весь массив historyMessages. Без этого блок
  // компакта вообще не попадал в промпт: роль "compactionSummary" не
  // совпадала ни с одной веткой цикла и молча пропускалась.
  const summaryMsgs = messages.filter(isSummaryRole);
  const hasSummary = summaryMsgs.length > 0;
  if (hasSummary) {
    for (const sm of summaryMsgs) {
      const body = summaryText(sm);
      if (body) parts.push(`Compaction summary (earlier conversation, context only):\n${body}`);
    }
  }
  const loopMessages = hasSummary
    ? trimIncompleteTail(messages.filter((m: any) => !isSummaryRole(m)))
    : messages;
  // Пояснение к хвосту: после сводки идёт продолжение диалога — ответ на
  // последний показанный в сводке запрос и последующие ходы, которые в
  // сводку не попали. Без этого «висячие» ответы/вызовы после сводки
  // выглядят необъяснимо.
  if (hasSummary && loopMessages.length > 0) {
    parts.push("Continuation after the summary — reply to the last request above and the subsequent turns that were not included in the summary:");
  }

  let restoreMarkDone = false;
  for (const msg of loopMessages) {
    const m = msg as any;
    const role = m.role;
    let content = normalizeMessageContent(m.content);
    if (role === "user") {
      if ((STRIP_CHAT_WINDOW || RESTORE_HISTORY) && includesAny(content, RUNTIME_CONTEXT_MARKERS)) {
        content = stripChatWindowFromRuntimeContext(content);
      }
      // Внутренние маркеры/метаданные ядра чистятся у ЛЮБОГО user-сообщения:
      // [[OPENCLAW_INTERNAL_CONTEXT_BEGIN]] и подобное утекают и вне runtime-блока
      // (дубль истории при восстановлении/шаринге контекста), поэтому прежняя
      // привязка к RUNTIME_CONTEXT_MARKERS пропускала такие хвосты.
      content = cleanOpenClawMetadata(content);
      if (restoredLines && restoredLines.length > 0 && !restoreMarkDone && m === blockMsg) {
        content = markRestoredInConversationInfo(content);
        restoreMarkDone = true;
      }
      if (content.trim()) parts.push(`User: ${content}`);
    }
    else if (role === "assistant") {
      if (m.content && Array.isArray(m.content)) {
        const toolCalls: any[] = [];
        const texts: string[] = [];
        for (const block of m.content) {
          if (block.type === "toolCall") { toolCalls.push(block); }
          else if (block.type === "text") { texts.push(block.text); }
        }
        if (texts.length > 0) parts.push(`Assistant: ${texts.join("\n")}`);
        for (const tc of toolCalls) {
          parts.push(`Assistant: TOOL_CALL: ${tc.name}\narguments: ${JSON.stringify(tc.arguments)}`);
        }
      } else if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.function) parts.push(`Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}`);
        }
      } else if (content) {
        parts.push(`Assistant: ${content}`);
      }
    } else if (role === "toolResult") {
      const toolName = m.toolName || "unknown";
      parts.push(`Observation (${toolName}): ${truncateObservation(toolName, content)}`);
    } else if (role === "tool") {
      const toolName = m.name || m.toolName || "unknown";
      parts.push(`Observation (${toolName}): ${truncateObservation(toolName, content)}`);
    }
  }
  // Финальная страховка: что бы ни просочилось из любой роли/восстановленной
  // истории, вырезаем маркеры и осиротевшие пустые строки "User:"/"Assistant:".
  let prompt = stripInternalContextMarkers(parts.join("\n"));
  prompt = prompt.replace(/^[ \t]*(?:User|Assistant):[ \t]*$/gm, '');
  return prompt.replace(/\n{3,}/g, "\n\n");
}

// Minimal follow-up: tail of the conversation starting from the last user
// message (inclusive), without System/tools/runtime/extra system files/date.
// Used on repeat turns where DeepSeek Web already holds the prior context
// server-side (chat_session_id + parent_message_id).
export function formatLastTurn(messages: any[]): string {
  // Boundary: normally the tail starts at the last user message, but when a
  // tool round-trip follows it, that user turn was already sent upstream on a
  // previous request. Resending it duplicates the question, so start at the
  // last tool result instead (ping-pong: User -> tool call -> Observation -> ...).
  // Newest user turn, if any (used for the fallback branch below).
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any)?.role === "user") { lastUserIdx = i; break; }
  }

  // Contiguous run of tool results at the very tail of the log. Parallel tool
  // calls produce several toolResult messages in a row (one per toolCallId),
  // and ALL of them are this round observations. Taking only the newest one
  // silently dropped its siblings.
  const isToolMsg = (m: any) => m?.role === "toolResult" || m?.role === "tool";
  // Trailing standalone runtime-context carriers are user messages with no
  // real text. They sit AFTER this round's tool results, so they must not
  // terminate the tool-run scan.
  const isCarrierOnlyUser = (m: any) => {
    if (m?.role !== "user") return false;
    const probe = stripOpenClawContextBlock(normalizeMessageContent(m.content))
      .replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\n{3,}/g, "\n\n").trim();
    return !probe;
  };
  let tailEnd = messages.length - 1;
  while (tailEnd >= 0 && isCarrierOnlyUser(messages[tailEnd])) tailEnd--;
  let firstToolIdx = -1;
  for (let i = tailEnd; i >= 0; i--) {
    if (isToolMsg(messages[i])) firstToolIdx = i;
    else break;
  }

  // The newest user message may be a standalone runtime-context carrier
  // (pure BEGIN..END envelope). Scan backwards for the last user message
  // whose envelope-stripped content is non-empty — that is the real turn.
  let effectiveUserIdx = lastUserIdx;
  for (let i = lastUserIdx; i >= 0; i--) {
    const mu = messages[i] as any;
    if (mu?.role !== "user") continue;
    const probe = stripOpenClawContextBlock(normalizeMessageContent(mu.content))
      .replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\n{3,}/g, "\n\n").trim();
    if (probe) { effectiveUserIdx = i; break; }
  }
  if (effectiveUserIdx !== lastUserIdx) {
    mylog("info", `[horizon_v8] tail user effUserIdx=${effectiveUserIdx} lastUserIdx=${lastUserIdx}`);
  }
  const tailIsObservation = firstToolIdx !== -1 && firstToolIdx > effectiveUserIdx;

  // Cross-check by toolCallId: expected ids are the tool calls of the nearest
  // preceding assistant message; seen ids are the results in this tail run.
  // A mismatch means the round is incomplete or a foreign result leaked in.
  try {
    const branch = tailIsObservation ? "observation" : (lastUserIdx !== -1 ? "user" : "empty");
    mylog("info", `[horizon_v8] tail branch=${branch} firstToolIdx=${firstToolIdx} lastUserIdx=${lastUserIdx} effUserIdx=${effectiveUserIdx} tailEnd=${tailEnd} total=${messages.length}`);
    if (tailIsObservation) {
      const expectedIds: string[] = [];
      for (let i = firstToolIdx - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === "toolCall" && b.id) expectedIds.push(String(b.id));
          }
          break;
        }
      }
      const seenIds: string[] = [];
      for (const msg of messages.slice(firstToolIdx, tailEnd + 1)) {
        const id = (msg as any)?.toolCallId;
        if (id) seenIds.push(String(id));
      }
      const unmatched = seenIds.filter((id) => !expectedIds.includes(id));
      const unanswered = expectedIds.filter((id) => !seenIds.includes(id));
      mylog("info", `[horizon_v8] tail obs round calls=${expectedIds.length} results=${seenIds.length} unmatched=${unmatched.length} unanswered=${unanswered.length}`);
      if (unmatched.length) mylog("info", `[horizon_v8] tail WARN unmatched toolCallIds: ${unmatched.join(",")}`);
      if (unanswered.length) mylog("info", `[horizon_v8] tail WARN unanswered toolCallIds: ${unanswered.join(",")}`);
    }
  } catch (e: any) { /* diagnostics must never break the turn */ }

  // Observation-only branch: the tail of the log is a tool round-trip, so the
  // minimal prompt is every Observation of this round, in order. The user turn
  // and the assistant tool call already went upstream on a previous request.
  if (tailIsObservation) {
    const obsParts: string[] = [];
    for (const msg of messages.slice(firstToolIdx)) {
      const m = msg as any;
      const role = m.role;
      const content = normalizeMessageContent(m.content);
      if (role === "toolResult") {
        const toolName = m.toolName || "unknown";
        obsParts.push(`Observation (${toolName}): ${truncateObservation(toolName, content)}`);
      } else if (role === "tool") {
        const toolName = m.name || m.toolName || "unknown";
        obsParts.push(`Observation (${toolName}): ${truncateObservation(toolName, content)}`);
      }
    }
    const obs = sanitizeMinimalTail(obsParts.join("\n"));
    if (obs) return obs;
  }
  if (effectiveUserIdx === -1) return "";
  const parts: string[] = [];
  for (const msg of messages.slice(effectiveUserIdx)) {
    const m = msg as any;
    const role = m.role;
    let content = normalizeMessageContent(m.content);
    if (role === "user") {
      // Full strip of the OpenClaw runtime context (BEGIN..END block, escaped
      // variants, orphaned markers, leftover metadata headers), then the
      // leading date token "[Fri ... GMT+3]". Task 2.3: no date in the tail.
      // Sanitize the tail only. No fallback that could reintroduce raw
      // markers: if the stripped result is empty, the minimal tail stays empty
      // and the turn goes full (see useMinimal in stream.ts).
      let out = stripOpenClawContextBlock(content);
      out = out.replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\n{3,}/g, "\n\n").trim();
      // В web-чате DeepSeek user-turn идёт без маркера "User:": это и так
      // понятно из позиции (весь промпт = текущий user-turn). Оставляем
      // только сам текст.
      if (out.trim()) parts.push(out);
    } else if (role === "assistant") {
      if (m.content && Array.isArray(m.content)) {
        const toolCalls: any[] = [];
        const texts: string[] = [];
        for (const block of m.content) {
          if (block.type === "toolCall") { toolCalls.push(block); }
          else if (block.type === "text") { texts.push(block.text); }
        }
        if (texts.length > 0) parts.push(`Assistant: ${texts.join("\n")}`);
        for (const tc of toolCalls) {
          parts.push(`Assistant: TOOL_CALL: ${tc.name}\narguments: ${JSON.stringify(tc.arguments)}`);
        }
      } else if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (tc.function) parts.push(`Assistant: TOOL_CALL: ${tc.function.name}\narguments: ${tc.function.arguments}`);
        }
      } else if (content) {
        parts.push(`Assistant: ${content}`);
      }
    } else if (role === "toolResult") {
      const toolName = m.toolName || "unknown";
      parts.push(`Observation (${toolName}): ${truncateObservation(toolName, content)}`);
    } else if (role === "tool") {
      const toolName = m.name || m.toolName || "unknown";
      parts.push(`Observation (${toolName}): ${truncateObservation(toolName, content)}`);
    }
  }
  let prompt = stripInternalContextMarkers(parts.join("\n"));
  prompt = prompt.replace(/^[ \t]*(?:User|Assistant):[ \t]*$/gm, '');
  return sanitizeMinimalTail(prompt);
}

// ==== tool parity helpers (ported from FreeDeepseekAPI/server.js) ====
const MIN_UPSTREAM_PROMPT_CHARS = 16000;
export const MAX_UPSTREAM_PROMPT_CHARS = (() => {
  const configured = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
  return Number.isFinite(configured) ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configured)) : 40000;
})();

const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'title', 'examples', 'example', '$comment', 'deprecated', 'readOnly', 'writeOnly']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set(['additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if', 'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties']);

function compactToolSchema(value: any): any {
  if (Array.isArray(value)) return value.map(compactToolSchema);
  if (!value || typeof value !== 'object') return value;
  const compact: any = {};
  for (const [key, child] of Object.entries(value)) {
    if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
      compact[key] = Object.fromEntries(Object.entries(child as any).map(([n, sch]) => [n, compactToolSchema(sch)]));
    } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
      compact[key] = child.map(compactToolSchema);
    } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
      compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
    } else {
      compact[key] = child;
    }
  }
  return compact;
}

function formatToolDefinitions(tools: any): string {
  if (!tools || !Array.isArray(tools) || tools.length === 0) return '';
  const rawSchemaChars = tools.reduce((total: number, tool: any) => {
    try { const t: any = (tool && tool.function) ? tool.function : tool; return total + JSON.stringify(t?.parameters || {}).length; } catch (e) { return total; }
  }, 0);
  const compactSchemas = rawSchemaChars > Math.floor(MAX_UPSTREAM_PROMPT_CHARS * 0.4);
  // Fix 2026-10-11 (A): легаси-обвязку "TOOL REQUEST SYSTEM" убрали (clean prompt).
  // Оставляем только то, что нужно модели: формат вызова + схемы функций.
  // Убрано: "ONLY REASONS / you never run commands", блок RULES, "gateway" —
  // именно этот фрейминг заставлял модель выдавать протокол вместо живого ответа.
  let text = '\n\nИнструменты доступны через строгий JSON-вызов:\n';
  text += '{"tool_call":{"name":"<function_name>","arguments":{...}}}\n';
  text += 'Legacy: TOOL_CALL: <function_name>\narguments: <JSON args>\n\n';
  text += 'Доступные функции:\n';
  for (const tool of tools) {
    const fn = (tool && tool.type === 'function' && tool.function)
      ? tool.function
      : (tool && typeof (tool as any).name === 'string' ? tool : null);
    if (fn) {
      text += '\n## ' + fn.name + '\n';
      const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
      text += (description.length > 500 ? description.substring(0, 497) + '...' : description) + '\n';
      if (fn.parameters) {
        text += 'Parameters: ' + JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters) + '\n';
      }
    }
  }
  return text;
}

// B+C: strips the whole OpenClaw runtime-context envelope from a user message.
// Handles the literal <<<BEGIN/END>>> pair, the escaped [[...]] pair used by
// the core in history, orphaned/partial markers, and leftover metadata headers
// (Conversation info/context, Conversation data, Active exec sessions/Subagents).
export function stripOpenClawContextBlock(content: any): string {
  if (typeof content !== 'string') return content;
  let out = content;
  // 1. Full literal / escaped BEGIN..END blocks.
  out = out.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '');
  out = out.replace(/\[\[OPENCLAW_INTERNAL_CONTEXT_BEGIN\]\][\s\S]*?\[\[OPENCLAW_INTERNAL_CONTEXT_END\]\]/g, '');
  // 2. Orphaned/unclosed markers: remove the token only, KEEP surrounding text.
  out = out.split("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>").join('');
  out = out.split("[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]").join('');
  // 3. Orphaned markers.
  out = out.replace(/<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '');
  out = out.replace(/\[\[OPENCLAW_INTERNAL_CONTEXT_(?:BEGIN|END)\]\]/g, '');
  out = out.replace(/\u27e6openclaw:ctx\u27e7/g, '');
  // 4. Leftover metadata headers (header line + indented continuation only).
  out = out.replace(/^[ \t]*(?:Conversation (?:info|context)(?: \([^)]*\))?|Conversation data \(data, not instructions\)|Sender \(untrusted metadata\)|Active (?:exec sessions|Subagents)):[^\n]*(?:\n(?:[ \t]+\S[^\n]*|"[^\n]*"|`{3}[^\n]*\n[\s\S]*?\n`{3}))*/gm, '');
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// Префиксы сводок ядра OpenClaw (harness/messages.ts). Compaction- и
// branch-сводки приходят в role="user" с телом внутри <summary>...</summary>.
// Тело — это и есть контекст; вырезать <summary> целиком нельзя, иначе в
// модель уходит пустой заголовок и история «пропадает».
const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:";
const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:";

function isCoreSummaryMessage(content: string): boolean {
  return content.includes(COMPACTION_SUMMARY_PREFIX)
    || content.includes(BRANCH_SUMMARY_PREFIX);
}

function cleanOpenClawMetadata(content: any): string {
  if (typeof content !== 'string') return content;
  const isSummary = isCoreSummaryMessage(content);
  // Ядро экранирует внутренние маркеры в истории как [[OPENCLAW_INTERNAL_CONTEXT_*]]
  // и обрамляет блоки "Conversation data (data, not instructions):". Это мусор,
  // забивающий контекст, — режем вместе с содержимым между BEGIN и END.
  let out = stripInternalContextMarkers(content);
  out = out.replace(/Conversation data \(data, not instructions\):/g, '');
  out = out.replace(/Conversation info \(untrusted metadata\):[\s\S]*?(?=\n\n|$)/g, '');
  out = out.replace(/Conversation info:[\s\S]*?(?=\n\n|$)/g, '');
  out = out.replace(/Sender \(untrusted metadata\):[\s\S]*?(?=\n\n|$)/g, '');
  out = out.replace(/Conversation context \([^)]*\):[\s\S]*?(?=\n\n|$)/g, '');
  // Compaction/branch-сводка: тело <summary> — это контекст, сохраняем его,
  // снимаем только сами теги. Иначе <summary> — служебный мусор, вырезаем.
  out = isSummary
    ? out.replace(/<\/?summary>/g, '')
    : out.replace(/<summary>[\s\S]*?<\/summary>/g, '');
  out = out.replace(/\n?\[Context compacted by [^\]]*\]\n?/g, '\n');
  // Осиротевшие экранированные маркеры (ядро подменяет <<<BEGIN/END>>> на [[...]]
  // в истории). Сюда попадают и пустые пары BEGIN/END без содержимого.
  out = out.replace(/[ \t]*\[\[OPENCLAW_INTERNAL_CONTEXT_(?:BEGIN|END)\]\][ \t]*/g, ' ');
  // Схлопываем пробельные хвосты построчно ("User:" без тела в parts не попадёт).
  out = out.replace(/[ \t]+$/gm, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Срединная обрезка промпта УДАЛЕНА (2026-09-22). Функция `truncatePromptMiddle`
// с 2026-09-16 была no-op (возвращала текст как есть), а вместе с ней осиротели
// её обёртки из FreeDeepseekAPI/server.js — `buildRecoveryHistoryPrefix`,
// `buildBoundedPrompt`, `appendPromptInstruction`, `buildRetryPrompt`.
// Ни одну из них никто не вызывал (проверено grep по src/tests 2026-09-22),
// а сама идея «резать промпт посередине» искажала инструменты и сообщения —
// лимит `MAX_UPSTREAM_PROMPT_CHARS` остался только как порог компактизации
// tool-схем в `formatToolDefinitions`. Длинный контекст теперь ограничивает
// смарт-компакт ядра и ротация web-сессии, а не обрезка промпта.

export function extractChatId(messages: any[]): string {
  for (const m of [...(messages as any[])].reverse()) {
    if (!m) continue;
    const c = normalizeMessageContent((m as any).content);
    if (!c) continue;
    // ctx blocks embed JSON with backslash-escaped quotes: {"chat_id":"..."}
    const norm = c.replace(/\\"/g, '"');
    const mm = norm.match(/"chat_id"\s*:\s*"([^"]+)"/);
    if (mm) return mm[1];
  }
  return "";
}

// ---------------------------------------------------------------------------
// Final safety net for the minimal follow-up tail
// (change horizon-v8-minimal-followup, req. 1.2/1.3/1.4).
// Whatever leaked from any role, the tail MUST NOT contain OpenClaw internal
// context markers (literal or escaped, closed or unclosed) nor leftover
// metadata headers with their indented bodies.
// ---------------------------------------------------------------------------
// Маркеры собираются из частей намеренно: литеральный токен в исходнике
// неотличим от runtime-конверта и вырезается инструментами, поэтому клеим.

const OC_BEGIN = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
const OC_END = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
const OC_ESC_BEGIN = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]";
const OC_ESC_END = "[[OPENCLAW_INTERNAL_CONTEXT_END]]";

function cutMarkerBlock(text: string, begin: string, end: string): string {
  let out = text;
  for (;;) {
    const i = out.indexOf(begin);
    if (i < 0) return out;
    const j = out.indexOf(end, i + begin.length);
    // Unclosed marker: drop the rest of the message — nothing after it belongs
    // to the user-visible tail.
    out = j < 0 ? out.slice(0, i) : out.slice(0, i) + out.slice(j + end.length);
  }
}

export function sanitizeMinimalTail(input: string): string {
  let out = String(input || "");
  out = cutMarkerBlock(out, OC_ESC_BEGIN, OC_ESC_END);
  out = cutMarkerBlock(out, OC_BEGIN, OC_END);
  for (const m of [OC_BEGIN, OC_END, OC_ESC_BEGIN, OC_ESC_END, "\u27e6openclaw:ctx\u27e7"]) {
    out = out.split(m).join("");
  }
  // Metadata headers plus their indented continuation lines.
  out = out.replace(
    /^[ \t]*(?:Conversation (?:info|context)(?: \([^)]*\))?|Conversation data \(data, not instructions\)|Sender \(untrusted metadata\)|Active (?:exec sessions|Subagents)):[^\n]*(?:\n(?:[ \t]+\S[^\n]*|"[^\n]*"))*/gm,
    "",
  );
  // Leading fenced JSON block that carries ONLY OpenClaw metadata (the sender
  // envelope / chat_id / message_id). Strip it together with its fences.
  // A genuine user code sample (unknown keys) must survive.
  // Both plain text (real newlines) and double-encoded text (literal \n and
  // \" sequences) are handled.
  out = out.replace(
    /^[ \t]*```[ \t]*(?:json)?[ \t]*(?:\\r)?(?:\\n|\r?\n)([\s\S]*?)(?:\\r)?(?:\\n|\r?\n)[ \t]*```[ \t]*(?:(?:\\r)?(?:\\n|\r?\n))*/i,
    (m: string, body: string): string => {
      const b = String(body)
        .replace(/\\"/g, '"')
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .trim();
      if (!b.startsWith("{")) return m;
      const META_KEYS = ["sender", "chat_id", "message_id", "username", "is_bot", "timestamp", "inbound_event_kind", "explicitly_mentioned_bot"];
      try {
        const o = JSON.parse(b);
        const meta = Object.keys(o).some((k) => META_KEYS.indexOf(k) !== -1) || (o && typeof o.sender === "object");
        return meta ? "" : m;
      } catch {
        return /"(?:sender|chat_id|message_id)"\s*:/.test(b) ? "" : m;
      }
    },
  );

  // Fallback: the anchored regex above misses some host variants (metadata
  // lines before the fence, stray whitespace, literal \\n form). Strip a
  // leading fenced JSON block whose body is OpenClaw metadata, wherever it
  // sits near the start of the tail.
  try {
    const probe = out.replace(/\r/g, "");
    const fenceIdx = probe.indexOf("```");
    if (fenceIdx >= 0 && fenceIdx < 200) {
      const before = probe.slice(0, fenceIdx);
      const beforeIsNoise = before.split("\n").every((ln) => {
        const t = ln.trim();
        return !t || /^(?:Conversation (?:info|context)|Conversation data|Sender \(|Active (?:exec|Subagents)|\[[^\]]*GMT)/.test(t);
      });
      if (beforeIsNoise) {
        const afterOpen = probe.slice(fenceIdx + 3).replace(/^[ \t]*(?:json)?[ \t]*\n?/i, "");
        const closeIdx = afterOpen.indexOf("```");
        if (closeIdx >= 0) {
          const body = afterOpen.slice(0, closeIdx)
            .replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\r/g, "\r").trim();
          const isMeta =
            /"(?:sender|chat_id|message_id|username|is_bot|timestamp|inbound_event_kind|explicitly_mentioned_bot)"\s*:/.test(body) ||
            (body.startsWith("{") && /"sender"\s*:/.test(body));
          if (isMeta) {
            out = afterOpen.slice(closeIdx + 3).replace(/^[ \t]*\n?/, "");
          }
        }
      }
    }
  } catch {}

  // Leading "[<date> GMT+..]" token (only at the very start of the tail).
  out = out.replace(/^\s*\[[^\]\n]*GMT[^\]\n]*\][ \t]*/, "");
  out = out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

export function cleanMinimalPrompt(p: string): string {
  let out = p;
  out = out.replace(/(^|\n)\s*(User|Assistant):\s*\[[^\]]*GMT[^\]]*\]\s*\n*/g, "$1$2: ");
  out = out.replace(/(^|\n)\s*\[[^\]]*GMT[^\]]*\]\s*\n+/g, "$1");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}
