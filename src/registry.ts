import { createHash } from "node:crypto";
import { mylog } from "./logger.js";
// ---------------------------------------------------------------------------
// Session registry: decision logic for OpenClaw session -> DeepSeek web chat
// (change horizon-v8-session-registry). Pure functions, no imports, so the
// unit tests can load this module without the plugin SDK.
// ---------------------------------------------------------------------------

export type SessionMode = "new" | "continue" | "recreate";

export interface RegistryCounters {
  id: string | null;
  parentMessageId: string | null;
  turns: number;
  tokensOpenclaw: number;
  tokensDeepseek: number;
}

/**
 * HORIZON_TOKEN_LIMIT (default 120000): rotation threshold for the
 * authoritative DeepSeek counter (tokensDeepseek).
 *
 * Was 90000 — that value is BELOW the size of a full prompt (~110K when the
 * OpenClaw context is near its own compaction threshold). A freshly created
 * web session therefore started already over the limit and the registry
 * rotated on every single turn (observed 2026-09-22 18:14–18:18:
 * turns=105/2/6/1, tokDS=90025/113081/92120/91841). 120000 sits just above
 * the OpenClaw compaction trigger (~114688 for a 131072 window), so core
 * compacts first and rotation only fires for genuinely oversized sessions.
 */
export function tokenLimit(env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.HORIZON_TOKEN_LIMIT);
  return Number.isFinite(v) && v > 0 ? v : 120000;
}

/** Rough OpenClaw-side estimate of a prompt: chars / 4 (overestimates, ok). */
export function estimateTokens(chars: number): number {
  return Math.round(chars / 4);
}

/**
 * Flat registry decision for one turn:
 *  - no record / no live web session  -> "new"      (create + full prompt)
 *  - record alive and under the limit -> "continue" (same web session, minimal)
 *  - tokensDeepseek >= LIMIT          -> "recreate" (new web session + full)
 */
export function decideSessionMode(
  s: RegistryCounters,
  limit: number,
): { mode: SessionMode; reason: string } {
  const hasParent =
    s.parentMessageId !== null && s.parentMessageId !== undefined && String(s.parentMessageId) !== "";
  const hasWebSession = !!s.id && hasParent;
  if (!hasWebSession) return { mode: "new", reason: s.id ? "no-parent-message" : "no-web-session" };
  // Authoritative counter only: accumulated_token_usage from DeepSeek.
  // tokensOpenclaw (chars/4) no longer rotates the session — it overestimates
  // and was the main source of premature recreations.
  if (s.tokensDeepseek >= limit) return { mode: "recreate", reason: "tokensDeepseek-limit" };
  return { mode: "continue", reason: "reuse" };
}

/** Стабильный префикс сводки ядра OpenClaw (dist/session-*.mjs). */
export const COMPACTION_SUMMARY_PREFIX =
  "The conversation history before this point was compacted into the following summary:";

/** Плоский текст сообщения: строка или массив text-блоков (форма ядра). */
function messageText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const block of content) {
      if (block && typeof block === "object" && typeof block.text === "string") out += block.text;
    }
    return out;
  }
  return "";
}

/**
 * Компакт-сводка ли это. Ядро (`convertToLlm`, dist/session-*.mjs) отдаёт
 * сводку как role="user" с content МАССИВОМ text-блоков:
 *   content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary }]
 * Прежняя проверка `typeof m.content === "string"` такой формы не видела,
 * поэтому детект компакта не срабатывал ни разу (2026-09-22: в транскрипте
 * 7 compaction-событий, session.compactions остался 0, web-сессия росла до
 * token-limit 90000 вместо ротации после компакта).
 */
function isCompactionSummaryMessage(m: any): boolean {
  if (!m) return false;
  if (m.role === "branchSummary") return false;
  if (m.role === "compactionSummary") return true;
  return messageText(m.content).includes(COMPACTION_SUMMARY_PREFIX);
}

/** Число compaction-сводок в переданном окне сообщений. */
export function countCompactionSummaries(messages: any[]): number {
  let n = 0;
  for (const m of messages || []) if (isCompactionSummaryMessage(m)) n++;
  return n;
}

/**
 * Сигнатура ПОСЛЕДНЕЙ compaction-сводки в окне ("" — сводок нет).
 *
 * Это триггер ротации web-сессии. Счётчик для этого не годится: каждый
 * компакт заменяет всю историю одной сводкой, поэтому в окне всегда ровно
 * одна сводка и `count > previous` сработал бы только один раз за жизнь
 * ключа. Текст сводки меняется на каждом компакте — сравнение сигнатур
 * ловит и повторные компакты.
 *
 * Возвращается sha256-хэш текста (hex, 64 символа), а не сам текст: в
 * state.json лежит копия сигнатуры на каждую сессию, и полный текст
 * сводки раздувал файл (~2 КБ на сессию). Уникальность сравнения не
 * страдает — разные сводки дают разные хэши.
 */
export function latestCompactionSignature(messages: any[]): string {
  let text = "";
  for (const m of messages || []) {
    if (!isCompactionSummaryMessage(m)) continue;
    text = typeof m.summary === "string" ? m.summary : messageText(m.content);
  }
  return text ? createHash("sha256").update(text, "utf8").digest("hex") : "";
}

// ---------------------------------------------------------------------------
// Мягкий лимит: когда пора просить компакт ядра, а не просто пересоздавать чат.
// ---------------------------------------------------------------------------
// HORIZON_COMPACT_THRESHOLD (доля от tokenLimit(), default 0.85). Компакт
// запрашивается заранее, чтобы к моменту жёсткого лимита сводка уже была
// готова и новая web-сессия стартовала с чистым контекстом.
export function compactThreshold(limit: number, env: Record<string, string | undefined> = process.env): number {
  const v = Number(env.HORIZON_COMPACT_THRESHOLD);
  const ratio = Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.85;
  return Math.floor(limit * ratio);
}

/**
 * Пора ли просить компакт ядра. true — только когда авторитетный счётчик
 * DeepSeek перевалил мягкий порог. Обычные ошибки markup сюда не попадают:
 * они лечатся повтором в той же сессии.
 */
export function shouldCompactForLimit(
  s: RegistryCounters,
  limit: number,
  env: Record<string, string | undefined> = process.env,
): { compact: boolean; reason: string } {
  const threshold = compactThreshold(limit, env);
  if (s.tokensDeepseek >= threshold) {
    return { compact: true, reason: `tokensDeepseek>=${threshold} (limit=${limit})` };
  }
  return { compact: false, reason: `tokensDeepseek=${s.tokensDeepseek}<${threshold}` };
}

/**
 * ЗАГЛУШКА: запрос компакта ядра OpenClaw ещё не подключён. Пока только
 * логируем — вызывающая сторона сама решает, ротировать ли web-сессию.
 * TODO: подключить реальный вызов компакта ядра (compaction trigger).
 */
export function requestCoreCompaction(s: RegistryCounters, reason: string): void {
  // Core compaction is NOT available to the plugin (no host API). Rotation is
  // the only lever, and it is driven by the hard limit in decideSessionMode.
  // Informational only — must NOT force a full-prompt recreate (that produced
  // the giant resend that stalled on DeepSeek Web).
  mylog("warn", `[horizon_v8] core compaction unavailable (no host API); soft budget hit id=${s.id ?? "-"} reason=${reason}`);
}
