// Регрессия: tool-call markup НЕ должен попадать в чат. После перехода на
// полную буферизацию стрима (как в FreeDeepseekAPI) текст эмитится только
// после полного чтения ответа и разбора markup, поэтому утечка невозможна
// по построению. Тест фиксирует контракт: из любого ответа в чат уходит
// только чистый текст (или tool-вызов), а маркеры — никогда.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findToolCallStartBroad,
  isToolCallJsonStart,
  parseToolCallAll,
} from "../dist/parser.js";

const B = "\uFF5C";
const D = B + B;

// Точная копия финального разбора из src/stream.ts: markup режется по
// анкору ВСЕГДА (даже если вызов битый), в чат уходит только чистый текст.
function finalTextContent(fullContent) {
  const tcs = findToolCallStartBroad(fullContent);
  const rawText = tcs === -1 ? fullContent : fullContent.slice(0, tcs);
  return isToolCallJsonStart(rawText) ? "" : rawText;
}

const LEAK_RE = /DSML|tool_call|<invoke|TOOL_CALL|\{"tool/;

const CASES = {
  "чистая проза": ["Привет, всё готово.", "Привет, всё готово."],
  "markdown-таблица": ["| a | b |\n|---|---|\n| 1 | 2 |", null],
  "проза + JSON tool_call": ['Сейчас.{"tool_call":{"name":"exec"}}', "Сейчас."],
  "проза + <invoke": ['Сейчас.\n<invoke name="exec">', "Сейчас.\n"],
  "проза + TOOL_CALL:": ["Сейчас. TOOL_CALL: exec", "Сейчас. "],
  "DSML только": [`<${D}DSML${D}tool_calls>`, ""],
};

for (const [name, [input, expected]] of Object.entries(CASES)) {
  test(`final: ${name} — markup не течёт в чат`, () => {
    const out = finalTextContent(input);
    assert.equal(LEAK_RE.test(out), false, `утечка markup: ${JSON.stringify(out)}`);
    if (expected !== null) assert.equal(out, expected);
  });
}

test("final: текст до бар-prefixed DSML сохраняется, markup отрезан", () => {
  const input = `Готово.\n${D}DSML${D}calls>\n${D}DSML${D}invoke name="exec">`;
  assert.equal(finalTextContent(input), "Готово.\n");
});

test("final: DSML-wrapper с валидным invoke режется, вызов парсится", () => {
  const input = `<${D}DSML${D}tool_calls>\n<${D}DSML${D}invoke name="exec">\n<${D}DSML${D}parameter name="command">pwd</${D}DSML${D}parameter>\n</${D}DSML${D}invoke>\n</${D}DSML${D}tool_calls>`;
  const calls = parseToolCallAll(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "exec");
  assert.deepEqual(calls[0].args, { command: "pwd" });
  assert.equal(finalTextContent(input), "");
});

test("findToolCallStartBroad: маркер после прозы анкорится в любой форме", () => {
  const prose = "Сделала. ";
  assert.equal(findToolCallStartBroad(prose + `${D}DSML${D}tool_calls>`), prose.length);
  assert.equal(findToolCallStartBroad(prose + `<${D}DSML${D}tool_calls>`), prose.length);
  assert.equal(findToolCallStartBroad(prose + '{"tool_call":{}}'), prose.length);
  assert.equal(findToolCallStartBroad(prose + '<invoke name="x">'), prose.length);
  assert.equal(findToolCallStartBroad(prose + "TOOL_CALL: x"), prose.length);
});

test("findToolCallStartBroad: проза без markup -> -1", () => {
  assert.equal(findToolCallStartBroad("Формат DSML тут не используется"), -1);
  assert.equal(findToolCallStartBroad("just calls here"), -1);
  assert.equal(findToolCallStartBroad("Слово на T"), -1);
});
