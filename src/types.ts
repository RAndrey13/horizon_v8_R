// ---------------------------------------------------------------------------
// Shared types for horizon_v8 (leaf module — no imports)
// ---------------------------------------------------------------------------

export interface AccountConfig {
  token: string;
  cookie: string;
  hif_dliq?: string;
  hif_leim?: string;
  wasmUrl?: string;
}

export interface SessionState {
  id: string | null;
  parentMessageId: string | null;
  createdAt: number | null;
  messageCount: number;
  accountId: string | null;
  /** Ключ сессии OpenClaw, по которому найдена/создана эта запись реестра. */
  openclawSessionId: string | null;
  /** Число ходов (turn'ов), обслуженных этой web-сессией. */
  turns: number;
  /** Оценка объёма полного промпта (chars/4), накопленная по ходам. */
  tokensOpenclaw: number;
  /** Авторитетный accumulated_token_usage из DeepSeek (обновляется редко). */
  tokensDeepseek: number;
  /** Когда в последний раз обновлялся tokensDeepseek. */
  tokensRefreshedAt: number | null;
  /** Текст последней ошибки web-сессии ("" — ошибок не было). */
  lastError: string;
  /** Время последней ошибки (0 — не было). */
  lastErrorAt: number;
  /** id web-сессии, признанной ошибочной и пересозданной (null — не было). */
  failedSessionId: string | null;
  /** Сколько compaction-сводок видел этот ключ (детект «компакт только что»). */
  compactions: number;
  /** Текст последней обработанной compaction-сводки (триггер ротации web-сессии). */
  lastCompactionSig: string | null;
  /** Тип модели DeepSeek (chat/expert/...), с которой работает web-сессия. */
  modelType: string | null;
}

export interface Account {
  id: string;
  name: string;
  config: AccountConfig;
  headers: Record<string, string>;
  cooldownUntil: number;
  failures: number;
  lastUsedAt: number;
  /** Время последней ошибки по аккаунту (0 — ошибок не было). */
  lastErrorAt: number;
  /** Тип/текст последней ошибки по аккаунту ("" — ошибок не было). */
  lastError: string;
}

export interface ModelConfig {
  model_type: string;
  thinking_enabled: boolean;
  search_enabled: boolean;
  real_model: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface TruncateSpec {
  head: number;
  tail: number;
}

export interface ChatWindowHistoryEntry {
  sender: string;
  body: string;
}

export interface PersistedAccountState {
  cooldownUntil: number;
  failures: number;
  lastUsedAt: number;
  lastErrorAt: number;
  lastError: string;
}

export interface PersistedSessionState {
  id: string | null;
  parentMessageId: string | null;
  createdAt: number | null;
  messageCount: number;
  accountId: string | null;
  openclawSessionId: string | null;
  turns: number;
  tokensOpenclaw: number;
  tokensDeepseek: number;
  tokensRefreshedAt: number | null;
  lastError: string;
  lastErrorAt: number;
  failedSessionId: string | null;
  /** Сколько compaction-сводок уже учтено для этого ключа. */
  compactions?: number;
  /** Текст последней учтённой compaction-сводки. */
  lastCompactionSig?: string | null;
  /** Тип модели DeepSeek на момент последнего хода. */
  modelType?: string | null;
  updatedAt: number;
}

export interface PersistedState {
  version: number;
  updatedAt: number;
  accounts: Record<string, PersistedAccountState>;
  sessions: Record<string, PersistedSessionState>;
}
