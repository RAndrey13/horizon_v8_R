// ---------------------------------------------------------------------------
// hz_doctor: diagnose auth files of the calling agent (offline by default;
// 'live' for PoW check). Change horizon-v8-per-agent-accounts: the auth files
// come from the agent's own <agentDir>/accounts directory.
// ---------------------------------------------------------------------------

import { basename } from "node:path";
import { discoverAuthPaths, checkAuthFile, liveCheck } from "./accounts.js";
import { resolveAgentDirFromCtx } from "./agent-scope.js";

export async function runDoctor(ctx: any): Promise<{ text: string }> {
  const raw = typeof ctx === "string" ? ctx : (ctx?.args ?? ctx?.text ?? "");
  const live = /(^|\s)live(\s|$)/.test(String(raw));
  const agentDir = resolveAgentDirFromCtx(ctx);
  const files = discoverAuthPaths(agentDir);
  const out: string[] = [
    "**hz_doctor**",
    `Agent dir: ${agentDir}`,
    `Auth source: ${agentDir}/accounts`,
  ];
  if (files.length === 0) out.push("  ⚠ no auth files for this agent");
  for (const file of files) {
    const r = checkAuthFile(file);
    out.push("", `Auth file: ${basename(file)}`);
    if (r.ok) out.push("  ✅ auth file looks OK");
    else for (const issue of r.issues) out.push(`  ❌ ${issue}`);
    if (live && r.auth && r.ok) {
      const checks = await liveCheck(r.auth);
      for (const c of checks) {
        if (c.ok) out.push(`  ✅ live ${c.name}: HTTP ${c.status}`);
        else out.push(`  ❌ live ${c.name}: ${c.error || `HTTP ${c.status}`}`);
      }
    }
  }
  return { text: out.join("\n") };
}
