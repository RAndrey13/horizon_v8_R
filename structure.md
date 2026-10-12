# horizon_v8 — карта модулей (шпаргалка для агента)

Провайдер DeepSeek Web API для OpenClaw: PoW, сессии, стриминг, tool-calls.
Собран из монолита `index.ts` (642 стр.) в 14 модулей. Точка входа — `dist/index.js` (из `src/index.ts`).

## Поток запроса

```
api.registerProvider -> createStreamFn(stream.ts)
  stream.ts -> sanitize.ts (сборка промпта) -> client.ts (HTTP к chat.deepseek.com)
    client.ts -> pow.ts (решение PoW-челленджа)
  ответ -> parser.ts -> toolparse.ts (поиск/парсинг tool-call) -> SSE-события в OpenClaw
  аккаунт/сессия: accounts.ts (selectAccount) + sessions.ts (getSession/persist)
```

## Модули и их экспорты

| Файл | Назначение | Экспорты |
|---|---|---|
| `index.ts` | Точка входа, `definePluginEntry`, `register(api)`: загрузка аккаунтов/стейта, `registerProvider`, `registerModelCatalogProvider`, `registerCommands` | `default` |
| `types.ts` | Все интерфейсы/типы | `AccountConfig, SessionState, Account, ModelConfig, TruncateSpec, ChatWindowHistoryEntry, PersistedAccountState, PersistedSessionState, PersistedState` |
| `env.ts` | ENV-флаги и константы усечения/стриппинга | `envBool, STRIP_CHAT_WINDOW, RUNTIME_CONTEXT_MARKERS, CHAT_WINDOW_START_MARKERS, RUNTIME_CONTEXT_END_MARKER, stripInternalContextMarkers, indexOfAny, includesAny, RESTORE_HISTORY, DEFAULT_ASSISTANT_SENDERS, ASSISTANT_SENDER_SET, TIME_TOKEN_RE, EXTRA_SYSTEM_FILES, SMART_TRUNCATE, BASE_TRUNCATE_SPECS, DEFAULT_TRUNCATE_SPEC, TRUNCATE_SPECS` |
| `accounts.ts` | Загрузка auth-файлов, HTTP-заголовки, проверка живости, RR-выбор, кулдауны | `discoverAuthPaths, buildBaseHeaders, loadAccounts, checkAuthFile, liveCheck, markAccountFailure, markAccountSuccess, selectAccount` |
| `sessions.ts` | Персистентный стейт (accounts+sessions) на диске | `statePath, loadState, saveStateSync, deriveSessionKey, getSession, saveStateNow` |
| `models.ts` | Каталог моделей и usage-хелперы | `MODEL_CONFIGS, SUPPORTED_MODELS, estimateTokens, makeEmptyUsage, buildUsage, makeEmptyPartial` |
| `sanitize.ts` | Сборка промпта: нормализация, форматирование, обрезка; санитария minimal-хвоста | `normalizeMessageContent, formatMessages, formatLastTurn, sanitizeMinimalTail, cleanMinimalPrompt, stripOpenClawContextBlock, MAX_UPSTREAM_PROMPT_CHARS, truncatePromptMiddle` |
| `parser.ts` | Стриминговые хелперы + публичный API парсинга | `findToolCallStart, findToolCallStartBroad, isJsonStartText, isToolCallJsonStart, looksLikeToolCallPrefix, parseToolCall, parseToolCallAll, normalizeDsmlMarkup, decodeDsmlValue, decodeDsmlParameterValue` |
| `toolparse.ts` | Порт DSML-парсера из FreeDeepseekAPI/server.js | `parseToolCallAll, parseToolCallStrict, normalizeToolMarkupTags, decodeDsmlValue, decodeDsmlParameterValue, ParsedToolCall` |
| `pow.ts` | Решение Proof-of-Work челленджей | `solvePOW, solveFreshPow` |
| `client.ts` | HTTP-вызов DeepSeek Web API | `callDeepSeekWeb` |
| `stream.ts` | `createStreamFn`: SSE/JSON-Patch стриминг, оркестрация | `StreamDeps, createStreamFn` |
| `doctor.ts` | Диагностика аккаунтов | `runDoctor` |
| `commands.ts` | Команды `hz_*` (+`accountName`) | `CommandDeps, registerCommands` |

## Граф зависимостей (нет циклов)

```
index -> accounts, sessions, models, stream, commands
stream -> client, parser, sanitize, models, sessions, accounts
commands -> doctor, models
sanitize -> env
doctor -> accounts
client -> pow
accounts, sessions, models, env -> types
parser -> toolparse
toolparse, pow -> (нет)
```

## Правила

- Относительные импорты — всегда с `.js` (ESM).
- Аккаунты RR-выбираются `selectAccount`; при ошибке — `markAccountFailure` (кулдаун), успех — `markAccountSuccess`.
- Состояние пишется `saveStateNow(accounts, sessions)` через `persist` в `index.ts`.
- Tool-call: `toolparse.ts` парсит DSML/JSON/XML, `parser.ts` режет текст, `stream.ts` эмитит tool-call-события по каждому вызову (N вызовов = N событий), исполнение — на стороне OpenClaw.
- Промпт-формирующие модули (`sanitize/parser/client/pow/env/types`) при рефакторинге не менять без проверки `sha256(prompt)`.


### Minimal follow-up (horizon_v8)

На повторных ходах web-сессии (`parentMessageId > 0` и в `messages` уже есть ответ
ассистента) при `HORIZON_MINIMAL_FOLLOWUP=1` уходит только новый ввод:

- Хвост строит `formatLastTurn(context.messages)` — структурно: последний `toolResult`/`tool`
  → `Observation (<tool>): <content>`, иначе текст последнего `user`. Текстовый фолбэк
  по `lastIndexOf("\nUser: ")` удалён.
- Санитарию хвоста делает `sanitizeMinimalTail()` (в конце `formatLastTurn`): вырезает
  `<<<BEGIN/END_OPENCLAW_INTERNAL_CONTEXT>>>` (включая экранированные `[[...]]` и незакрытые),
  заголовки `Conversation info/context`, `Conversation data`, `Sender (untrusted metadata)`,
  `Active exec sessions`/`Active Subagents`, ведущую дату `[<ISO> GMT+..]`.
- Гейт: `flag==1 && hasParent && hasAssistant && minimalPrompt не пуст`; иначе full.
- Диагностика: `minRaw`/`minClean` в логе; дампы `/root/horizon_v8_request.log` (mode) и
  `/root/horizon_v8_request_full.log`.

### Session key (horizon_v8)

`deriveSessionKey(agentDir, sid) = sid || agentDir || "default"`, где `sid` = id модели.
Поэтому ключ выводится из `chat_id` сообщения: `sessionKey = conv:<chat_id>`
(fallback — `deriveSessionKey`). Иначе все чаты делят одну сессию и `parentMessageId`
переживает смену чата -> первый ход уходит minimal. См. `src/stream.ts` (перед `getSession`).
