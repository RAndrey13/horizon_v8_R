// ---------------------------------------------------------------------------
// DeepSeek Web client: throttle, parent id, completion + envelope checks
// ---------------------------------------------------------------------------

import { writeFileSync, appendFileSync } from "node:fs";
import type { Account, SessionState } from "./types.js";
import { solveFreshPow as solveFreshPowImpl, solvePOW } from "./pow.js";
import { tokenLimit, shouldCompactForLimit, requestCoreCompaction } from "./registry.js";
import { markAccountFailure, markAccountSuccess, resetWebSession } from "./accounts.js";
import { mylog } from "./logger.js";

// ---------------------------------------------------------------------------
// Throttle + per-agent session key
// ---------------------------------------------------------------------------
// Throttle between upstream requests
// ---------------------------------------------------------------------------
// DeepSeek Web answers 502 when an agent fires turns back-to-back, so every
// request waits until a random gap has elapsed since the previous one. The
// jitter (instead of a fixed pause) also keeps the traffic from looking
// machine-regular.
//   HORIZON_THROTTLE_MIN_MS (default 2000) — lower bound of the random gap
//   HORIZON_THROTTLE_MAX_MS (default 5000) — upper bound of the random gap
//   HORIZON_THROTTLE_MS — fixed gap, overrides min/max; 0 disables the pause
const THROTTLE_MIN_MS = (() => {
  const v = Number(process.env.HORIZON_THROTTLE_MIN_MS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2000;
})();
const THROTTLE_MAX_MS = (() => {
  const v = Number(process.env.HORIZON_THROTTLE_MAX_MS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 5000;
})();
const THROTTLE_FIXED_MS = (() => {
  const v = Number(process.env.HORIZON_THROTTLE_MS);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
})();
/**
 * Gap to honor before the next request. A fixed HORIZON_THROTTLE_MS wins;
 * otherwise the value is re-randomized on every call in [MIN, MAX].
 */
function nextThrottleMs(): number {
  if (THROTTLE_FIXED_MS !== null) return THROTTLE_FIXED_MS;
  const lo = Math.min(THROTTLE_MIN_MS, THROTTLE_MAX_MS);
  const hi = Math.max(THROTTLE_MIN_MS, THROTTLE_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Retry policy. RETRY_ATTEMPTS is the number of completion attempts per
// ACCOUNT before the account is marked failed and the next one is tried. The
// pause between attempts is the SAME random gap used before a request
// (nextThrottleMs, 2–5 s by default), so retries and account switches are
// spaced like normal traffic and do not hammer the edge.
const RETRY_ATTEMPTS = 3;

/**
 * Records a failure on the session so stream.ts persists it to state.json:
 * lastError / lastErrorAt / failedSessionId (the id that went bad).
 */
export function markSessionFailed(session: SessionState, msg: string): void {
  session.lastError = String(msg || "unknown error").slice(0, 300);
  session.lastErrorAt = Date.now();
  session.failedSessionId = session.id;
}

/**
 * True when the failure means the web session id itself is unusable
 * (DeepSeek: "invalid chat session id", HTTP 400/404/422). Such a session
 * cannot be continued and MUST be rotated; every other failure is treated as
 * recoverable in place (change horizon-v8-no-fork-on-error).
 */
export function isDeadSessionError(msg: string): boolean {
  const m = String(msg || "").toLowerCase();
  return m.includes("invalid chat session")
    || m.includes("session not found")
    || /\bhttp (400|404|422)\b/.test(m);
}

/**
 * True when a buffered DeepSeek SSE body actually carries a completion. The
 * answer arrives as JSON-Patch events over `response/fragments` /
 * `.../content`, and the token counter as `.../accumulated_token_usage`; a body
 * with none of those markers (or only `[DONE]`) is an empty stream — a WAF /
 * rate-limit stub — not an assistant reply.
 */
function sseBodyHasContent(body: string): boolean {
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    if (/fragments|content|accumulated_token_usage/.test(payload)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// DeepSeek Web API call
// ---------------------------------------------------------------------------

// DeepSeek expects parent_message_id as a NUMBER (u32). Sending the id as a
// string makes the API answer HTTP 422:
//   parent_message_id: invalid type: string "2", expected u32
// The caller then treats it as an invalid session and recreates the web
// session, so every DeepSeek chat lived exactly one exchange.
function parentIdForRequest(session: { parentMessageId: string | number | null }): number | null {
  const raw = session.parentMessageId;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export async function callDeepSeekWeb(
  prompt: string,
  session: SessionState,
  account: Account,
  modelType: string,
  thinkingEnabled: boolean,
  searchEnabled: boolean,
  refFileIds: string[] = [],
  fullPrompt?: string,
  failover?: { accounts: Account[]; persist: () => void },
): Promise<Response> {
  // Mutable per-account context: the helpers below close over these bindings,
  // so switching the account before a retry round makes every subsequent
  // request use the new account's headers and PoW wasm URL.
  let activeAccount = account;
  let dsHeaders = account.headers;

  // 0. Full-cycle dump (opt-in via HORIZON_REQUEST_LOG): the log is REWRITTEN
  // on the user turn and the tool round-trips of the same cycle are APPENDED,
  // so the whole question -> tool -> observation -> answer sequence is one
  // block. Disabled by default - there is no default path, so nothing is
  // written unless the operator asks for it.
  try {
    const logPath = (process.env.HORIZON_REQUEST_LOG || "").trim();
    if (logPath) {
      const mode = (fullPrompt !== undefined && fullPrompt === prompt) ? "full" : "minimal";
      const ts = new Date().toISOString();
      const isToolTurn = /^Observation \(/.test(prompt);
      const line = JSON.stringify({ ts, chatSessionId: session.id, modelType, mode, parentMessageId: parentIdForRequest(session), thinking_enabled: thinkingEnabled, search_enabled: searchEnabled, action: null, preempt: false, ref_file_ids: refFileIds, len: prompt.length, fullLen: (fullPrompt ?? prompt).length, prompt }, null, 2) + "\n";
      if (isToolTurn) appendFileSync(logPath, line, "utf-8");
      else writeFileSync(logPath, line, "utf-8");
    }
  } catch (e) {
    // logging must never break the request
  }

  // Throttle: DeepSeek Web returns 502 when requests are sent back-to-back.
  // Variant A — always pause a fresh random gap before every request
  // (default 2–5 s), regardless of how long the previous turn took.
  const throttleMs = nextThrottleMs();
  if (throttleMs > 0) {
    await new Promise((r) => setTimeout(r, throttleMs));
  }

  // 1. PoW challenge. A solved PoW is single-use: replaying the same
  // X-DS-PoW-Response header makes DeepSeek answer HTTP 200 with
  //   {"code":40301,"msg":"INVALID_POW_RESPONSE","data":null}
  // so every attempt below asks for a fresh challenge instead of reusing one.
  const solveFreshPow = (): Promise<string> => solveFreshPowImpl(dsHeaders, activeAccount.config.wasmUrl || "");

  // 2. Create the web session for the CURRENT account if there is none. Called
  // at the start of every account round: an account switch resets the session,
  // so each account gets its own chat.
  const ensureSession = async (): Promise<void> => {
    if (session.id) return;
    const sr = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
      method: "POST", headers: dsHeaders, body: "{}",
    });
    const srText = await sr.text();
    let srJson: any;
    try { srJson = JSON.parse(srText); } catch {}
    const createdId = srJson?.data?.biz_data?.chat_session?.id || srJson?.data?.biz_data?.id;
    if (!sr.ok || !createdId) throw new Error(`Session create: HTTP ${sr.status}`);
    session.id = createdId;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
  };

  // 3. Completion helpers.
  /** One completion POST on the current web session with a fresh PoW. */
  const sendCompletion = async (promptToSend: string): Promise<Response> => {
    const powB64 = await solveFreshPow();
    return await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
      method: "POST",
      headers: { ...dsHeaders, "X-DS-PoW-Response": powB64 },
      body: JSON.stringify({
        chat_session_id: session.id,
        parent_message_id: parentIdForRequest(session),
        model_type: modelType,
        prompt: promptToSend, ref_file_ids: refFileIds,
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        action: null, preempt: false,
      }),
    });
  };

  type Verdict =
    | { kind: "ok"; resp: Response }
    | { kind: "retry"; reason: string }
    | { kind: "fatal"; error: Error };

  /**
   * HTTP 200 is not success by itself: DeepSeek reports failures inside the JSON
   * envelope while the status stays 200, e.g.
   *   {"code":0,"msg":"","data":{"biz_code":1,"biz_msg":"invalid chat session id","biz_data":null}}
   * Such a body is not assistant content and must never be streamed as a reply.
   */
  const classify = async (r: Response): Promise<Verdict> => {
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) {
      // HTTP 200 with an empty/aborted SSE stream carries no completion at all:
      // DeepSeek's edge occasionally answers that way (WAF/rate-limit stub), and
      // the SSE reader downstream would "succeed" with zero content, which
      // upstream turns into a silent empty answer ("settled post-tool turn
      // lacked a final answer"). Buffer a CLONE here and treat an event-less
      // body as a retryable failure; the original response stays unread for the
      // caller.
      let body = "";
      try { body = await r.clone().text(); } catch { return { kind: "retry", reason: "SSE body unreadable" }; }
      if (!sseBodyHasContent(body)) return { kind: "retry", reason: "empty SSE stream (no content events)" };
      return { kind: "ok", resp: r };
    }
    let raw = "";
    try { raw = await r.clone().text(); } catch { return { kind: "retry", reason: "response body unreadable" }; }
    // HTTP 200 with a blank body is not a completion either.
    if (!raw.trim()) return { kind: "retry", reason: "empty response body" };
    let parsed: any;
    try { parsed = JSON.parse(raw); }
    catch {
      // Non-JSON body that is not SSE: an HTML login/WAF page instead of the
      // API envelope. Never let it be treated as a completion.
      if (raw.trimStart().startsWith("<")) {
        return { kind: "fatal", error: new Error(`DeepSeek: HTML response instead of API (ct=${ct || "none"})`) };
      }
      return { kind: "ok", resp: r };
    }
    const bizCode = parsed?.data?.biz_code ?? parsed?.biz_code;
    const topCode = typeof parsed?.code === "number" ? parsed.code : 0;
    const bizMsg = parsed?.data?.biz_msg ?? parsed?.biz_msg ?? parsed?.msg ?? "";
    const failed = (typeof bizCode === "number" && bizCode !== 0) || topCode !== 0;
    if (!failed) return { kind: "ok", resp: r };
    return { kind: "retry", reason: `code=${topCode} biz_code=${bizCode} ${bizMsg}`.trim() };
  };

  /**
   * Up to RETRY_ATTEMPTS attempts on the SAME web session, a random throttle
   * gap apart (nextThrottleMs, 2–5 s by default).
   * Invalid session (400/404/422), biz_code != 0, rejected PoW and transient
   * 5xx all count as a failed attempt. Throws once every attempt is used up.
   */
  const completeOnSameSession = async (promptToSend: string): Promise<Response> => {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        const wait = nextThrottleMs();
        await new Promise((r) => setTimeout(r, wait));
        mylog("warn", `[horizon_v8] retry ${attempt}/${RETRY_ATTEMPTS} on web session ${session.id} (account ${activeAccount.name}, ${wait}ms pause): ${lastErr?.message}`);
      }
      let r: Response;
      try {
        r = await sendCompletion(promptToSend);
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        continue;
      }
      if (r.status === 400 || r.status === 404 || r.status === 422) {
        let body = "";
        try { body = (await r.text()).slice(0, 300); } catch {}
        // Dead web-session id (invalid chat session): retrying the SAME id would
        // fail identically. Fail fast so the caller recreates at once instead of
        // burning RETRY_ATTEMPTS on a doomed session.
        throw new Error(`HTTP ${r.status} ${body}`.trim());
      }
      if (r.status === 500 || r.status === 502 || r.status === 503 || r.status === 504) {
        let body = "";
        try { body = (await r.text()).slice(0, 300); } catch {}
        lastErr = new Error(`HTTP ${r.status} ${body}`.trim());
        continue;
      }
      if (r.status !== 200) {
        let body = "";
        try { body = (await r.text()).slice(0, 800); } catch {}
        throw new Error(`DeepSeek: HTTP ${r.status} ${body}`);
      }
      const verdict = await classify(r);
      if (verdict.kind === "ok") return verdict.resp;
      if (verdict.kind === "fatal") throw verdict.error;
      lastErr = new Error(verdict.reason);
    }
    throw lastErr ?? new Error("DeepSeek: completion failed");
  };

  /**
   * Recreates the web session and sends the FULL prompt into it: a brand-new
   * chat has no prior context, so the minimal follow-up tail would be useless.
   * The id that failed stays recorded in session.failedSessionId.
   */
  const recreateSessionAndRetry = async (): Promise<Response> => {
    session.id = null; session.parentMessageId = null; session.createdAt = null; session.messageCount = 0;
    const sr2 = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
      method: "POST", headers: dsHeaders, body: "{}",
    });
    const sr2Text = await sr2.text();
    let sr2Json: any;
    try { sr2Json = JSON.parse(sr2Text); } catch {}
    const createdId2 = sr2Json?.data?.biz_data?.chat_session?.id || sr2Json?.data?.biz_data?.id;
    if (!sr2.ok || !createdId2) throw new Error(`Session recreate: HTTP ${sr2.status}`);
    const prev = session.failedSessionId ?? "-";
    session.id = createdId2; session.parentMessageId = null; session.createdAt = Date.now(); session.messageCount = 0;
    mylog("info", `[horizon_v8] recreated web session ${prev} -> ${createdId2} (full prompt)`);
    const r2 = await sendCompletion(fullPrompt ?? prompt);
    if (r2.status !== 200) { let c = ""; try { c = (await r2.text()).slice(0, 800); } catch {} throw new Error(`DeepSeek: HTTP ${r2.status} ${c}`); }
    const v2 = await classify(r2);
    if (v2.kind === "fatal") throw v2.error;
    if (v2.kind === "retry") throw new Error(`DeepSeek: ${v2.reason}`);
    return v2.resp;
  };

  // 4. Main flow (change horizon-v8-account-failover): RETRY_ATTEMPTS tries per
  // ACCOUNT, then the next account. A DeepSeek web chat is bound to one
  // account, so every account round starts from a fresh chat with the full
  // prompt. Only when every account has been tried is the error surfaced to
  // the core.
  //   - a dead id (invalid chat session) or an exhausted token budget is
  //     handled on the SAME account by recreating the chat once (full prompt);
  //   - a transient failure does NOT get a second round on the same session —
  //     the account is marked failed and the next one is tried.
  const order: Account[] = [];
  {
    const seen = new Set<string>();
    if (account) { order.push(account); seen.add(account.id); }
    const rest = (failover?.accounts ?? []).filter((a) => !seen.has(a.id));
    const now = Date.now();
    order.push(...rest.filter((a) => a.cooldownUntil <= now));
    order.push(...rest.filter((a) => a.cooldownUntil > now));
  }

  let lastErr: Error | null = null;
  for (let i = 0; i < order.length; i++) {
    const acct = order[i];
    if (session.accountId !== acct.id) {
      // Switching account means a new web chat: clear the id so the round
      // starts with ensureSession() and the full prompt.
      resetWebSession(session);
      session.accountId = acct.id;
    }
    activeAccount = acct;
    dsHeaders = acct.headers;
    if (i > 0) {
      const wait = nextThrottleMs();
      await new Promise((r) => setTimeout(r, wait));
      mylog("warn", `[horizon_v8] rotating to account ${acct.name} (${wait}ms pause) after account ${order[i - 1]?.name}`);
    }
    try {
      await ensureSession();
      // On account rotation (i>0) the web session was just reset: a fresh chat
      // needs the FULL prompt, not the minimal follow-up tail.
      const promptToSend = i > 0 ? (fullPrompt ?? prompt) : prompt;
      const resp = await completeOnSameSession(promptToSend);
      markAccountSuccess(acct);
      return resp;
    } catch (e: any) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      const msg = e?.message ? String(e.message) : "completion failed";
      markSessionFailed(session, msg);
      const limit = tokenLimit();
      const budget = shouldCompactForLimit(session, limit);
      if (budget.compact) requestCoreCompaction(session, budget.reason);
      if (isDeadSessionError(msg)) {
        // The id is unusable: recreate the chat on THIS account once (full
        // prompt) before giving up on it. The soft budget alone must NOT force
        // a full-prompt recreate — core compaction is unavailable, so rotating
        // on the budget only produced a giant prompt (the hang).
        mylog("warn", `[horizon_v8] session ${session.failedSessionId} failed on account ${acct.name} (${session.lastError}); recreating web session with full prompt`);
        try {
          return await recreateSessionAndRetry();
        } catch (e2: any) {
          lastErr = e2 instanceof Error ? e2 : new Error(String(e2));
          markSessionFailed(session, lastErr.message);
        }
      }
      mylog("warn", `[horizon_v8] account ${acct.name} exhausted after ${RETRY_ATTEMPTS} attempts (${session.lastError}); moving on`);
      if (failover) markAccountFailure(acct, failover.persist, msg);
    }
  }
  // Every account was tried and marked failed inside this call; tell the
  // caller not to mark the entry account a second time.
  const finalErr = lastErr ?? new Error("DeepSeek: completion failed");
  (finalErr as any).__horizonAccountsMarked = true;
  throw finalErr;
}

