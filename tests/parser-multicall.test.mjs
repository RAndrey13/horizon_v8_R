// Regression test for a real failure captured live (deepseek-reasoner, large
// agent prompt): the model answered with SEVERAL separate `{"tool_call": ...}`
// JSON objects on their own lines, separated by blank lines and prose, e.g.
//
//   {"tool_call":{"name":"exec","arguments":{"command":"ls -la \"D:/x\""}}}
//
//   {"tool_call":{"name":"exec","arguments":{"command":"grep -ril ..."}}}
//
//   Стоп. Проверю окружение.
//
//   {"tool_call":{"name":"memory_search","arguments":{"query":"..."}}}
//
// parseToolCallAll must return every call, in order. Previously the batch was
// discarded wholesale when one name was not in the active tool set, and the
// turn ended with a bogus "invalid markup" error (or a silent empty answer).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as parser from "../dist/parser.js";
import { looksLikeToolCallMarkup } from "../dist/toolparse.js";

const payload = [
  '{"tool_call":{"name":"exec","arguments":{"command":"ls -la \\"D:/!!Nata/workspace\\" | head -50"}}}',
  "",
  '{"tool_call":{"name":"exec","arguments":{"command":"grep -ril \\"horizon\\" \\"D:/x\\" 2>/dev/null | head -20"}}}',
  "",
  "Стоп. Прежде чем что-то запускать, стоит понять, что значит контрольный прогон.",
  "",
  '{"tool_call":{"name":"memory_search","arguments":{"query":"Horizon контрольный прогон"}}}',
  '{"tool_call":{"name":"ask_user","arguments":{"questions":[{"question":"Что именно значит контрольный прогон?"}]}}}',
].join("\n");

test("multiple {\"tool_call\"} JSON objects separated by prose are all parsed", () => {
  const calls = parser.parseToolCallAll(payload);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.name), ["exec", "exec", "memory_search", "ask_user"]);
  assert.equal(calls[0].args.command, 'ls -la "D:/!!Nata/workspace" | head -50');
  assert.equal(calls[2].args.query, "Horizon контрольный прогон");
});

test("the same payload is recognised as tool-call markup", () => {
  assert.equal(looksLikeToolCallMarkup(payload), true);
});

test("unknown names are preserved by the parser (filtering is the caller's job)", () => {
  const calls = parser.parseToolCallAll(payload);
  // The parser must not decide policy: it returns everything it can read.
  assert.ok(calls.some((c) => c.name === "memory_search"));
  assert.ok(calls.some((c) => c.name === "ask_user"));
});
