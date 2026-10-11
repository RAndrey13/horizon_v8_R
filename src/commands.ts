// ---------------------------------------------------------------------------
// Commands: hz_* registration. Change horizon-v8-per-agent-accounts: every
// command handler receives the PluginCommandContext and resolves the calling
// agent's runtime (accounts + sessions) via getRuntime(ctx), so all commands
// operate only on that agent's accounts and sessions.
// ---------------------------------------------------------------------------

import type { Account, PersistedState, SessionState } from "./types.js";
import { runDoctor } from "./doctor.js";
import { MODEL_CONFIGS, SUPPORTED_MODELS } from "./models.js";
import { tokenLimit, decideSessionMode } from "./registry.js";
import { mylog, setInfoLogging, isInfoLogging } from "./logger.js";

export interface AgentRuntime {
  agentDir: string;
  agentId: string;
  accounts: Account[];
  sessions: Map<string, SessionState>;
  rrRef: { value: number };
  inFlightRef: { value: number };
  persist: () => void;
  persisted: PersistedState;
}

export interface CommandDeps {
  getRuntime: (ctx: any) => AgentRuntime;
}

/** Аргументы команды: поддержка строки и PluginCommandContext. */
function argText(ctx: any): string {
  if (typeof ctx === "string") return ctx;
  return String(ctx?.args ?? ctx?.text ?? ctx?.commandBody ?? "");
}

