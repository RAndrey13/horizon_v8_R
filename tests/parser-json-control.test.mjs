import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall } from "../dist/parser.js";

const LF = String.fromCharCode(10);
const TB = String.fromCharCode(9);
const wrap = (b) => '{"tool_call":' + b + '}';

test("wrapped: литеральный LF внутри строки -> ремонт", () => {
  const bad = wrap('{"name":"exec","arguments":{"command":"echo hi' + LF + 'world"}}');
  assert.ok((() => { try { JSON.parse(bad); return false; } catch { return true; } })(), "сырой JSON.parse должен падать (иначе тест не про ремонт)");
  const r = parseToolCall(bad);
  assert.ok(r, "должен распознаться после control-repair");
  assert.equal(r.name, "exec");
  assert.equal(r.args.command, "echo hi" + LF + "world");
});

test("wrapped: литеральный TAB внутри строки -> ремонт", () => {
  const bad = wrap('{"name":"exec","arguments":{"command":"a' + TB + 'b"}}');
  const r = parseToolCall(bad);
  assert.ok(r);
  assert.equal(r.args.command, "a" + TB + "b");
});

test("wrapped: control-символы вне строк не ломают парсинг", () => {
  const ok = wrap('{' + LF + '  "name": "exec",' + LF + '  "arguments": {"command": "pwd"}' + LF + '}');
  const r = parseToolCall(ok);
  assert.ok(r);
  assert.deepEqual(r.args, { command: "pwd" });
});

test("wrapped: arguments-строкой с литеральным LF -> ремонт", () => {
  const bad = wrap('{"name":"exec","arguments":"{\\"command\\": \\"echo a' + LF + 'b\\"}"}');
  const r = parseToolCall(bad);
  assert.ok(r, "строка-аргумент должна починиться");
  assert.equal(r.name, "exec");
  assert.equal(r.args.command, "echo a" + LF + "b");
});

// контрольный негатив: голый JSON без обёртки/фенса НЕ распознаётся (не регресс ремонта, а форма входа)
test("bare (без wrapper/fence) не распознаётся — ожидаемое поведение", () => {
  const bare = '{"name":"exec","arguments":{"command":"pwd"}}';
  assert.equal(parseToolCall(bare), null);
});
