// ---------------------------------------------------------------------------
// Models: configs, catalog, token/usage estimation helpers
// ---------------------------------------------------------------------------

import type { ModelConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Model configs
// ---------------------------------------------------------------------------

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  "deepseek-chat":     { model_type: "default", thinking_enabled: false, search_enabled: false, real_model: "DeepSeek V4 Flash",         contextWindow: 131072, maxTokens: 8192,  reasoning: false },
  "deepseek-default":  { model_type: "default", thinking_enabled: false, search_enabled: false, real_model: "DeepSeek V4 Flash",         contextWindow: 131072, maxTokens: 8192,  reasoning: false },
  "deepseek-reasoner": { model_type: "default", thinking_enabled: true,  search_enabled: false, real_model: "DeepSeek V4 Flash Thinking", contextWindow: 131072, maxTokens: 8192,  reasoning: true  },
  "deepseek-expert":   { model_type: "expert",  thinking_enabled: false, search_enabled: false, real_model: "DeepSeek Web Expert",       contextWindow: 131072, maxTokens: 8192,  reasoning: false },
  "deepseek-v4-pro":   { model_type: "expert",  thinking_enabled: true,  search_enabled: false, real_model: "DeepSeek Expert Thinking",  contextWindow: 131072, maxTokens: 8192,  reasoning: true  },
};

export const SUPPORTED_MODELS = Object.keys(MODEL_CONFIGS);


export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function makeEmptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

export function buildUsage(prompt: string, content: string, reasoningContent = "", accumulated = null as number | null, previousAccumulated = 0) {
  const ct = estimateTokens(content);
  const rt = estimateTokens(reasoningContent);
  const outEst = ct + rt;
  const prev = Number.isFinite(previousAccumulated) && previousAccumulated > 0 ? previousAccumulated : 0;
  // Context snapshot: DeepSeek Web keeps the whole session server-side, so a
  // single-turn `input` is only a delta and is useless as a context size.
  // Report the session cumulative instead:
  //   contextUsage.promptTokens -> context ring + session totalTokens (UI)
  //   contextUsage.totalTokens  -> preflight-compaction budget
  // Invariant totalTokens >= promptTokens holds (outEst >= 0); core drops the
  // snapshot otherwise. Guarded by > 0 because core rejects promptTokens <= 0,
  // and an `available` snapshot with 0 would blank the session total rather
  // than leaving the previous value in place.
  const makeContextUsage = (contextTokens: number) => contextTokens > 0
    ? { state: "available" as const, promptTokens: contextTokens, totalTokens: contextTokens + outEst }
    : undefined;
  // Option B: real DeepSeek accumulated_token_usage when the SSE stream carries it.
  // accumulated is the session-cumulative counter (matches DeepSeek UI).
  // per-turn input = delta vs previous turn minus the estimated output of this turn;
  // totalTokens = the authoritative cumulative number.
  if (accumulated !== null && Number.isFinite(accumulated) && accumulated >= 0) {
    const delta = Math.max(0, accumulated - prev);
    const input = Math.max(0, delta - outEst);
    const contextUsage = makeContextUsage(accumulated || prev);
    return {
      input, output: outEst, cacheRead: 0, cacheWrite: 0, totalTokens: accumulated,
      ...(contextUsage ? { contextUsage } : {}),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
  }
  // Fallback (stream carried no counter — e.g. an empty/aborted turn): estimate
  // input from the prompt, but keep the context snapshot on the last known
  // cumulative. Without this the ring collapses to the short followup prompt
  // (tens of tokens) for that turn and jumps back on the next one.
  const pt = estimateTokens(prompt);
  const contextUsage = makeContextUsage(prev);
  return {
    input: pt, output: outEst, cacheRead: 0, cacheWrite: 0, totalTokens: pt + outEst,
    ...(contextUsage ? { contextUsage } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function makeEmptyPartial(role: string, model: string): any {
  return { role, content: [], api: "openai-completions", provider: "horizon_v8", model, usage: makeEmptyUsage(), stopReason: "stop", timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// Format messages for DeepSeek Web
// ---------------------------------------------------------------------------




