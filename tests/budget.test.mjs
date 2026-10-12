// Tests for the 2026-10-11 fix set: envBool truthiness, prompt budget (B1),
// turn-aligned dropping. Pure helpers only (no network).
import test from "node:test";
import assert from "node:assert/strict";
import { envBool } from "../dist/env.js";
import { dropOldestToFit, budgetFullPrompt } from "../dist/sanitize.js";

test("envBool: yes/on/TRUE/1 → true; no/off/0 → false; unset → default", () => {
  process.env.__EB = "yes"; assert.equal(envBool("__EB", false), true);
  process.env.__EB = "ON"; assert.equal(envBool("__EB", false), true);
  process.env.__EB = "True"; assert.equal(envBool("__EB", false), true);
  process.env.__EB = "1"; assert.equal(envBool("__EB", false), true);
  process.env.__EB = "no"; assert.equal(envBool("__EB", true), false);
  process.env.__EB = "off"; assert.equal(envBool("__EB", true), false);
  process.env.__EB = "0"; assert.equal(envBool("__EB", true), false);
  delete process.env.__EB; assert.equal(envBool("__EB", true), true);
});

test("dropOldestToFit: drops oldest turns, no orphaned toolResult, keeps newest", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "X".repeat(500) }] },
    { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] },
    { role: "toolResult", toolName: "read", toolCallId: "1", content: "Y".repeat(500) },
    { role: "user", content: [{ type: "text", text: "recent question" }] },
  ];
  const { messages: out, dropped } = dropOldestToFit(messages, 600, (m) => JSON.stringify(m).length);
  assert.ok(dropped > 0, "expected some messages dropped");
  assert.equal(out[out.length - 1].content[0].text, "recent question");
  assert.notEqual(out[0]?.role, "toolResult");
});

test("budgetFullPrompt: caps an oversized full prompt with a marker", () => {
  const big = () => ({ role: "user", content: [{ type: "text", text: "Z".repeat(2000) }] });
  const messages = Array.from({ length: 50 }, big);
  process.env.HORIZON_MAX_FULL_PROMPT_CHARS = "5000";
  const p = budgetFullPrompt(messages, "sys", []);
  delete process.env.HORIZON_MAX_FULL_PROMPT_CHARS;
  assert.ok(p.length < 50 * 2000, `prompt not capped: ${p.length}`);
  assert.match(p, /truncated to fit/);
});

test("budgetFullPrompt: under the cap is returned untouched", () => {
  process.env.HORIZON_MAX_FULL_PROMPT_CHARS = "1000000";
  const p = budgetFullPrompt([{ role: "user", content: [{ type: "text", text: "hello" }] }], "sys", []);
  delete process.env.HORIZON_MAX_FULL_PROMPT_CHARS;
  assert.match(p, /hello/);
  assert.doesNotMatch(p, /truncated to fit/);
});
