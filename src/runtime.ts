// ---------------------------------------------------------------------------
// Runtime (DYNAMIC) block for horizon_v8
//
// • Собирает хвост промпта: закрывает STABLE, ставит cache-boundary, открывает
//   DYNAMIC с реальным рантаймом (agent/session/sessionId/host/...).
// • Значения ВСЕГДА пересобираем сами (ctx/context/env/model/os) — поэтому в
//   вывод не попадают ни [object Object], ни чужой agent=main.
// • Из готового блока ядра берём только те поля, которые сами не знаем:
//   session/sessionId/channel/capabilities/repo/host/agent.
// • stripRuntimeMarkers() вырезает из системного промпта дублирующие маркеры
//   и старый блок "## Runtime", чтобы наш хвост был единственным.
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";

export interface RuntimeBlockInput {
  sid?: string;
  systemPrompt?: string;
  messages?: any[];
  ctx?: any;
  context?: any;
}

/** Приводит значение к строке. Объекты (model и т.п.) разворачивает в строку. */
function asString(v: any): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") {
    const s = v.trim();
    return s === "[object Object]" ? "" : s;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object") {
    const id = v.id ?? v.model ?? v.name ?? v.slug ?? v.value;
    const provider = v.provider ?? v.providerId;
    if (id !== undefined && provider !== undefined && !String(id).includes("/")) {
      return (String(provider) + "/" + String(id)).trim();
    }
    if (id !== undefined) return String(id).trim();
  }
  return "";
}

function firstNonEmpty(...vals: any[]): string {
  for (const v of vals) {
    const s = asString(v);
    if (s) return s;
  }
  return "";
}

function messageText(m: any): string {
  const c = m && m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
  return "";
}

// --- маркеры, которые надо вычистить из входящего промпта -------------------
const CLOSE_STABLE_RE = /^[ \t]*<!--[ \t]*\/openclaw:attempt:STABLE[ \t]*-->[ \t]*$/i;
const DYNAMIC_MARKER_RE = /^[ \t]*<!--[ \t]*\/?openclaw:attempt:DYNAMIC[ \t]*-->[ \t]*$/i;
const BOUNDARY_RE = /^[ \t]*<!--[ \t]*OPENCLAW_CACHE_BOUNDARY[ \t]*-->[ \t]*$/i;
const RUNTIME_HEADING_RE = /^[ \t]*##[ \t]+Runtime[ \t]*$/;
const RUNTIME_BODY_RE = /^[ \t]*(?:Runtime:|Current model identity:|Reasoning=)/;

function isStrippableMarker(line: string): boolean {
  return CLOSE_STABLE_RE.test(line) || DYNAMIC_MARKER_RE.test(line) || BOUNDARY_RE.test(line);
}

/**
 * Убирает из текста дублирующие маркеры STABLE/DYNAMIC/cache-boundary и старый
 * блок "## Runtime ...". Открывающий `<!-- openclaw:attempt:STABLE -->` НЕ трогаем:
 * его ставит пользовательский системный промт в самом начале.
 */
