// ---------------------------------------------------------------------------
// DeepSeek Web proof-of-work
// ---------------------------------------------------------------------------
// The prover is an upstream wasm-bindgen module reached through a hardcoded
// ABI (__wbindgen_export_0 / __wbindgen_add_to_stack_pointer / wasm_solve and
// their stack layout). If DeepSeek ever ships a new prover build, that ABI can
// change silently and every solve would fail far from the cause. To make such
// an upstream swap loud instead of invisible:
//   * the compiled module is cached per URL (download+compile happen once);
//   * the sha256 of the fetched bytes is always logged;
//   * when a pin is configured (HORIZON_POW_WASM_SHA256, or the value stored in
//     HORIZON_POW_WASM_HASH_FILE), a mismatch throws with a clear message.
// On first run with a hash file but no pin the observed hash is written there
// (TOFU) so the very next upstream change is detected.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mylog } from "./logger.js";

const DEFAULT_WASM_URL = "https://chat.deepseek.com/chat-webserver/prover_wasm_bg.wasm";

interface CachedProver {
  module: WebAssembly.Module;
  bytes: number;
  sha256: string;
}

// One compiled module per wasm URL: download + compile are the expensive half.
// A FRESH instance is still created for every solve, because the prover keeps
// scratch/stack state in instance memory and concurrent solves must not share
// it. A failed load is not cached, so the next turn retries cleanly.
const proverCache = new Map<string, Promise<CachedProver>>();

/** Test/debug hook: drop cached modules so the next solve re-fetches the wasm. */
export function clearPowWasmCache(): void {
  proverCache.clear();
}

/** Configured sha256 pin: env HORIZON_POW_WASM_SHA256, else HORIZON_POW_WASM_HASH_FILE. */
function pinnedSha256(): string | null {
  const envPin = (process.env.HORIZON_POW_WASM_SHA256 || "").trim().toLowerCase();
  if (envPin) return envPin;
  const file = (process.env.HORIZON_POW_WASM_HASH_FILE || "").trim();
  if (!file) return null;
  try {
    const v = readFileSync(file, "utf8").trim().toLowerCase();
    return v || null;
  } catch {
    return null;
  }
}

async function loadProver(wasmUrl: string): Promise<CachedProver> {
  const url = wasmUrl || DEFAULT_WASM_URL;
  const hit = proverCache.get(url);
  if (hit) return hit;

  const pending = (async (): Promise<CachedProver> => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`PoW: prover wasm fetch HTTP ${resp.status} (${url})`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const pin = pinnedSha256();
    if (pin && pin !== sha256) {
      throw new Error(
        `PoW: prover wasm sha256 mismatch (url=${url} expected=${pin} got=${sha256}). ` +
        "Upstream likely changed the wasm; re-verify the wasm-bindgen ABI used in src/pow.ts " +
        "and update HORIZON_POW_WASM_SHA256.",
      );
    }
    if (!pin) {
      // TOFU: freeze the observed hash if a hash file is configured, so the
      // next upstream swap fails loudly instead of silently breaking solves.
      const file = (process.env.HORIZON_POW_WASM_HASH_FILE || "").trim();
      if (file) {
        try { writeFileSync(file, sha256 + "\n", { mode: 0o644 }); } catch { /* read-only fs */ }
      }
      mylog("warn", `[horizon_v8] PoW prover wasm NOT pinned; sha256=${sha256} url=${url}. Set HORIZON_POW_WASM_SHA256 to freeze it.`);
    }

    const module = await WebAssembly.compile(bytes);
    mylog("info", `[horizon_v8] PoW prover wasm loaded url=${url} bytes=${bytes.length} sha256=${sha256}`);
    return { module, bytes: bytes.length, sha256 };
  })();

  proverCache.set(url, pending);
  try {
    return await pending;
  } catch (e) {
    proverCache.delete(url);
    throw e;
  }
}

/** Solves a DeepSeek PoW challenge via the prover WASM. */
export async function solvePOW(challenge: any, wasmUrl: string): Promise<number> {
  const { module } = await loadProver(wasmUrl);
  const inst = await WebAssembly.instantiate(module, { wbg: {} });
  const e = inst.exports as any;
  const encoder = new TextEncoder();
  const prefix = challenge.salt + "_" + challenge.expire_at + "_";
  const cBytes = encoder.encode(challenge.challenge);
  const pBytes = encoder.encode(prefix);

  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
  new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);

  const sp = e.__wbindgen_add_to_stack_pointer(-16);
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
  const dv = new DataView(e.memory.buffer);
  const code = dv.getInt32(sp, true);
  const ans = dv.getFloat64(sp + 8, true);
  e.__wbindgen_add_to_stack_pointer(16);
  if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error("PoW failed");
  return Math.floor(ans);
}

/**
 * Fetches a FRESH PoW challenge and returns the base64 X-DS-PoW-Response header.
 * A solved PoW is single-use: replaying the same header makes DeepSeek answer
 * HTTP 200 with {"code":40301,"msg":"INVALID_POW_RESPONSE"}, so every attempt
 * must ask for a new challenge instead of reusing one.
 */
export async function solveFreshPow(headers: Record<string, string>, wasmUrl: string): Promise<string> {
  const cr = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST", headers,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });
  const chalText = await cr.text();
  let chalJson: any;
  try { chalJson = JSON.parse(chalText); } catch { throw new Error("PoW: non-JSON response"); }
  const challenge = chalJson?.data?.biz_data?.challenge;
  if (!challenge) throw new Error("PoW: no challenge in response");
  const answer = await solvePOW(challenge, wasmUrl || "");
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm, challenge: challenge.challenge,
    salt: challenge.salt, answer, signature: challenge.signature,
    target_path: "/api/v0/chat/completion",
  })).toString("base64");
}
