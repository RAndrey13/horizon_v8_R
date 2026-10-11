// ---------------------------------------------------------------------------
// Optional raw tool-call diagnostic tap.
//
// The host validator sits ABOVE this plugin: if a tool call arrives with an
// empty/garbled argument body, the loss is already invisible by the time the
// core sees it. This tap dumps the RAW model response at the exact moment the
// tool calls are built in stream.ts, so a lost or truncated call body can be
// inspected below the validator.
//
// Disabled by default. Enable explicitly with:
//   HORIZON_RAWTC_DIAG=<path>            # JSONL dump target
// There is NO default path: the plugin never writes diagnostics anywhere on
// its own (a hardcoded machine-specific path used to live in dist/stream.js).
// The file is auto-trimmed so it cannot grow without bound.
// ---------------------------------------------------------------------------

import { appendFileSync, statSync, readFileSync, writeFileSync } from "node:fs";

const MAX_BYTES = 5 * 1024 * 1024; // trim once the file passes this
const KEEP_BYTES = 1 * 1024 * 1024; // keep roughly this much tail

function targetPath(): string {
  return (process.env.HORIZON_RAWTC_DIAG || "").trim();
}

function trimFile(path: string): void {
  try {
    if (statSync(path).size <= MAX_BYTES) return;
    const lines = readFileSync(path, "utf8").split("\n");
    let acc = 0;
    const keep: string[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln) continue;
      acc += Buffer.byteLength(ln, "utf8") + 1;
      keep.push(ln);
      if (acc >= KEEP_BYTES) break;
    }
    keep.reverse();
    writeFileSync(path, keep.join("\n") + "\n");
  } catch { /* best-effort */ }
}

/**
 * Appends one raw-response sample to the diagnostic JSONL.
 * Never throws: diagnostics must never break a turn.
 */
export function dumpRawToolCall(
  where: string,
  fullContent: string,
  parsed: Array<{ name?: string; args?: unknown }> | null | undefined,
  allowed: number,
): void {
  const path = targetPath();
  if (!path) return;
  try {
    trimFile(path);
    const payload = {
      ts: new Date().toISOString(),
      where,
      len: fullContent.length,
      allowed,
      content: fullContent.slice(0, 20000),
      parsedCount: parsed ? parsed.length : 0,
      parsedArgs: parsed ? parsed.slice(0, 5).map((c) => ({ name: c?.name, args: c?.args })) : [],
    };
    appendFileSync(path, JSON.stringify(payload) + "\n");
  } catch { /* diagnostics must never break the turn */ }
}
