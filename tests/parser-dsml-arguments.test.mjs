// Регрессия: DSML-форма DeepSeek с <parameter name="arguments" string="false">{...}</parameter>
// и отдельным <parameter name="name">. Раньше аргументы оставались вложенными
// (args = { arguments: {...}, name: "exec" }), и exec получал мусор.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, parseToolCallAll } from "../dist/parser.js";

const B = "\uFF5C";
const D = B + B + "DSML" + B + B;
const command = "cd /root/.openclaw/extensions/horizon_v8; git log --oneline -3 origin/main; echo done";
const argsJson = JSON.stringify({ command, timeoutSeconds: 90 }) + "}";
const full =
  "<" + D + " calls>\n" +
  "<" + D + " invoke name=\"exec\">\n" +
  "<" + D + " parameter name=\"arguments\" string=\"false\">" + argsJson + "</" + D + " parameter>\n" +
  "<" + D + " parameter name=\"name\" string=\"true\">exec</" + D + " parameter>\n" +
  "</" + D + " invoke>\n" +
  "</" + D + " calls>";

test("DSML bar-prefixed: аргументы разворачиваются, не вложены", () => {
  const tc = parseToolCall(full);
  assert.ok(tc, "tool call должен распарситься");
  assert.equal(tc.name, "exec");
  assert.equal(tc.args.command, command);
  assert.equal(tc.args.timeoutSeconds, 90);
  assert.equal(tc.args.arguments, undefined, "вложенный arguments не должен оставаться");
  assert.equal(tc.args.name, undefined, "служебный name не должен оставаться в args");
});

test("DSML bar-prefixed: parseToolCallAll даёт ровно один вызов", () => {
  const all = parseToolCallAll(full);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "exec");
  assert.equal(all[0].args.timeoutSeconds, 90);
});
