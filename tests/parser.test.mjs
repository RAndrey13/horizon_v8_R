// Автотесты парсера tool-call: закрывают ручные проверки
// horizon-v8-parser-hardening 2.3 (DSML decode), 3.3 (fenced JSON) + регрессия.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, decodeDsmlParameterValue, decodeDsmlValue } from "../dist/parser.js";

// --- 3.3: fenced JSON -------------------------------------------------------

test("3.3: parseToolCall разбирает fenced JSON (```json)", () => {
  const text = 'Вот вызов:\n```json\n{"tool_call": {"name": "exec", "arguments": {"command": "ls -la"}}}\n```\n';
  const r = parseToolCall(text);
  assert.ok(r, "должен вернуть разобранный вызов");
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "ls -la" });
});

test("3.3: parseToolCall разбирает bare fence с name/arguments", () => {
  const text = '```\n{"name": "read", "arguments": {"path": "/tmp/x"}}\n```';
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "read");
  assert.deepEqual(r.args, { path: "/tmp/x" });
});

test("3.3: fenced JSON со строковыми arguments", () => {
  const text = '```json\n{"tool_call": {"name": "exec", "arguments": "{\\"command\\":\\"pwd\\"}"}}\n```';
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "pwd" });
});

// --- 2.3: decodeDsmlParameterValue -----------------------------------------

test("2.3: decodeDsmlParameterValue разворачивает &quot; и &amp;", () => {
  assert.equal(decodeDsmlParameterValue("&quot;hi&quot; &amp; bye"), '"hi" & bye');
  assert.equal(decodeDsmlValue("&lt;a&gt;&apos;b&apos;"), "<a>'b'");
});

test("2.3: decodeDsmlParameterValue снимает CDATA", () => {
  assert.equal(decodeDsmlParameterValue("<![CDATA[<raw> & stuff]]>"), "<raw> & stuff");
});

test("2.3: CDATA-содержимое возвращается буквально (сущности не декодируются)", () => {
  assert.equal(decodeDsmlParameterValue("<![CDATA[a &amp; b]]>"), "a &amp; b");
});

test("2.3: обычный текст без CDATA декодируется", () => {
  assert.equal(decodeDsmlParameterValue("plain &amp; text"), "plain & text");
});

// --- 2.4: регрессия существующих веток -------------------------------------

test("регрессия JSON: строгий tool_call без fence", () => {
  const r = parseToolCall('{"tool_call": {"name": "exec", "arguments": {"command": "whoami"}}}');
  assert.ok(r);
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "whoami" });
});

test("регрессия XML: <tool_call><name>…</name><arguments>…</arguments></tool_call>", () => {
  const text = '<tool_call><name>read</name><arguments>{"path": "/etc/hosts"}</arguments></tool_call>';
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "read");
  assert.deepEqual(r.args, { path: "/etc/hosts" });
});

test("регрессия TOOL_CALL: legacy текстовый формат", () => {
  const text = 'TOOL_CALL: exec\narguments: {"command": "uptime"}';
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "uptime" });
});

test("регрессия DSML: <invoke><parameter>…", () => {
  const text =
    '<tool_calls>\n<invoke name="exec">\n<parameter name="command">ls -la</parameter>\n</invoke>\n</tool_calls>';
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "ls -la" });
});

test("регрессия DSML: параметр с CDATA", () => {
  const text =
    '<tool_calls>\n<invoke name="write">\n<parameter name="content"><![CDATA[a & b]]></parameter>\n</invoke>\n</tool_calls>';
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "write");
  assert.deepEqual(r.args, { content: "a & b" });
});

test("негатив: обычный текст не даёт tool call", () => {
  assert.equal(parseToolCall("просто болтовня без вызова"), null);
});
