// ---------------------------------------------------------------------------
// Logging gate for horizon_v8.
//
// Goal: info-level chatter must NOT clutter the OpenClaw Gateway JSONL journal
// by default. warn/error always pass through. Toggle info at runtime with the
// Telegram command `hz_log on|off` (default OFF; env HORIZON_LOG_INFO=1 for ON).
//
// Every plugin log goes through mylog(level, text) and lands in the Gateway
// journal via the plugin logger (api.logger). The sink is a module-level
// singleton so leaf modules (client/sanitize/pow/registry) can log without
// importing the plugin API.
// ---------------------------------------------------------------------------

export type HorizonLogLevel = "info" | "warn" | "error";

interface LogSink {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

const PREFIX = "[horizon_v8]";

function defaultSink(): LogSink {
  return console as unknown as LogSink;
}

let sink: LogSink = defaultSink();

/** Устанавливает приёмник логов (api.logger из register()). null/undefined → console. */
export function setLogSink(next: LogSink | null | undefined): void {
  sink = next ?? defaultSink();
}

function envInfoEnabled(): boolean {
  const v = process.env.HORIZON_LOG_INFO;
  if (v === undefined || v === "") return false;
  return v === "1" || v === "true";
}

let infoEnabled = envInfoEnabled();

/** Включает/выключает info-логи (warn/error не затрагивает). */
export function setInfoLogging(on: boolean): void {
  infoEnabled = on;
  process.env.HORIZON_LOG_INFO = on ? "1" : "0";
}

export function isInfoLogging(): boolean {
  return infoEnabled;
}

/** Единый префикс плагина; добавляется, только если его нет. */
function withPrefix(text: string): string {
  return text.startsWith(PREFIX) ? text : `${PREFIX} ${text}`;
}

/**
 * Отладочный лог по отдельному флагу HORIZON_DEBUG_TOOLPARSE.
 * Пишется в журнал OpenClaw через общий sink, минуя гейт hz_log (чтобы
 * включённый debug не зависел от hz_log off). Префикс [horizon_v8] не дублируется.
 */
export function mylogDebug(tag: string, message: unknown): void {
  if (!process.env.HORIZON_DEBUG_TOOLPARSE) return;
  const text = typeof message === "string" ? message : String(message);
  sink.info(withPrefix(`${tag} ${text}`));
}

/**
 * Единая точка логирования плагина.
 * info — только при включённом флаге; warn/error — всегда.
 */
export function mylog(level: HorizonLogLevel, message: unknown): void {
  const text = withPrefix(typeof message === "string" ? message : String(message));
  if (level === "info") {
    if (!infoEnabled) return;
    sink.info(text);
    return;
  }
  if (level === "warn") {
    sink.warn(text);
    return;
  }
  sink.error(text);
}