// ---------------------------------------------------------------------------
// Image upload (DeepSeek Web). Ported from the proven FreeDeepseekAPI patch
// (10.09.2026): a PoW-bound multipart POST followed by a readiness poll.
// ---------------------------------------------------------------------------

/** Fetches a fresh PoW header bound to /api/v0/file/upload_file. */
async function solveUploadPow(headers: Record<string, string>, wasmUrl: string): Promise<string> {
  const cr = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ target_path: "/api/v0/file/upload_file" }),
  });
  const chalJson: any = await cr.json().catch(() => null);
  const challenge = chalJson?.data?.biz_data?.challenge;
  if (!challenge) throw new Error("Upload PoW: no challenge in response");
  const answer = await solvePOW(challenge, wasmUrl);
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: "/api/v0/file/upload_file",
  })).toString("base64");
}

/**
 * Uploads one base64 data-URL to DeepSeek Web and returns the file id.
 * The multipart POST must NOT carry the account's default JSON Content-Type.
 */
export async function uploadImageToDeepSeek(dataUrl: string, account: Account): Promise<string> {
  const dsHeaders = account.headers;
  const wasmUrl = account.config.wasmUrl || "";
  const powB64 = await solveUploadPow(dsHeaders, wasmUrl);

  if (!dataUrl.startsWith("data:")) throw new Error("uploadImageToDeepSeek: expected a data: URL");
  const comma = dataUrl.indexOf(",");
  const meta = comma >= 0 ? dataUrl.slice(5, comma) : "image/jpeg";
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mime = meta.split(";")[0] || "image/jpeg";
  const ext = mime.split("/")[1] || "jpeg";
  const bytes = Buffer.from(b64, "base64");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), `image.${ext}`);

  const { "Content-Type": _ct, ...headersNoJson } = dsHeaders as Record<string, string>;
  const up = await fetch("https://chat.deepseek.com/api/v0/file/upload_file", {
    method: "POST",
    headers: { ...headersNoJson, "X-DS-PoW-Response": powB64 },
    body: form,
  });
  const upText = await up.text();
  let upJson: any;
  try { upJson = JSON.parse(upText); } catch { throw new Error(`Upload: non-JSON (HTTP ${up.status})`); }
  const fileId = upJson?.data?.biz_data?.id || upJson?.data?.biz_data?.file_id || upJson?.id;
  if (!fileId) throw new Error(`Upload: no file id (HTTP ${up.status}) ${upText.slice(0, 200)}`);
  mylog("info", `[horizon_v8] Uploaded image -> ${fileId}`);
  return fileId;
}

