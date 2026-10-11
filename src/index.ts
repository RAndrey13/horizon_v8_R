import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionState } from "./types.js";
import { loadAccounts } from "./accounts.js";
import { loadState, saveStateNow } from "./sessions.js";
import { MODEL_CONFIGS, SUPPORTED_MODELS } from "./models.js";
import { createStreamFn as createStreamFnImpl } from "./stream.js";
import { registerCommands, type AgentRuntime } from "./commands.js";
import { resolveAgentId, resolveAgentDirFromCtx, resolveWorkspaceDirFromCtx } from "./agent-scope.js";
import { setLogSink, mylog } from "./logger.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "horizon_v8",
  name: "Horizon V8",
  description: "DeepSeek Web API provider (PoW, sessions, streaming)",

  register(api: any) {
    setLogSink(api.logger ?? console);
    // Minimal follow-up prompt is ON by default; hz_followup only toggles it.
    if (process.env.HORIZON_MINIMAL_FOLLOWUP === undefined) {
      process.env.HORIZON_MINIMAL_FOLLOWUP = "1";
    }

    // --- Per-agent runtime cache (change horizon-v8-per-agent-accounts) ------
    // Every agent gets its own accounts + sessions + state.json under
    // <agentDir>/accounts. Runtimes are created lazily on first use.
    const runtimes = new Map<string, AgentRuntime>();

    function getRuntime(agentDir: string, agentId: string): AgentRuntime {
      let rt = runtimes.get(agentDir);
      if (rt) return rt;

      const accounts = loadAccounts(agentDir);
      if (accounts.length === 0) {
        mylog("warn", `[horizon_v8] No auth accounts for agent ${agentId} (${agentDir}/accounts) — add *.json there`);
      } else {
        mylog("info", `[horizon_v8] ${accounts.length} account(s) loaded for agent ${agentId}`);
      }

      const persisted = loadState(agentDir);
      for (const a of accounts) {
        const ps = persisted.accounts[a.name];
        if (ps) {
          a.cooldownUntil = ps.cooldownUntil || 0;
          a.failures = ps.failures || 0;
          a.lastUsedAt = ps.lastUsedAt || 0;
          a.lastErrorAt = ps.lastErrorAt || 0;
          a.lastError = ps.lastError || "";
        }
      }

      const sessions = new Map<string, SessionState>();
      for (const [key, ps] of Object.entries(persisted.sessions || {})) {
        sessions.set(key, {
          id: ps.id ?? null,
          parentMessageId: ps.parentMessageId ?? null,
          createdAt: ps.createdAt ?? null,
          messageCount: ps.messageCount || 0,
          accountId: ps.accountId ?? null,
          openclawSessionId: ps.openclawSessionId ?? null,
          turns: ps.turns || 0,
          tokensOpenclaw: ps.tokensOpenclaw || 0,
          tokensDeepseek: ps.tokensDeepseek || 0,
          tokensRefreshedAt: ps.tokensRefreshedAt ?? null,
          lastError: ps.lastError ?? "",
          lastErrorAt: ps.lastErrorAt ?? 0,
          failedSessionId: ps.failedSessionId ?? null,
          compactions: ps.compactions ?? 0,
          lastCompactionSig: ps.lastCompactionSig ?? null,
          modelType: ps.modelType ?? null,
        });
      }

      const persist = () => saveStateNow(accounts, sessions, agentDir);
      rt = {
        agentDir,
        agentId,
        accounts,
        sessions,
        rrRef: { value: 0 },
        inFlightRef: { value: 0 },
        persist,
        persisted,
      };
      runtimes.set(agentDir, rt);
      return rt;
    }

    /** Резолвит runtime вызывающего агента из ctx (stream или команды). */
    function getRuntimeFromCtx(ctx: any): AgentRuntime {
      const agentDir = resolveAgentDirFromCtx(ctx);
      const agentId = resolveAgentId(ctx);
      return getRuntime(agentDir, agentId);
    }

    mylog("info", "[horizon_v8] registered (per-agent accounts; lazy runtime)");

    // -----------------------------------------------------------------------
    // Register provider
    // -----------------------------------------------------------------------
    api.registerProvider({
      id: "horizon_v8",
      label: "Horizon V8 (DeepSeek Web)",
      docsPath: "/plugins/horizon_v8",
      envVars: ["DEEPSEEK_AUTH_PATH", "DEEPSEEK_AUTH_DIR", "HORIZON_STRIP_CHAT_WINDOW", "HORIZON_SMART_TRUNCATE", "HORIZON_TRUNCATE_SPECS", "HORIZON_THROTTLE_MIN_MS", "HORIZON_THROTTLE_MAX_MS", "HORIZON_THROTTLE_MS"],
      auth: [],
      catalog: {
        order: "simple",
        run: async () => ({
          provider: {
            api: "horizon-v8-raw" as const,
            baseUrl: "https://chat.deepseek.com",
            models: SUPPORTED_MODELS.map(id => {
              const mc = MODEL_CONFIGS[id];
              return {
                id,
                name: mc.real_model,
                contextWindow: mc.contextWindow,
                maxTokens: mc.maxTokens,
                reasoning: mc.reasoning,
                input: ["text"] as const,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              };
            }),
          },
        }),
      },

      // -----------------------------------------------------------------------
      // resolveSyntheticAuth — gateway doesn't need to check API key, we manage auth ourselves
      // -----------------------------------------------------------------------
      resolveSyntheticAuth: (_ctx: any) => ({
        apiKey: "plugin-managed",
        source: "horizon_v8 plugin (DeepSeek Web auth)",
        mode: "api-key" as const,
      }),

      // -----------------------------------------------------------------------
      // createStreamFn — replaces OpenClaw's HTTP transport entirely
      // -----------------------------------------------------------------------
      createStreamFn: (ctx: any) => {
        const rt = getRuntimeFromCtx(ctx);
        return createStreamFnImpl(ctx, { ...rt });
      },
    });

    // -----------------------------------------------------------------------
    // Model catalog
    // -----------------------------------------------------------------------
    api.registerModelCatalogProvider({
      provider: "horizon_v8",
      kinds: ["text"],
      liveCatalog: async () => SUPPORTED_MODELS.map(id => {
        const mc = MODEL_CONFIGS[id];
        return { kind: "text" as const, provider: "horizon_v8", model: `horizon_v8/${id}`, label: mc.real_model, source: "static" as const };
      }),
    });

    // -----------------------------------------------------------------------
    // Prompt override (former prism_v8): replace systemPrompt for target agents.
    // Config lives under plugins.entries.horizon_v8.config.promptOverride.
    // Workspace is resolved from ctx (ctx.workspaceDir), so no path map needed.
    // -----------------------------------------------------------------------
    const poCfg = ((api.pluginConfig ?? {}) as any).promptOverride ?? {};
    const poTargets: string[] = Array.isArray(poCfg.targetAgents) ? poCfg.targetAgents : [];
    const poEnabled = poCfg.enabled !== false && poTargets.length > 0;
    const poUserFile: string = (typeof poCfg.userFile === "string" && poCfg.userFile) ? poCfg.userFile : "USER.md";
    const PO_DEFAULT_PROMPT = "Ты — полезный ассистент с доступом к веб-поиску. Отвечай кратко и по делу. Если нужно найти актуальную информацию из интернета — используй web_search. Не выдумывай факты.";
    if (!poEnabled) {
      mylog("info", `[horizon_v8] promptOverride disabled (targets=${poTargets.length})`);
    } else {
      api.on(
        "before_prompt_build",
        (_event: any, ctx: any) => {
          const agentId = resolveAgentId(ctx);
          if (!poTargets.includes(agentId)) return;
          const ws = resolveWorkspaceDirFromCtx(ctx);
          const filePath = join(ws, poUserFile);
          let systemPrompt: string | null = null;
          let source = "user";
          try {
            const c = readFileSync(filePath, "utf-8").trim();
            if (c.length > 0) systemPrompt = c;
          } catch { /* fallthrough to default */ }
          if (!systemPrompt) { systemPrompt = PO_DEFAULT_PROMPT; source = "default"; }
          mylog("info", `[horizon_v8] promptOverride agent=${agentId} ws=${ws} source=${source} ${systemPrompt.length}ch`);
          return { systemPrompt };
        },
        { priority: 100 },
      );
      mylog("info", `[horizon_v8] promptOverride enabled targets=${poTargets.join(",")} file=${poUserFile}`);
    }

    // Commands (hz_*) — agent-scoped
    registerCommands(api, { getRuntime: getRuntimeFromCtx });
  },
});
