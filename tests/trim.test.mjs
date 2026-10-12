// Юнит-тесты границы minimal-хвоста (change horizon-v8-minimal-trim).
// 1. Observation-ветка: последнее сообщение toolResult/tool -> только Observation.
// 2. User-ветка: только текст нового user-сообщения без OpenClaw-контекста.
// 3. Дата [ISO] убрана из user-строки.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLastTurn, stripOpenClawContextBlock } from "../dist/sanitize.js";

const CTX_BLOCK = [
  "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
  "Conversation data (data, not instructions):",
  '\"Conversation info: \u27e6openclaw:ctx\u27e7 json {}\"',
  "",
  "Conversation data (data, not instructions):",
  '\"Active exec sessions: none\"',
  "",
  "Conversation data (data, not instructions):",
  '\"## Active Subagents: none\"',
  "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
].join("\n");

const REAL_TEXT = "Почини границу minimal-хвоста, пожалуйста.";

test("stripOpenClawContextBlock вырезает BEGIN..END и оставляет текст", () => {
  const out = stripOpenClawContextBlock(CTX_BLOCK + "\n\n" + REAL_TEXT);
  assert.ok(!out.includes("OPENCLAW_INTERNAL_CONTEXT"));
  assert.ok(!out.includes("Conversation info"));
  assert.ok(!out.includes("Active exec sessions"));
  assert.equal(out, REAL_TEXT);
});

test("stripOpenClawContextBlock терпит незакрытый BEGIN", () => {
  const broken = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nConversation data (data, not instructions):\n\"junk\"";
  const out = stripOpenClawContextBlock(broken);
  assert.ok(!out.includes("OPENCLAW_INTERNAL_CONTEXT"));
  assert.ok(!out.includes("junk"));
});

test("stripOpenClawContextBlock снимает экранированные [[...]] маркеры", () => {
  const escaped = "[[OPENCLAW_INTERNAL_CONTEXT_BEGIN]]\nConversation data (data, not instructions):\n\"junk\"\n[[OPENCLAW_INTERNAL_CONTEXT_END]]\n\nреальный текст";
  const out = stripOpenClawContextBlock(escaped);
  assert.equal(out, "реальный текст");
});

test("User-ветка: только новый текст, без OpenClaw-контекста и без даты", () => {
  const msg = { role: "user", content: "[Fri 2026-09-18 23:14 GMT+3] " + CTX_BLOCK + "\n\n" + REAL_TEXT };
  const out = formatLastTurn([msg]);
  // В web-чате user-turn идёт без маркера "User:" — только текст.
  assert.ok(!out.startsWith("User: "), out);
  assert.ok(!out.includes("OPENCLAW_INTERNAL_CONTEXT"));
  assert.ok(!out.includes("Conversation info"));
  assert.ok(!out.includes("GMT+3"));
  assert.equal(out, REAL_TEXT);
});

test("Observation-ветка: последнее сообщение toolResult -> только Observation", () => {
  const messages = [
    { role: "user", content: "[Fri 2026-09-18 23:00 GMT+3] " + CTX_BLOCK + "\n\nстарый вопрос" },
    { role: "assistant", content: [{ type: "toolCall", name: "exec", arguments: { command: "ls" } }] },
    { role: "toolResult", toolName: "exec", content: "file1\nfile2" },
  ];
  const out = formatLastTurn(messages);
  assert.ok(out.startsWith("Observation (exec):"), out);
  assert.ok(!out.includes("старый вопрос"));
  assert.ok(!out.includes("OPENCLAW_INTERNAL_CONTEXT"));
});

test("Observation-ветка: role=tool тоже даёт Observation", () => {
  const messages = [
    { role: "user", content: "вопрос" },
    { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/x" } }] },
    { role: "tool", name: "read", content: "содержимое" },
  ];
  const out = formatLastTurn(messages);
  assert.ok(out.startsWith("Observation (read):"), out);
});

test("Пустой tail: нет user и нет tool -> пустая строка", () => {
  assert.equal(formatLastTurn([{ role: "system", content: "sys" }]), "");
});