export function registerCommands(api: any, deps: CommandDeps): void {
  const { getRuntime } = deps;

  // -----------------------------------------------------------------------
  // hz_commands — единая точка входа: меню со всеми hz_* командами (кнопки)
  // -----------------------------------------------------------------------
  const HZ_COMMANDS: Array<{ name: string; description: string }> = [
    { name: "horizon_status", description: "Agent status: accounts, sessions, registry, in-flight" },
    { name: "hz_health", description: "DeepSeek Web proxy health (accounts, sessions, config)" },
    { name: "hz_models", description: "List OpenAI-compatible model aliases" },
    { name: "hz_capabilities", description: "Full alias -> real model -> capabilities map" },
    { name: "hz_sessions", description: "List active local agent sessions" },
    { name: "hz_reset_session", description: "Reset one session (agent=<id>) or all (agent=all)" },
    { name: "hz_reset_account", description: "Reset account cooldown/failures (name=<file>|all)" },
    { name: "hz_doctor", description: "Diagnose auth files (offline; pass 'live' for PoW check)" },
    { name: "hz_followup", description: "Minimal follow-up prompt (default: on)" },
    { name: "hz_log", description: "info-логи плагина: on|off|status (default: off)" },
  ];

  api.registerCommand({
    name: "hz_commands",
    description: "list all slash commands.",
    handler: () => ({
      text: "**hz_commands**",
      presentation: {
        title: "Horizon V8 commands",
        tone: "info",
        blocks: [
          { type: "text", text: HZ_COMMANDS.map(c => `/${c.name} — ${c.description}`).join("\n") },
        ],
      },
    }),
  });

  // -----------------------------------------------------------------------
  // horizon_status — единый статус: агент, аккаунты (ready/total, cooldown),
  // сессии (реестр: web-id, turns, токены, decision), in_flight.
  // Модели здесь НЕ дублируются — они в /hz_models и /hz_capabilities.
  // -----------------------------------------------------------------------
  api.registerCommand({
    name: "horizon_status",
    description: "Agent status: accounts, sessions, registry, in-flight",
    handler: (ctx: any) => {
      const { accounts, sessions, inFlightRef, agentId, agentDir } = getRuntime(ctx);
      const now = Date.now();
      const ready = accounts.filter(a => a.cooldownUntil <= now).length;
      const accountName = (id: string | null) => {
        const a = accounts.find(x => x.id === id);
        return a ? a.name : (id || "-");
      };
      const limit = tokenLimit();
      // Нет horizon-аккаунтов у агента — сказать прямо, а не печатать пустые
      // списки, которые читаются как поломка команды.
      const accLines = accounts.length === 0
        ? ["  (нет horizon-аккаунтов: добавь *.json в " + agentDir + "/accounts)"]
        : accounts.map(a => {
            const r = Math.max(0, Math.ceil((a.cooldownUntil - now) / 1000));
            const cd = a.cooldownUntil > now ? "⏳ cd " + r + "s" : "✅ ready";
            return "  " + a.name + ": " + cd + " (" + a.failures + " errors)";
          });
      const sessLines = sessions.size === 0
        ? ["  (none)"]
        : [...sessions.entries()].map(([key, s]) => {
            const d = decideSessionMode(s, limit);
            return [
              "  key=" + key,
              "    web=" + (s.id ?? "-") + " parent=" + (s.parentMessageId ?? "-"),
              "    turns=" + s.turns + " msgs=" + s.messageCount + " account=" + accountName(s.accountId),
              "    tokens openclaw=" + s.tokensOpenclaw + " deepseek=" + s.tokensDeepseek + " limit=" + limit + " decision=" + d.mode + "(" + d.reason + ")",
            ].join("\n");
          });
      return {
        text: [
          "**Horizon V8**",
          "Agent: " + agentId + " (" + agentDir + ")",
          "Accounts: " + accounts.length + " (ready " + ready + "/" + accounts.length + ")",
          ...accLines,
          "Sessions: " + sessions.size + " | in_flight: " + inFlightRef.value,
          "",
          "**Sessions** (limit=" + limit + ")",
          ...sessLines,
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "hz_health",
    description: "DeepSeek Web proxy health (accounts, sessions, config)",
    handler: (ctx: any) => {
      const { accounts, sessions, inFlightRef, agentId } = getRuntime(ctx);
      return {
        text: [
          "**hz_health**",
          `agent: ${agentId}`,
          `config_ready: ${accounts.length > 0}`,
          `accounts: ${accounts.length}`,
          `ready: ${accounts.filter(a => a.cooldownUntil <= Date.now()).length}`,
          `sessions: ${sessions.size}`,
          `in_flight: ${inFlightRef.value}`,
          "",
          ...accounts.map(a => {
            const r = Math.max(0, Math.ceil((a.cooldownUntil - Date.now()) / 1000));
            return `  ${a.name}: ${a.cooldownUntil > Date.now() ? `⏳ cd ${r}s` : "✅"} (${a.failures} errors)`;
          }),
        ].join("\n"),
      };
    },
  });

  api.registerCommand({
    name: "hz_models",
    description: "List OpenAI-compatible model aliases",
    handler: () => ({
      text: ["**hz_models**", ...SUPPORTED_MODELS.map(id => `  \`${id}\` → ${MODEL_CONFIGS[id].real_model}`)].join("\n"),
    }),
  });

  api.registerCommand({
    name: "hz_capabilities",
    description: "Full alias → real model → capabilities map",
    handler: () => ({
      text: [
        "**hz_capabilities**",
        ...SUPPORTED_MODELS.map(id => {
          const mc = MODEL_CONFIGS[id];
          return `  \`${id}\` → ${mc.real_model} | type=${mc.model_type} thinking=${mc.thinking_enabled} search=${mc.search_enabled} ctx=${mc.contextWindow} max=${mc.maxTokens}`;
        }),
      ].join("\n"),
    }),
  });

  api.registerCommand({
    name: "hz_sessions",
    description: "List active local agent sessions",
    handler: (ctx: any) => {
      const { accounts, sessions, persisted, agentId } = getRuntime(ctx);
      const accountName = (id: string | null) => {
        const a = accounts.find(x => x.id === id);
        return a ? a.name : (id || "-");
      };
      const accLines = accounts.map(a => {
        const r = Math.max(0, Math.ceil((a.cooldownUntil - Date.now()) / 1000));
        return `  ${a.name}: ${a.cooldownUntil > Date.now() ? `cd ${r}s` : "ready"} (${a.failures} err)`;
      });
      if (sessions.size === 0) return { text: [`**hz_sessions** (agent ${agentId}): (none)`, "", "accounts:", ...accLines].join("\n") };
      const now = Date.now();
      const lines = [...sessions.entries()].map(([key, s]) => {
        const age = s.createdAt ? Math.round((now - s.createdAt) / 1000) : 0;
        const persistedFlag = persisted.sessions[key] ? "persisted" : "memory";
        return `  ${key} | msgs=${s.messageCount} | account=${accountName(s.accountId)} | id=${s.id || "-"} | age=${age}s | ${persistedFlag}`;
      });
      return { text: [`**hz_sessions** (agent ${agentId}, survives restart)`, ...lines, "", "accounts:", ...accLines].join("\n") };
    },
  });

  api.registerCommand({
    name: "hz_reset_session",
    description: "Reset one session (agent=<id>) or all (agent=all)",
    acceptsArgs: true,
    handler: (ctx: any) => {
      const { sessions, persist } = getRuntime(ctx);
      const raw = argText(ctx);
      const m = raw.match(/agent=(\S+)/);
      let target = m ? m[1] : "";
      if (!target && raw.trim() === "all") target = "all";
      if (!target) return { text: "Usage: hz_reset_session agent=<session-key>|all" };
      if (target === "all") {
        const n = sessions.size;
        sessions.clear();
        persist();
        return { text: `Reset all sessions for this agent (${n})` };
      }
      if (!sessions.has(target)) return { text: `Unknown session: ${target} (nothing changed)` };
      sessions.delete(target);
      persist();
      return { text: `Reset session: ${target}` };
    },
  });

  api.registerCommand({
    name: "hz_reset_account",
    description: "Reset account cooldown/failures (name=<file>|all)",
    acceptsArgs: true,
    handler: (ctx: any) => {
      const { accounts, persist } = getRuntime(ctx);
      const raw = argText(ctx);
      const m = raw.match(/name=(\S+)/);
      const target = m ? m[1] : "";
      if (!target) return { text: "Usage: hz_reset_account name=<file>|all" };
      if (target === "all") {
        for (const a of accounts) { a.cooldownUntil = 0; a.failures = 0; }
        persist();
        return { text: `Reset all accounts for this agent (${accounts.length})` };
      }
      const acc = accounts.find(a => a.name === target || a.id === target);
      if (!acc) return { text: `Unknown account: ${target}` };
      acc.cooldownUntil = 0; acc.failures = 0;
      persist();
      return { text: `Reset account: ${acc.name}` };
    },
  });

  api.registerCommand({
    name: "hz_doctor",
    description: "Diagnose auth files (offline by default; pass 'live' for PoW check)",
    acceptsArgs: true,
    handler: (ctx: any) => runDoctor(ctx),
  });

  api.registerCommand({
    name: "hz_followup",
    description: "Enable/disable minimal follow-up prompt (true|false)",
    acceptsArgs: true,
    handler: (ctx: any) => {
      const v = argText(ctx).trim().toLowerCase();
      if (v !== "true" && v !== "false") return { text: "Usage: hz_followup true|false" };
      process.env.HORIZON_MINIMAL_FOLLOWUP = v === "true" ? "1" : "0";
      return { text: `hz_followup: ${v} (default: on)` };
    },
  });

  api.registerCommand({
    name: "hz_log",
    description: "info-логи плагина horizon_v8: on|off|status (default: off; warn/error всегда)",
    acceptsArgs: true,
    handler: (ctx: any) => {
      const v = argText(ctx).trim().toLowerCase();
      if (v === "on" || v === "true" || v === "1") {
        setInfoLogging(true);
        mylog("warn", "[horizon_v8] info-логи включены (hz_log on)");
        return { text: "hz_log: on — info-логи пишутся в журнал OpenClaw; warn/error всегда включены." };
      }
      if (v === "off" || v === "false" || v === "0") {
        mylog("warn", "[horizon_v8] info-логи выключены (hz_log off)");
        setInfoLogging(false);
        return { text: "hz_log: off — info-логи заглушены; warn/error всегда включены." };
      }
      if (v === "" || v === "status") {
        return { text: `hz_log: ${isInfoLogging() ? "on" : "off"} (default: off; warn/error всегда)` };
      }
      return { text: "Usage: hz_log on|off|status" };
    },
  });
}
