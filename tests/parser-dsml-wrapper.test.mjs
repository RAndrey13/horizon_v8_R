// Регрессия: bar-prefixed DSML-обёртка (fullwidth |) и голое слово calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, findToolCallStartBroad } from "../dist/parser.js";

const B = "\uFF5C";
const D = B + B;

test("DSML: bar-prefixed wrapper 'calls' распознаётся", () => {
  const text = `<${D}DSML${D} calls>\n<${D}DSML${D} invoke name="exec">\n<${D}DSML${D} parameter name="command">pwd</${D}DSML${D} parameter>\n</${D}DSML${D} invoke>\n</${D}DSML${D} calls>`;
  const r = parseToolCall(text);
  assert.ok(r, "bar-prefixed обёртка должна распознаваться");
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "pwd" });
});

test("DSML: bar-обёртка в начале ответа -> findToolCallStartBroad = 0 (без утечки '｜｜')", () => {
  const text = `<${D}DSML${D} calls>`;
  assert.equal(findToolCallStartBroad(text), 0);
});

test("DSML: bar-обёртка после прозы -> anchor на вызове, markup не утекает", () => {
  const text = "Вот что я сделаю:\n" + `<${D}DSML${D} calls>`;
  assert.equal(findToolCallStartBroad(text), text.indexOf("<"));
  assert.equal(text.slice(0, findToolCallStartBroad(text)), "Вот что я сделаю:\n");
});

test("DSML: упоминание DSML в прозе без обёртки -> -1", () => {
  assert.equal(findToolCallStartBroad("Формат DSML тут не используется"), -1);
});

test("DSML: слово calls без DSML-маркера не считается markup", () => {
  assert.equal(findToolCallStartBroad("just calls here"), -1);
});
