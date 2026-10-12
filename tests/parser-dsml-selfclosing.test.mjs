// Регрессия: DSML с самозакрывающимся <parameter .../> (без парного закрывающего).
// Модель шлёт дубль имени так: <parameter name="name" string="exec"/>, и раньше
// parseDsmlInvoke падал (ждал closing) -> parseToolCallAll пусто -> stream.ts
// вываливал сырой markup в чат.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, parseToolCallAll } from "../dist/parser.js";

const B = "\uFF5C";
const D = B + B + "DSML" + B + B;
const command = "cd /root/.openclaw/extensions/horizon_v8; git rev-parse main; echo done";
const argsJson = JSON.stringify({ command, timeoutSeconds: 120 }) + "}";
// ровно как в реальном вызове: arguments парный, name самозакрывающийся
const full =
  "<" + D + " calls>\n" +
  "<" + D + " invoke name=\"exec\">\n" +
  "<" + D + " parameter name=\"arguments\" string=\"false\">" + argsJson + "</" + D + " parameter>\n" +
  "<" + D + " parameter name=\"name\" string=\"exec\"/>\n" +
  "</" + D + " invoke>\n" +
  "</" + D + " calls>";

test("DSML self-closing <parameter/> не роняет парсер", () => {
  const tc = parseToolCall(full);
  assert.ok(tc, "tool call должен распарситься");
  assert.equal(tc.name, "exec");
  assert.equal(tc.args.command, command);
  assert.equal(tc.args.timeoutSeconds, 120);
});

test("DSML self-closing: parseToolCallAll даёт один вызов", () => {
  const all = parseToolCallAll(full);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "exec");
});
