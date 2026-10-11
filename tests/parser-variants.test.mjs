// Regression tests for the real-world tool-call variants seen in the raw tap
// (dist/rawtc-diag.jsonl): DSML with/without spaces, truncated <tool_calls>,
// prologue prose + JSON, and the plural {"tool_calls": [...]} envelope.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as parser from "../dist/parser.js";
import { looksLikeToolCallMarkup } from "../dist/toolparse.js";

test("DSML inline tag with a space (<||DSML|| tool_calls>) parses", () => {
  const s = `<||DSML|| tool_calls>\n<||DSML|| invoke name="read">\n<||DSML|| parameter name="path" string="true">C:/x.md</||DSML|| parameter>\n</||DSML|| invoke>\n</||DSML|| tool_calls>`;
  const calls = parser.parseToolCallAll(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.equal(calls[0].args.path, "C:/x.md");
});

test("DSML inline tag without spaces parses", () => {
  const s = `<||DSML||tool_calls>\n<||DSML||invoke name="read">\n<||DSML||parameter name="path" string="true">C:/x.md</||DSML||parameter>\n</||DSML||invoke>\n</||DSML||tool_calls>`;
  const calls = parser.parseToolCallAll(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
});

test("XML <tool_calls><invoke> (no space) parses", () => {
  const s = `<tool_calls>\n<invoke name="search">\n<parameter name="q">hi</parameter>\n</invoke>\n</tool_calls>`;
  const calls = parser.parseToolCallAll(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "search");
  assert.deepEqual(calls[0].args, { q: "hi" });
});

test("truncated <tool_calls> markup: no parse, but detected as markup (strict retry)", () => {
  const s = `Some text\n<tool_calls>\n<invoke name="search">`;
  assert.equal(parser.parseToolCallAll(s).length, 0);
  assert.equal(looksLikeToolCallMarkup(s), true);
  assert.notEqual(parser.findToolCallStartBroad(s), -1);
});

test("prose before a JSON tool_call still parses the call", () => {
  const s = `Everything is verified. Let me record it:\n{"tool_call":{"name":"write","arguments":{"path":"D:/x.md","content":"hi"}}}`;
  const calls = parser.parseToolCallAll(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "write");
  assert.equal(calls[0].args.path, "D:/x.md");
});

test("plural {\"tool_calls\":[...]} envelope parses the first call", () => {
  const s = `{"tool_calls":[{"name":"read","arguments":{"path":"C:/y"}}]}`;
  const calls = parser.parseToolCallAll(s);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "read");
  assert.equal(calls[0].args.path, "C:/y");
});
