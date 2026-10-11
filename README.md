# Horizon V8 🌅

Кастомный model provider для OpenClaw. Замена внешнего HTTP-прокси (FreeDeepseekAPI).
Предоставляет несколько бэкендов через единый OpenAI-совместимый endpoint на localhost.

> **Fork note (RAndrey13).** This is the upstream project by
> [amalkovich1](https://github.com/amalkovich1/horizon_v8) with local fixes
> applied on top (see [Fixes in this fork](#fixes-in-this-fork) below).
> Upstream license: MIT.

## Fixes in this fork

Fixes for the DeepSeek Web wrapper. The first two are contributed upstream as
[pull request #34](https://github.com/amalkovich1/horizon_v8/pull/34):

### 1. `stream`: never emit reasoning as visible text

The safety-net fallback set `textContent = reasoningContent`. When the model
produced only reasoning and no visible content, internal reasoning leaked into
the chat as a normal reply (service info breaking the dialogue). Reasoning now
goes only to the thinking block; if there is no visible content, the reply is
left empty.

Files: `src/stream.ts`

### 2. `sanitize`: drop legacy "TOOL REQUEST SYSTEM" framing

Removed the legacy framing (`ONLY REASONS and REQUESTS tool executions`, the
`RULES` block, the local-gateway wording, and the
`--- TOOL REQUEST SYSTEM ---` delimiters) that made the model emit protocol
text instead of a normal reply. **Tool schemas are preserved**, so tool calls
keep working.

Files: `src/sanitize.ts`

### 3. `diag`: reproducible, opt-in diagnostics

The built `dist/` used to carry a hand-written probe that wrote every raw model
response to a hardcoded absolute path - and was absent from `src/`, so a clean
`tsc` build silently dropped it. It is now a proper module, `src/diag.ts`,
invoked from `src/stream.ts` and gated by `HORIZON_RAWTC_DIAG` (off by default,
auto-trimmed). The request/compact/raw dumps no longer fall back to a
Linux-only `/root/...` path.

Files: `src/diag.ts`, `src/stream.ts`, `src/client.ts`, `src/sanitize.ts`

### 4. `models`: enable DeepSeek Web search on all aliases

`search_enabled` is now `true` for every alias (`deepseek-chat`,
`deepseek-default`, `deepseek-reasoner`, `deepseek-expert`, `deepseek-v4-pro`).

Files: `src/models.ts`

### 5. `stream` / `sanitize`: batch tool calls and assistant thinking

- A multi-call response that named one unavailable tool used to be discarded
  **wholesale** (`toolCalls = []`), so the turn ended as a bogus "invalid
  markup" error - or as a silent empty answer. Unknown calls are now dropped
  individually and every known call is kept.
- Assistant `thinking` blocks were formatted into the prompt as
  `[thinking: ...]`: the model saw its own internal monologue as text and
  continued it (a full prompt echo). Thinking is internal and is no longer
  sent upstream (`formatMessages` and `formatLastTurn`).
- A response with neither visible text nor a tool call now raises a clear error
  instead of finishing with an empty (silent) assistant message.

Files: `src/stream.ts`, `src/sanitize.ts`

## Мотивация

- **FreeDeepseekAPI** — внешний процесс с открытым портом, нестабильный, требует фаервола
- **Мульти-модельность** — DeepSeek (Web + API), Qwen3, Gemini в одном месте
- **Фолбеки** — при ошибке одного бэкенда переключаться на другой
- **Одно конфигурирование** — все провайдеры в openclaw.json

## Структура

```
horizon_v8/
├── openclaw.plugin.json   # манифест плагина
├── package.json
├── tsconfig.json
├── structure.md           # карта модулей (подробная шпаргалка)
├── src/
│   ├── index.ts           # точка входа: definePluginEntry, register(api)
│   ├── types.ts           # общие интерфейсы и типы
│   ├── env.ts             # ENV-флаги, константы усечения/стриппинга
│   ├── agent-scope.ts     # <agentDir>, <agentDir>/accounts, путь state.json
│   ├── accounts.ts        # загрузка auth, HTTP-заголовки, RR-выбор, кулдауны
│   ├── sessions.ts        # персистентный стейт (accounts + sessions)
│   ├── registry.ts        # решение OpenClaw-сессия -> web-чат (new/continue/recreate)
│   ├── runtime.ts         # per-agent рантайм (аккаунты + сессии)
│   ├── models.ts          # каталог моделей, usage-хелперы
│   ├── sanitize.ts        # сборка промпта: нормализация/формат/обрезка
│   ├── parser.ts          # публичный API парсинга tool-call
│   ├── toolparse.ts       # порт DSML-парсера (server.js)
│   ├── pow.ts             # решение Proof-of-Work челленджей
│   ├── client.ts          # HTTP-вызов DeepSeek Web API
│   ├── stream.ts          # createStreamFn: SSE/JSON-Patch стриминг
│   ├── doctor.ts          # диагностика аккаунтов
│   └── commands.ts        # команды hz_*
└── dist/                  # скомпилированный JS (ESM)
```

## Архитектура

```
┌─────────────────────────────────────────┐
│              OpenClaw Gateway            │
│  ┌─────────────────────────────────┐   │
│  │         Horizon V8 Plugin        │   │
│  │  ┌───────────┐  ┌────────────┐ │   │
│  │  │  Router    │  │ Local HTTP │ │   │
│  │  │  Models    │◄─┤ Server     │ │   │
│  │  │  Fallbacks │  │ :random    │ │   │
│  │  └─────┬─────┘  └─────┬──────┘ │   │
│  │        │               │        │   │
│  │  ┌─────▼───────────────▼──┐    │   │
│  │  │     Provider Layer      │    │   │
│  │  │  deepseek-web │ qwen    │    │   │
│  │  │  deepseek-api │ gemini  │    │   │
│  │  └─────┬──────────┬───────┘    │   │
│  └────────┼──────────┼────────────┘   │
└───────────┼──────────┼────────────────┘
            │          │
   ┌────────▼──┐ ┌─────▼────────┐
   │  DeepSeek  │ │  Qwen/Gemini │
   │  Web API   │ │  API (future)│
   │ (PoW/WASM) │ │              │
   └────────────┘ └──────────────┘
```

## Установка

```bash
# 1. Клонировать
git clone git@github.com:amalkovich1/horizon_v8.git /srv/git/horizon_v8

# 2. Установить зависимости
cd /srv/git/horizon_v8
ln -sf /home/admin/.npm-global/lib/node_modules/openclaw node_modules/openclaw

# 3. Собрать
npx tsc

# 4. Скопировать в extensions
cp -a /srv/git/horizon_v8 /home/admin/.openclaw/extensions/horizon_v8

# 5. Добавить в openclaw.json
```

## Конфигурация

Запись плагина в `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "horizon_v8": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true,
          "allowConversationAccess": true,
          "timeouts": { "before_prompt_build": 5000 }
        },
        "config": {
          "promptOverride": {
            "enabled": true,
            "targetAgents": ["main", "pythia"],
            "userFile": "USER.md"
          }
        }
      }
    },
    "allow": ["horizon_v8"]
  }
}
```

`promptOverride` (бывший `prism_v8`) заменяет системный промпт указанным агентам:
читает `userFile` из воркспейса агента (путь резолвится из hook-контекста).

### Переменные окружения

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `HORIZON_STATE_PATH` | явный путь `state.json` (перекрывает per-agent) | — |
| `HORIZON_TOKEN_LIMIT` | порог ротации web-сессии по токенам DeepSeek | `120000` |
| `HORIZON_COOLDOWN_SEC` | база cooldown аккаунта при ошибке | `300` |
| `HORIZON_MAX_SESSION_MSGS` | предохранитель по числу сообщений | `0` (выкл) |
| `HORIZON_COMPACT_THRESHOLD` | доля от лимита для превентивного компакта | `0.85` |
| `HORIZON_MINIMAL_FOLLOWUP` | минимальный follow-up промпт (1/0) | `1` (вкл) |
| `HORIZON_STRIP_CHAT_WINDOW` | вырезать блок «Conversation context» | `1` |
| `HORIZON_RESTORE_HISTORY` | восстанавливать историю при потере сессии | `1` |
| `HORIZON_SMART_TRUNCATE` | сжатие Observation | `1` |
| `HORIZON_EXTRA_SYSTEM_FILES` | доп. файлы в system (через `:`) | — |
| `HORIZON_THROTTLE_MIN_MS` / `_MAX_MS` | нижняя/верхняя граница паузы между запросами | `2000` / `5000` |
| `DEEPSEEK_AUTH_DIR` / `DEEPSEEK_AUTH_PATH` | fallback-источник аккаунтов | — |

## Модели

| Алиас | real_model | Reasoning | Контекст |
|---|---|---|---|
| `deepseek-chat` | DeepSeek V4 Flash | ❌ | 131072 |
| `deepseek-default` | DeepSeek V4 Flash | ❌ | 131072 |
| `deepseek-reasoner` | DeepSeek V4 Flash Thinking | ✅ | 131072 |
| `deepseek-expert` | DeepSeek Web Expert | ❌ | 131072 |
| `deepseek-v4-pro` | DeepSeek Expert Thinking | ✅ | 131072 |

## Команды

Все команды per-agent: работают с аккаунтами и сессиями вызывающего агента.

- `/horizon_status` — статус: агент, аккаунты (cooldown/ошибки), число сессий, список моделей.
- `/hz_commands` — меню всех `hz_*` команд.
- `/hz_health` — здоровье прокси: аккаунты (ready/total), сессии, in-flight.
- `/hz_models` — список алиасов моделей.
- `/hz_capabilities` — alias -> real model -> capabilities (type/thinking/search/ctx/max).
- `/hz_sessions` — активные сессии агента + блок `accounts:` (имя, cooldown, число ошибок).
- `/hz_registry` — реестр сессий: key, web id, turns, токены, решение (new/continue/recreate).
- `/hz_reset_session agent=<key>|all` — сбросить одну сессию или все.
- `/hz_reset_account name=<file>|all` — сбросить cooldown/ошибки аккаунта.
- `/hz_readyz` — готовность: сколько аккаунтов ready.
- `/hz_doctor [live]` — диагностика auth-файлов (offline; `live` — PoW-проверка).
- `/hz_followup true|false` — минимальный follow-up промпт (по умолчанию on).

## Аккаунты и сессии

### Аккаунты

Аккаунты DeepSeek хранятся **по агентам**: `<agentDir>/accounts/*.json` — каждый файл это отдельный аккаунт.
Файл состояния — `<agentDir>/accounts/state.json` (в список аккаунтов не входит). Каталог создаётся автоматически.

Fallback (только если `<agentDir>/accounts` не существует): `DEEPSEEK_AUTH_DIR` / `DEEPSEEK_AUTH_PATH`, затем legacy `deepseek-auth.json` рядом с плагином.

Выбор аккаунта — sticky: сессия держится за своим (`session.accountId`). При ошибке аккаунт уходит в cooldown (экспоненциальный backoff: база `HORIZON_COOLDOWN_SEC`, кап 30 мин) и берётся следующий; успешный запрос сбрасывает счётчик ошибок и cooldown.

### Сессии

Состояние web-сессий переживает перезапуск. Путь: `HORIZON_STATE_PATH` (если задан) → `<agentDir>/accounts/state.json` → legacy `<dist>/state.json`.

Ключ сессии выводится из `agentDir` (`<seg>::session`, где `seg` — последние два сегмента пути). Для ключа хранится web-`chat_session_id`, `parent_message_id`, счётчики `turns`/`messageCount`, `tokensOpenclaw` (оценка) и `tokensDeepseek` (авторитетный счётчик из SSE), `accountId`, ошибки.

Web-сессия пересоздаётся, когда:

- `tokensDeepseek` достигает `HORIZON_TOKEN_LIMIT` (по умолчанию `120000`);
- сервер вернул ошибку недействительной сессии;
- произошла смена аккаунта;
- опционально по числу сообщений (`HORIZON_MAX_SESSION_MSGS`, по умолчанию выключено).

## Разработка

### Добавление нового провайдера

Создать класс, имплементирующий `ProviderHandler`:

```typescript
class MyProvider implements ProviderHandler {
  async *complete(messages, model, stream) {
    yield { type: "delta", content: "..." };
    yield { type: "done", finish: "stop" };
  }
}
```

Зарегистрировать в `register()`:

```typescript
providers.set("my-provider", new MyProvider(config));
```

Добавить модель в конфиг:

```json
{
  "models": {
    "my-model": { "id": "my-model", "name": "...", "provider": "my-provider" }
  }
}
```

## Лицензия

MIT


## Minimal follow-up (HORIZON_MINIMAL_FOLLOWUP)

Повторные ходы web-сессии DeepSeek отправляют наверх только новый ввод — текст
пользователя либо Observation инструмента — без System/tools/runtime/истории
(экономия ~99% символов: десятки–сотни вместо десятков тысяч). Первый ход
(или после recreate) всегда полный.

- Вкл/выкл: `/hz_followup true|false` -> env `HORIZON_MINIMAL_FOLLOWUP=1|0`.
  Плагин выставляет `1` при старте, если флаг не задан (minimal ON по умолчанию);
  `/hz_followup false` возвращает полный промпт.
- Хвост строится **структурно** из `context.messages` функцией `formatLastTurn()`:
  последнее сообщение `toolResult`/`tool` -> только `Observation (<tool>): <content>`;
  иначе только текст последнего `user`. Текстовый фолбэк по `fullPrompt.lastIndexOf("\nUser: ")`
  удалён.
- Условие minimal: `flag==1 && hasParent && hasAssistant && minimalPrompt не пуст`,
  где `hasParent` = `session.parentMessageId > 0`, `hasAssistant` = в `messages` есть
  ответ ассистента. Гейт по состоянию web-сессии, а не по непустоте `context.messages`.
- Санитария хвоста: `sanitizeMinimalTail()` вырезает `<<<BEGIN/END_OPENCLAW_INTERNAL_CONTEXT>>>`
  (в т.ч. экранированные `[[...]]` и незакрытые), заголовки `Conversation info/context`,
  `Conversation data`, `Sender (untrusted metadata)`, `Active exec sessions`/`Active Subagents`,
  ведущую дату `[<ISO> GMT+..]`; пустой хвост -> `""` (ход уходит full).
- Диагностика: в лог пишутся `minRaw` (до санитарии) и `minClean` (после) + `useMinimal`.
- Дамп запроса (по желанию): задайте `HORIZON_REQUEST_LOG=<path>` — туда пишется фактический
  prompt + `mode` = full|minimal + все поля POST. Без переменной дамп не пишется (раньше молча
  пытался писать в `/root/...`). Логирование обёрнуто в try/catch.
- Ключ horizon-сессии: `conv:<chat_id>` (берётся из ctx-блока сообщения), иначе
  `deriveSessionKey(agentDir, sid)`.
- `parent_message_id` уходит числом (DeepSeek ждёт u32; строка -> 422).

## Parallel tool calls

Один ход модели может содержать несколько tool call. Плагин распознаёт **все**
вызовы и эмитит по одному событию на каждый:

- `parseToolCallAll(text)` (`toolparse.ts`, реэкспорт из `parser.ts`) возвращает
  массив всех вызовов в порядке появления; `parseToolCall` — тонкая обёртка над
  первым элементом (обратная совместимость).
- `stream.ts` эмитит `toolcall_start`/`toolcall_end` в цикле, с уникальным `tcId`
  на каждый вызов и инкрементом `contentIndex`; итоговое `message.content`
  содержит N блоков `toolCall`, `stopReason: toolUse`.
- Хвост minimal-промпта (`formatLastTurn`) собирает **весь** непрерывный прогон
  `toolResult` -> Observation по каждому результату; кросс-чек по `toolCallId`
  логирует `tail obs round calls=N results=N unmatched=0 unanswered=0` и WARN
  только при реальном расхождении.
- Граница-индекс отправленного массива намеренно **не** вводится: сверка по
  `toolCallId` надёжнее и не ломается при пересборке/обрезке массива.

## Real usage (accumulated_token_usage)

Счётчик токенов берётся из SSE-потока DeepSeek на каждом ходу
(`streamAccumulatedUsage` -> `buildUsage(prompt, content, reasoning, accumulated,
previousAccumulated)`), а не из периодического запроса `history_messages`.

- При `accumulated != null`: `totalTokens = accumulated` (авторитетно, совпадает
  с UI DeepSeek), `input = max(0, delta - outEst)`, `output = outEst` (оценка).
- Фолбэк (ход без счётчика, напр. пустой/оборванный): `input` оценивается по
  промпту, а `contextUsage` держится на последнем известном `accumulated` — иначе
  кольцо схлопывалось бы на коротком follow-up-промпте.
- `contextUsage.promptTokens = accumulated` (контекст всей сессии DeepSeek, для
  кольца UI), `contextUsage.totalTokens = accumulated + outEst` (бюджет
  preflight-компакта ядра); инвариант `totalTokens >= promptTokens` соблюдён.
- При `accumulated <= 0` `contextUsage` не эмитится.
