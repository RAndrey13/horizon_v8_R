// ---------------------------------------------------------------------------
// Agent scope: resolve the per-agent working directory and accounts dir.
//
// Decisions (change horizon-v8-per-agent-accounts):
//  - agentDir  = /root/.openclaw/agents/<agentId>
//  - accounts  = <agentDir>/accounts
//  - agentId   = ctx.agentId | sessionKey "agent:<id>" | "main"
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";

/** Извлекает идентификатор агента из контекста (stream или команды). */
export function resolveAgentId(ctx: any): string {
  if (ctx) {
    const direct = ctx.agentId ?? ctx.agent;
    if (typeof direct === "string" && direct.trim()) return direct.trim();
    const sk = ctx.sessionKey;
    if (typeof sk === "string") {
      const m = /^agent:([^:]+)/.exec(sk);
      if (m && m[1]) return m[1];
    }
    const rt = ctx.runtime || ctx.runtimeInfo;
    if (rt) {
      const a = rt.agent ?? rt.agentId;
      if (typeof a === "string" && a.trim()) return a.trim();
      const s = rt.sessionKey ?? rt.session;
      if (typeof s === "string") {
        const m = /^agent:([^:]+)/.exec(s);
        if (m && m[1]) return m[1];
      }
    }
  }
  return "main";
}

function openclawHome(): string {
  return process.env.OPENCLAW_HOME || join(os.homedir(), ".openclaw");
}

/**
 * Резолвер рабочей директории агента (для promptOverride: USER.md и пр.):
 *  1) ctx.workspaceDir (если задан и существует)
 *  2) каталог агента (fallback)
 *
 * Отдельно от resolveAgentDirFromCtx: у main workspace —
 * /root/.openclaw/workspace, а accounts/state — в agents/main.
 */
export function resolveWorkspaceDirFromCtx(ctx: any): string {
  const ws = ctx && ctx.workspaceDir;
  if (typeof ws === "string" && ws.trim() && existsSync(ws)) {
    return ws.replace(/[/\\]+$/, "");
  }
  return resolveAgentDirFromCtx(ctx);
}

export function resolveAgentDirFromCtx(ctx: any): string {
  const agentId = resolveAgentId(ctx);
  const ad = ctx && ctx.agentDir;
  if (typeof ad === "string" && ad.trim()) {
    const norm = ad.replace(/[/\\]+$/, "");
    if (/(^|[\\/])agent$/.test(norm)) return dirname(norm);
    return norm;
  }
  return join(openclawHome(), "agents", agentId);
}

/** <agentDir>/accounts; создаёт каталог (recursive) при первом обращении. */
export function accountsDir(agentDir: string): string {
  const dir = join(agentDir, "accounts");
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return dir;
}
