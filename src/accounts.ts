// ---------------------------------------------------------------------------
// Accounts: auth-file discovery, header building, loading, health checks
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountConfig, Account, SessionState } from "./types.js";
import { accountsDir } from "./agent-scope.js";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// state.json is a state file, never an account - exclude it from *.json listing.
const STATE_FILE = "state.json";

/**
 * Per-agent auth discovery. Приоритет:
 *  1) <agentDir>/accounts/*.json (кроме state.json)
 *  2) env DEEPSEEK_AUTH_DIR / DEEPSEEK_AUTH_PATH - только если каталог
 *     <agentDir>/accounts не существует (переходный fallback)
 *  3) legacy deepseek-auth.json рядом с плагином
 */
export function discoverAuthPaths(agentDir?: string): string[] {
  if (agentDir) {
    const dir = accountsDir(agentDir);
    try {
      return readdirSync(dir)
        .filter(f => f.endsWith(".json") && f !== STATE_FILE)
        .sort()
        .map(f => join(dir, f));
    } catch { /* fallthrough to env fallback */ }
  }
  const authDir = process.env.DEEPSEEK_AUTH_DIR;
  const authPath = process.env.DEEPSEEK_AUTH_PATH;
  if (authDir) {
    try { return readdirSync(authDir).filter(f => f.endsWith(".json") && f !== STATE_FILE).sort().map(f => join(authDir, f)); } catch {}
  }
  if (authPath) {
    if (authPath.includes(",")) return authPath.split(",").map(s => s.trim()).filter(Boolean);
    return [authPath];
  }
  const pluginDir = dirname(fileURLToPath(import.meta.url));
  return [join(pluginDir, "deepseek-auth.json")];
}

export function buildBaseHeaders(config: AccountConfig): Record<string, string> {
  return {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "x-client-platform": "web",
    "x-client-version": "2.0.0",
    "x-client-locale": "ru",
    "x-client-timezone-offset": "14400",
    "x-app-version": "2.0.0",
    Authorization: `Bearer ${config.token || ""}`,
    "x-hif-dliq": config.hif_dliq || "",
    "x-hif-leim": config.hif_leim || "",
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    Cookie: config.cookie || "",
    "Content-Type": "application/json",
  };
}

export function loadAccounts(agentDir?: string): Account[] {
  const accounts: Account[] = [];
  for (const file of discoverAuthPaths(agentDir)) {
    try {
      const raw = readFileSync(file, "utf8");
      const config: AccountConfig = JSON.parse(raw);
      if (!config.token || !config.cookie) continue;
      accounts.push({
        id: `account_${accounts.length + 1}`,
        name: basename(file),
        config,
        headers: buildBaseHeaders(config),
        cooldownUntil: 0,
        failures: 0,
        lastUsedAt: 0,
        lastErrorAt: 0,
        lastError: "",
      });
    } catch { /* skip unreadable */ }
  }
  return accounts;
}

export function checkAuthFile(file: string) {
  const issues: string[] = [];
  let auth: any = null;
  if (!existsSync(file)) return { file, ok: false, issues: ["auth file missing"], auth: null };
  try { auth = JSON.parse(readFileSync(file, "utf8")); }
  catch (e: any) { return { file, ok: false, issues: [`invalid JSON: ${e.message}`], auth: null }; }
  if (!auth.token) issues.push("token missing");
  if (!auth.cookie) issues.push("cookie missing");
  if (!auth.wasmUrl) issues.push("wasmUrl missing");
  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) issues.push(`permissions too open: ${mode.toString(8)} (run: chmod 600 ${file})`);
  }
  return { file, ok: issues.length === 0, issues, auth };
}

export async function liveCheck(auth: any): Promise<Array<{ name: string; ok: boolean; status?: number; error?: string }>> {
  const headers = buildBaseHeaders(auth as AccountConfig);
  const checks: Array<{ name: string; ok: boolean; status?: number; error?: string }> = [];
  try {
    const r = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
      method: "POST", headers, body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    });
    const text = await r.text();
    // Reachability only: create_pow_challenge answers OK even with a dead
    // token/cookie, so this does NOT verify authorization.
    checks.push({ name: "pow reachability (auth NOT verified)", ok: r.ok && /biz_data|challenge/.test(text), status: r.status });
  } catch (e: any) {
    checks.push({ name: "pow reachability (auth NOT verified)", ok: false, error: e.message });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// Cooldowns + round-robin account selection (moved from index.ts, section 4.4)
// ---------------------------------------------------------------------------

const COOLDOWN_BASE_MS = (() => {
  const sec = Number(process.env.HORIZON_COOLDOWN_SEC);
  return Number.isFinite(sec) && sec > 0 ? Math.floor(sec * 1000) : 300000;
})();
const COOLDOWN_CAP_MS = 30 * 60 * 1000;

export function markAccountFailure(account: Account, saveState: () => void, reason?: string): void {
  account.failures += 1;
  account.lastUsedAt = Date.now();
  account.lastErrorAt = Date.now();
  account.lastError = reason || "request failed";
  const backoff = Math.min(COOLDOWN_BASE_MS * Math.pow(2, account.failures - 1), COOLDOWN_CAP_MS);
  account.cooldownUntil = Date.now() + backoff;
  saveState();
}

export function markAccountSuccess(account: Account): void {
  account.failures = 0;
  account.cooldownUntil = 0;
  account.lastUsedAt = Date.now();
}

/** Full reset of the web session plus registry counters (rotation/switch). */
export function resetWebSession(session: SessionState): void {
  session.id = null;
  session.parentMessageId = null;
  session.createdAt = null;
  session.messageCount = 0;
  session.turns = 0;
  session.tokensOpenclaw = 0;
  session.tokensDeepseek = 0;
  session.tokensRefreshedAt = null;
}

export function selectAccount(accounts: Account[], session: SessionState, rr: { value: number }): Account {
  if (accounts.length === 0) throw new Error("No accounts configured");
  const now = Date.now();
  if (session.accountId) {
    const sticky = accounts.find(a => a.id === session.accountId);
    if (sticky && sticky.cooldownUntil <= now) return sticky;
    const alt = accounts.find(a => a.id !== session.accountId && a.cooldownUntil <= now);
    if (alt) {
      resetWebSession(session);
      session.accountId = alt.id;
      return alt;
    }
    // No ready account: take the earliest-recovering one WITHOUT wiping every
    // backoff (wiping hammered a failing account). A switch means a new web
    // chat, so the session MUST be reset — otherwise the old web id leaks into
    // the new account's headers (invalid chat session id).
    const pick = sticky ?? accounts.reduce((b, a) => (a.cooldownUntil < b.cooldownUntil ? a : b), accounts[0]);
    if (pick.id !== session.accountId) resetWebSession(session);
    session.accountId = pick.id;
    return pick;
  }
  const ready = accounts.filter(a => a.cooldownUntil <= now);
  const pool = ready.length > 0 ? ready : accounts.slice().sort((x, y) => x.cooldownUntil - y.cooldownUntil);
  const a = pool[rr.value++ % pool.length];
  if (session.accountId && session.accountId !== a.id) resetWebSession(session);
  session.accountId = a.id;
  return a;
}
