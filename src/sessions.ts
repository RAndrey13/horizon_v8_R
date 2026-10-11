// ---------------------------------------------------------------------------
// Sessions: persisted shared state (state.json) + session-key derivation
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Account, PersistedState, SessionState } from "./types.js";
import { accountsDir } from "./agent-scope.js";

// ---------------------------------------------------------------------------
// Persistent shared state (lives across turns and gateway restarts)
// ---------------------------------------------------------------------------

// Per-agent state location:
//  - HORIZON_STATE_PATH (if set) has priority (explicit override)
//  - <agentDir>/accounts/state.json for a scoped agent
//  - <dist>/state.json as the legacy plugin-wide fallback
export function statePath(agentDir?: string): string {
  if (process.env.HORIZON_STATE_PATH) return process.env.HORIZON_STATE_PATH;
  if (agentDir) return join(accountsDir(agentDir), "state.json");
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "state.json");
}

export function loadState(agentDir?: string): PersistedState {
  const empty: PersistedState = { version: 1, updatedAt: 0, accounts: {}, sessions: {} };
  try {
    const p = statePath(agentDir);
    if (!existsSync(p)) return empty;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.accounts !== "object") return empty;
    return {
      version: parsed.version ?? 1,
      updatedAt: parsed.updatedAt ?? 0,
      accounts: parsed.accounts ?? {},
      sessions: (parsed.sessions && typeof parsed.sessions === "object") ? parsed.sessions : {},
    };
  } catch { return empty; }
}

export function saveStateSync(state: PersistedState, agentDir?: string) {
  try {
    const p = statePath(agentDir);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, p);
  } catch { /* best-effort, never crash a request */ }
}

// Session key derived from the agent working dir (not the model id), so that
// different agents sharing one model do not share a single DeepSeek web chat.
export function deriveSessionKey(agentDir: string | undefined, _modelId?: string): string {
  const base = (agentDir || "default").replace(/\\/g, "/").replace(/\/+$/, "");
  const seg = base.split("/").slice(-2).join("/") || "default";
  return `${seg}::session`;
}

// ---------------------------------------------------------------------------
// Session map + persistence helpers (moved from index.ts, section 4.4)
// ---------------------------------------------------------------------------

export function getSession(sessions: Map<string, SessionState>, key: string): SessionState {
  let s = sessions.get(key);
  if (!s) {
    s = {
      id: null, parentMessageId: null, createdAt: null, messageCount: 0,
      accountId: null,
      openclawSessionId: null, turns: 0, tokensOpenclaw: 0, tokensDeepseek: 0, tokensRefreshedAt: null,
      lastError: "", lastErrorAt: 0, failedSessionId: null, compactions: 0, lastCompactionSig: null, modelType: null,
    };
    sessions.set(key, s);
  }
  return s;
}

export function saveStateNow(accounts: Account[], sessions: Map<string, SessionState>, agentDir?: string): void {
  const state: PersistedState = { version: 1, updatedAt: Date.now(), accounts: {}, sessions: {} };
  for (const a of accounts) {
    state.accounts[a.name] = {
      cooldownUntil: a.cooldownUntil,
      failures: a.failures,
      lastUsedAt: a.lastUsedAt,
      lastErrorAt: a.lastErrorAt,
      lastError: a.lastError,
    };
  }
  for (const [key, sess] of sessions.entries()) {
    state.sessions[key] = {
      id: sess.id,
      parentMessageId: sess.parentMessageId,
      createdAt: sess.createdAt,
      messageCount: sess.messageCount,
      accountId: sess.accountId,
      openclawSessionId: sess.openclawSessionId,
      turns: sess.turns,
      tokensOpenclaw: sess.tokensOpenclaw,
      tokensDeepseek: sess.tokensDeepseek,
      tokensRefreshedAt: sess.tokensRefreshedAt,
      lastError: sess.lastError ?? "",
      lastErrorAt: sess.lastErrorAt ?? 0,
      failedSessionId: sess.failedSessionId ?? null,
      compactions: sess.compactions ?? 0,
      lastCompactionSig: sess.lastCompactionSig ?? null,
      modelType: sess.modelType ?? null,
      updatedAt: Date.now(),
    };
  }
  saveStateSync(state, agentDir);
}
