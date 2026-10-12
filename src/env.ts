// ---------------------------------------------------------------------------
// Environment flags & context markers for horizon_v8 (leaf module)
// ---------------------------------------------------------------------------

import type { TruncateSpec } from "./types.js";

/** Читает boolean-флаг из env: "1"/"true" → true, "0"/"false" → false, пусто/нет → default. */
export function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v === "1" || v === "true";
}

// ---------------------------------------------------------------------------
// Runtime context chat-window strip (opt-in)
// ---------------------------------------------------------------------------
// HORIZON_STRIP_CHAT_WINDOW cuts the "Conversation context (selected)"
// block out of the OpenClaw runtime context before sending to DeepSeek Web.
// Keeps Conversation info (metadata) intact; drops only the redundant
// per-turn history selection. Default ON; env может выключить ("0"/"false").
export const STRIP_CHAT_WINDOW = envBool("HORIZON_STRIP_CHAT_WINDOW", true);

// OpenClaw 2026.9.1 сменил формулировки runtime-контекста:
//  "…for the immediately preceding user message" → "…for the active user request in this turn"
//  "Conversation context (untrusted, chronological…" → "Conversation context (chronological…"
//  записи "#48 …" → "#session:<uuid> …"
// Поддерживаем оба варианта (старый и новый), чтобы вырезка не ломалась об апдейты ядра.
export const RUNTIME_CONTEXT_MARKERS = [
  "OpenClaw runtime context for the active user request in this turn",
  "OpenClaw runtime context for the immediately preceding user message",
];
export const CHAT_WINDOW_START_MARKERS = [
  "Conversation context (chronological, selected for current message):",
  "Conversation context (untrusted, chronological, selected for current message):",
];
export const RUNTIME_CONTEXT_END_MARKER = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

/** Убирает экранированные ядром внутренние маркеры контекста из любого текста. */
export function stripInternalContextMarkers(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(/\[\[OPENCLAW_INTERNAL_CONTEXT_BEGIN\]\][\s\S]*?\[\[OPENCLAW_INTERNAL_CONTEXT_END\]\]/g, '');
  out = out.replace(/<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/g, '');
  out = out.replace(/\[\[OPENCLAW_INTERNAL_CONTEXT_(?:BEGIN|END)\]\]/g, '');
  out = out.replace(/\u27e6openclaw:ctx\u27e7/g, '');
  return out;
}

export function indexOfAny(text: string, markers: readonly string[]): number {
  let best = -1;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  return best;
}

export function includesAny(text: string, markers: readonly string[]): boolean {
  return indexOfAny(text, markers) !== -1;
}

// HORIZON_RESTORE_HISTORY (дефолт ON) — умный strip: если в messages истории нет
// (0-1 ходов до хвоста), а блок "Conversation context" тащит >2 записей —
// сессия сбилась: распарсить блок и восстановить историю как User:/Assistant:
// строки сразу после System. Если история на месте — просто вырезать блок
// (экономия токенов, как HORIZON_STRIP_CHAT_WINDOW).
// HORIZON_ASSISTANT_SENDERS="Name1,Name2" — доп. имена ассистента (ботов).
export const RESTORE_HISTORY = envBool("HORIZON_RESTORE_HISTORY", true);

export const DEFAULT_ASSISTANT_SENDERS = ["openclaw", "vpshelper", "werther", "вертер", "pythia", "robert", "assistant", "bot"];
export const ASSISTANT_SENDER_SET = new Set([
  ...DEFAULT_ASSISTANT_SENDERS,
  ...(process.env.HORIZON_ASSISTANT_SENDERS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
]);

// Токены даты/времени/флагов в начале строки "#id <timestamp> <Sender>: <body>"
export const TIME_TOKEN_RE = /^(mon|tue|wed|thu|fri|sat|sun)$|^\d{4}-\d{2}-\d{2}$|^\d{1,2}:\d{2}(:\d{2})?$|^gmt[+-]\d{1,2}$/i;

// HORIZON_EXTRA_SYSTEM_FILES=/path/to/TOOLS.md:/path2 — extra files appended
// right after the System prompt (used to inject per-agent tool definitions).
export const EXTRA_SYSTEM_FILES: string[] = (process.env.HORIZON_EXTRA_SYSTEM_FILES || "")
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean);

// HORIZON_SMART_TRUNCATE (текущий дефолт ON) — сжатие Observation включено:
// результаты инструментов (read/exec/...) обрезаются по BASE_TRUNCATE_SPECS
// (середина выпадает), чтобы длинные выводы не раздували follow-up промпт.
// Выключить: HORIZON_SMART_TRUNCATE=false (тогда результат уходит целиком).
// Лимиты переопределяются через HORIZON_TRUNCATE_SPECS JSON.
// Историческая справка: 2026-09-05 сжатие отключали из-за непредсказуемой
// обрезки; позже вернули как дефолт (см. trim-тесты в tests/).
export const SMART_TRUNCATE = envBool("HORIZON_SMART_TRUNCATE", true);

export const BASE_TRUNCATE_SPECS: Record<string, TruncateSpec> = {
  // read: начало файла + конец (сигнал о структуре и хвосте)
  read: { head: 800, tail: 400 },
  // write/edit/apply_patch: только статус (путь, байты), без эха содержимого
  write: { head: 200, tail: 0 },
  edit: { head: 200, tail: 0 },
  apply_patch: { head: 200, tail: 0 },
  // exec/process: вывод команд может быть огромным
  exec: { head: 800, tail: 400 },
  process: { head: 800, tail: 400 },
  // ls/find: сжатый список, не весь ls -la
  ls: { head: 600, tail: 200 },
  find: { head: 600, tail: 200 },
  // web_search: результаты поиска — основной сигнал, режем щедрее
  web_search: { head: 2000, tail: 0 },
  web_fetch: { head: 800, tail: 400 },
  // sessions_send: статус + конец (reply) важнее середины
  sessions_send: { head: 500, tail: 500 },
  memory_search: { head: 800, tail: 400 },
  // тонкие алиасы: статус и всё
  send_nata: { head: 200, tail: 0 },
  send_message: { head: 200, tail: 0 },
  append_note: { head: 200, tail: 0 },
};

export const DEFAULT_TRUNCATE_SPEC: TruncateSpec = { head: 1500, tail: 0 };

// Переопределения лимитов из env (JSON), без пересборки плагина.
export const TRUNCATE_SPECS: Record<string, TruncateSpec> = { ...BASE_TRUNCATE_SPECS };
try {
  const extra = JSON.parse(process.env.HORIZON_TRUNCATE_SPECS || "{}");
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object") {
      const s = v as { head?: number; tail?: number };
      TRUNCATE_SPECS[k] = {
        head: typeof s.head === "number" ? s.head : BASE_TRUNCATE_SPECS[k]?.head ?? DEFAULT_TRUNCATE_SPEC.head,
        tail: typeof s.tail === "number" ? s.tail : BASE_TRUNCATE_SPECS[k]?.tail ?? DEFAULT_TRUNCATE_SPEC.tail,
      };
    }
  }
} catch {}