export function stripRuntimeMarkers(text?: string): string {
  if (!text) return "";
  const lines = String(text).split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isStrippableMarker(line)) { i++; continue; }
    if (RUNTIME_HEADING_RE.test(line)) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      if (j < lines.length && RUNTIME_BODY_RE.test(lines[j])) {
        i++; // пропускаем заголовок
        while (i < lines.length) {
          const l = lines[i];
          if (isStrippableMarker(l) || RUNTIME_BODY_RE.test(l) || l.trim() === "") { i++; continue; }
          break;
        }
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Вырезает готовый runtime-блок из текста (от "## Runtime" до закрывающего маркера). */
export function extractRuntimeBody(text?: string): string | null {
  if (!text) return null;
  const i = text.indexOf("Runtime: agent=");
  if (i < 0) return null;
  let start = i;
  const head = text.lastIndexOf("## Runtime", i);
  if (head >= 0 && i - head < 200) start = head;
  const endMarker = text.indexOf("<!-- /openclaw:attempt:DYNAMIC -->", i);
  let body = endMarker >= 0 ? text.slice(start, endMarker) : text.slice(start).split("\n").slice(0, 3).join("\n");
  body = body.replace(/\s+$/, "");
  return body || null;
}

/** Разбирает строку "Runtime: a=b | c=d | ..." в map (пропуская мусор). */
function parseRuntimeLine(body?: string | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (!body) return map;
  const m = /Runtime:\s*([^\n]+)/.exec(body);
  if (!m) return map;
  for (const seg of m[1].split("|")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (k && v && v !== "[object Object]") map[k] = v;
  }
  const r = /Reasoning=([^;\n]+)/.exec(body);
  if (r) {
    const rv = r[1].trim();
    if (rv && rv !== "[object Object]") map.reasoning = rv;
  }
  return map;
}

function deriveAgent(ctx: any, context: any, sessionKey: string, repo: string): string {
  const direct = firstNonEmpty(ctx?.agentId, ctx?.agent, context?.agentId, context?.agent);
  if (direct) return direct;
  const m1 = /^agent:([^:]+)/.exec(sessionKey || "");
  if (m1) return m1[1];
  const m2 = /\/agents\/([^/]+)/.exec(String(repo || ""));
  if (m2) return m2[1];
  return "";
}

/** Собирает значения полей из ctx/context/env/model/os. */
function computeFields(input: RuntimeBlockInput, coreMap: Record<string, string>): Record<string, string> {
  const env = process.env;
  const ctx = input.ctx || {};
  const context = input.context || {};
  const rt = (context.runtime || context.runtimeInfo) || (ctx.runtime || ctx.runtimeInfo) || {};

  const sid = firstNonEmpty(input.sid);
  const sessionKey = firstNonEmpty(
    rt.session, rt.sessionKey, context.sessionKey, ctx.sessionKey,
    env.OPENCLAW_SESSION_KEY, coreMap.session,
  );
  const repo = firstNonEmpty(
    rt.repo, ctx.agentDir, ctx.workspaceDir, context.agentDir, context.workspaceDir,
    env.OPENCLAW_REPO, process.cwd(), coreMap.repo,
  );

  const f: Record<string, string> = {};
  f.agent = firstNonEmpty(
    rt.agent, rt.agentId, env.OPENCLAW_AGENT_ID,
    deriveAgent(ctx, context, sessionKey, repo),
    coreMap.agent,
    "main",
  );
  f.session = sessionKey;
  f.sessionId = firstNonEmpty(rt.sessionId, context.sessionId, ctx.sessionId, env.OPENCLAW_SESSION_ID, coreMap.sessionId);
  f.host = firstNonEmpty(rt.host, env.OPENCLAW_HOST, coreMap.host, os.hostname());
  f.repo = repo;
  f.os = firstNonEmpty(rt.os, coreMap.os, os.type() + " " + os.release() + " (" + os.arch() + ")");
  f.node = firstNonEmpty(rt.node, coreMap.node, process.version);
  f.model = firstNonEmpty(
    rt.model, context.model, ctx.model, env.OPENCLAW_MODEL,
    sid ? "horizon_v8/" + sid : "",
  );
  f.default_model = firstNonEmpty(
    rt.defaultModel, rt.default_model, context.defaultModel, context.default_model,
    env.OPENCLAW_DEFAULT_MODEL, f.model,
  );
  f.shell = firstNonEmpty(rt.shell, coreMap.shell, path.basename(env.SHELL || "bash"));

  let channel = firstNonEmpty(rt.channel, context.channel, ctx.channel, env.OPENCLAW_CHANNEL, coreMap.channel);
  if (!channel) {
    const parts = String(sessionKey || "").split(":");
    if (parts[0] === "agent" && parts.length >= 3) channel = parts[2];
  }
  f.channel = channel;
  f.capabilities = firstNonEmpty(
    rt.capabilities, context.capabilities, ctx.capabilities,
    env.OPENCLAW_CAPABILITIES, coreMap.capabilities,
  );
  f.reasoning = firstNonEmpty(rt.reasoning, context.reasoning, ctx.reasoning, coreMap.reasoning, "off");
  return f;
}

const ORDER = [
  "agent", "session", "sessionId", "host", "repo", "os", "node",
  "model", "default_model", "shell", "channel", "capabilities",
];

function renderBody(f: Record<string, string>): string {
  const line = ORDER.filter((k) => f[k]).map((k) => k + "=" + f[k]).join(" | ");
  let body = "## Runtime\n";
  body += "Runtime: " + line + "\n";
  if (f.model) {
    body += "Current model identity: " + f.model +
      ". If asked what model you are, answer with this value for the current run.\n";
  }
  body += "Reasoning=" + (f.reasoning || "off") +
    "; hidden unless on/stream. Toggle /reasoning; /status shows when enabled.";
  return body;
}

/** Полный хвост: /STABLE + cache-boundary + DYNAMIC-блок рантайма + /DYNAMIC. */
export function buildRuntimeBlock(input: RuntimeBlockInput = {}): string {
  // Готовый блок ядра (если есть) — источник только тех полей, что мы не знаем.
  let core: string | null = extractRuntimeBody(input.systemPrompt);
  if (!core) {
    for (const m of input.messages || []) {
      core = extractRuntimeBody(messageText(m));
      if (core) break;
    }
  }
  const coreMap = parseRuntimeLine(core);
  const f = computeFields(input, coreMap);

  return (
    "\n<!-- /openclaw:attempt:STABLE -->\n" +
    "<!-- OPENCLAW_CACHE_BOUNDARY -->\n" +
    "<!-- openclaw:attempt:DYNAMIC -->\n" +
    renderBody(f).trimEnd() + "\n" +
    "<!-- /openclaw:attempt:DYNAMIC -->\n"
  );
}