/** Polls GET /api/v0/file/fetch_files?file_ids=<id> until the file is READY. */
export async function waitForFileReady(fileId: string, account: Account, timeoutMs = 90000): Promise<boolean> {
  const headers = account.headers;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(
        `https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
        { method: "GET", headers },
      );
      const j: any = await r.json().catch(() => null);
      const files = j?.data?.biz_data?.files || j?.data?.biz_data || [];
      const f = Array.isArray(files) ? files.find((x: any) => x?.id === fileId) || files[0] : null;
      const status = f?.status;
      if (status === "SUCCESS") return true;
      if (status === "FAILED" || status === "CONTENT_EMPTY") {
        mylog("warn", `[horizon_v8] file ${fileId} terminal status ${status}`);
        return false;
      }
    } catch (e) {
      // transient poll failure: retry until the deadline
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  mylog("warn", `[horizon_v8] file ${fileId} not READY within ${timeoutMs}ms`);
  return false;
}

// ---------------------------------------------------------------------------
// Registry token accounting (change horizon-v8-session-registry)
// ---------------------------------------------------------------------------
// NOTE: the history_messages polling fallback was removed on 2026-09-22. The
// per-turn SSE stream carries accumulated_token_usage on essentially every
// turn, so the counter is maintained from the stream alone. When a turn has no
// counter we keep the previous value (buildUsage preserves the context
// snapshot); if the counter ever lags far enough for DeepSeek to reject the
// session, the error surfaces upstream and is handled then.
