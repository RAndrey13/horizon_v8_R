// Функциональный тест horizon-v8-parallel-tool-calls (задача 4.5):
// несколько toolResult подряд -> хвост Observation содержит все результаты.
import test from "node:test";
import assert from "node:assert/strict";
import { formatLastTurn } from "../dist/sanitize.js";

test("Parallel: два toolResult подряд -> обе Observation в хвосте", () => {
  const messages = [
    { role: "user", content: "сделай две вещи" },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a", name: "exec", arguments: { command: "ls" } },
        { type: "toolCall", id: "call_b", name: "read", arguments: { path: "/x" } },
      ],
    },
    { role: "toolResult", toolCallId: "call_a", toolName: "exec", content: "out_first" },
    { role: "toolResult", toolCallId: "call_b", toolName: "read", content: "out_second" },
  ];
  const out = formatLastTurn(messages);
  assert.ok(out.includes("out_first"), out);
  assert.ok(out.includes("out_second"), out);
});

test("Parallel: одиночный toolResult не изменил поведение", () => {
  const messages = [
    { role: "user", content: "вопрос" },
    { role: "assistant", content: [{ type: "toolCall", id: "call_x", name: "exec", arguments: { command: "ls" } }] },
    { role: "toolResult", toolCallId: "call_x", toolName: "exec", content: "file1\nfile2" },
  ];
  const out = formatLastTurn(messages);
  assert.ok(out.startsWith("Observation (exec):"), out);
});
