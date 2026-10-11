// ---------------------------------------------------------------------------
// Tool-call parsing: recognize JSON / XML / legacy TOOL_CALL / DSML forms.
//
// Тяжёлая структурная работа с DSML вынесена в ./toolparse.js (точный порт
// FreeDeepseekAPI/server.js). Здесь — стриминговые хелперы и публичный API,
// который остаётся совместимым: parseToolCall + parseToolCallAll.
// ---------------------------------------------------------------------------

import {
  parseToolCallAll as parseToolCallAllImpl,
  parseToolCallStrict,
  decodeDsmlValue,
  decodeDsmlParameterValue,
  normalizeToolMarkupTags,
} from "./toolparse.js";

export type { ParsedToolCall } from "./toolparse.js";

// C1: DSML / tool-call safety limits (mirrors FreeDeepseekAPI/server.js).
export const MAX_DSML_PARAMETERS = 128;
export const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
export const MAX_DSML_TAG_CHARS = 2048;
export const MAX_TOOL_JSON_CANDIDATES = 32;

export { decodeDsmlValue, decodeDsmlParameterValue };

// DeepSeek sometimes wraps tags in its  markup (full-width or ASCII bars).
// Нормализуем обратно в plain-теги. Делегирует в структурную канонизацию
// (точнее старой regex-замены: понимает `name=`, `direct`, лишние пробелы).
export function normalizeDsmlMarkup(text: string): string {
  if (!text || text.indexOf("DSML") === -1) return text;
  return normalizeToolMarkupTags(text);
}

export function findToolCallStart(text: string): number {
  if (!text) return -1;
  const markers = [
    '{"tool_call',
    '{"tool',
    '{"name":',
    '<tool_calls',
    '<function_calls',
    '<invoke ',
    '<tool_call',
    'TOOL_CALL:',
  ];
  let idx = -1;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  return idx;
}

// Strong markup markers — safe to anchor ANYWHERE in the response. These are
// unambiguous tool-call envelopes (a quoted log line or a code sample rarely
// contains a bar-prefixed DSML wrapper), so "text + call" is handled without
// cutting ordinary prose.
const STRONG_MARKUP_RE =
  /{\s*"(?:tool_call|tool)\b|<\s*\/?\s*(?:tool_calls?|function_calls?|invoke)\b|[<＜]?[｜|]{1,2}\s*DSML|TOOL_CALL:|DSML(?=\s*(?:tool|function|calls|invoke|parameter)\b)/i;

// Broad form: strict markers first, then strong markup anywhere. The old
// implementation only anchored a bar-DSML wrapper that had a leading '<' and
// otherwise required the marker at the very start of the response — so a
// bare-bar wrapper ("｜｜DSML｜｜ calls>") after prose was missed and the whole
// block leaked into chat on the final flush.
export function findToolCallStartBroad(text: string): number {
  if (!text) return -1;
  const strict = findToolCallStart(text);
  const strong = text.search(STRONG_MARKUP_RE);
  if (strict !== -1 && strong !== -1) return Math.min(strict, strong);
  if (strict !== -1) return strict;
  if (strong !== -1) return strong;
  // Weak markers (bare `{"name":`, a lone `DSML` mention) are only trusted when
  // the response IS a bare envelope — never when they appear inside prose.
  if (!/^\s*(?:\{|<|TOOL_CALL:|DSML)/.test(text)) return -1;
  return text.search(/DSML|{\s*"name"\s*:/i);
}

export function isJsonStartText(text: string): boolean {
  if (!text) return false;
  return text.trimStart().startsWith("{");
}

// Strict tool-call JSON start: {"tool_call":...} / {"name":...,"arguments":...}.
// Narrower than isJsonStartText so genuine JSON answers are not suppressed.
export function isToolCallJsonStart(text: string): boolean {
  const t = (text || "").trimStart();
  if (!t.startsWith("{")) return false;
  if (!/^\{\s*"(tool_call|tool|function|name)"\s*:/.test(t)) return false;
  return /"(arguments|args|parameters|input)"\s*:/.test(t);
}

const TOOL_CALL_MARKERS = ['{"tool_call', '{"tool', '{"name":', '<tool_calls', '<function_calls', '<invoke', '<tool_call', 'TOOL_CALL:', 'DSML'] as const;
export function looksLikeToolCallPrefix(tail: string): boolean {
  if (!tail) return false;
  const t = tail.trimStart();
  if (!t) return false;
  if (t.startsWith("{") || t.startsWith("<")) return true;
  // Any bar may open a DSML wrapper ("｜｜DSML｜｜..."); hold the tail so a
  // partial wrapper cannot reach the chat before the next chunk completes it.
  if (/[｜|]/.test(t)) return true;
  if (t.indexOf("DSML") !== -1) return true;
  for (const m of TOOL_CALL_MARKERS) {
    if (t.startsWith(m)) return true;
    // Partial marker at the tail: hold it until more text arrives. One-char
    // prefixes ("T" for TOOL_CALL:, "D" for DSML) must hold too — otherwise
    // the first letter of an envelope slips through before the next chunk.
    if (m.startsWith(t)) return true;
    // Partial marker at the END of prose ("Сейчас. TOOL_CALL"): the current
    // chunk may be the first half of an envelope, so hold the suffix too.
    const maxK = Math.min(m.length - 1, t.length);
    for (let k = maxK; k >= 1; k--) {
      if (t.endsWith(m.slice(0, k))) return true;
    }
  }
  return false;
}

// --- public parsing API -----------------------------------------------------

/**
 * Все tool call из ответа модели, в порядке появления.
 * Пустой массив, если вызовов нет или сработала флуд-защита.
 */
export function parseToolCallAll(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  return parseToolCallAllImpl(text);
}

/** Первый tool call либо null (совместимость со старым поведением). */
export function parseToolCall(text: string): { name: string; args: Record<string, unknown> } | null {
  return parseToolCallStrict(text);
}
