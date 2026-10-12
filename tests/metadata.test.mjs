// 2.3/4.3: служебные метаданные OpenClaw вычищаются из user-сообщения.
// cleanOpenClawMetadata приватный, поэтому проверяем через публичный formatMessages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMessages } from "../dist/sanitize.js";

test("formatMessages вычищает 'Conversation info (untrusted metadata)'", () => {
  const messages = [
    {
      role: "user",
      content:
        "Conversation info (untrusted metadata):\n  session: abc\n  sender: bob\n\nНастоящий вопрос пользователя",
    },
  ];
  const out = formatMessages(messages, undefined, []);
  assert.ok(out.includes("Настоящий вопрос"), "содержимое вопроса должно остаться");
  assert.ok(!out.includes("untrusted metadata"), "служебный блок должен быть вырезан");
});

test("formatMessages вычищает 'Sender (untrusted metadata)'", () => {
  const messages = [
    {
      role: "user",
      content: "Sender (untrusted metadata):\n  id: 123\n  name: x\n\nтекст вопроса",
    },
  ];
  const out = formatMessages(messages, undefined, []);
  assert.ok(out.includes("текст вопроса"));
  assert.ok(!out.includes("untrusted metadata"));
});
