// Тесты DSML-порта (toolparse.ts): строгая структура, direct-форма,
// множественные вызовы, флуд-защита. Закрывают задачу №1 (парсинг DSML)
// и готовят почву для horizon-v8-parallel-tool-calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, parseToolCallAll, findToolCallStartBroad } from "../dist/parser.js";

const B = "\uFF5C"; // fullwidth vertical bar
const D = B + B;    // двойной маркер DSML
const WRAP = (inner) => `<${D}DSML${D}tool_calls>\n${inner}\n<${D}DSML${D}/tool_calls>`;
const INVOKE = (name, params) =>
  `<${D}DSML${D}invoke name="${name}">\n${params}\n<${D}DSML${D}/invoke>`;
const PARAM = (name, value, attrs = "") =>
  `<${D}DSML${D}parameter name="${name}"${attrs}>${value}<${D}DSML${D}/parameter>`;

// --- одиночный путь ---------------------------------------------------------

test("DSML: одиночный invoke внутри tool_calls", () => {
  const text = WRAP(INVOKE("exec", PARAM("command", "ls -la")));
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "ls -la" });
});

test("DSML: одиночный invoke -> parseToolCallAll даёт массив из одного", () => {
  const text = WRAP(INVOKE("read", PARAM("path", "/etc/hosts")));
  const all = parseToolCallAll(text);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], { name: "read", args: { path: "/etc/hosts" } });
});

test("DSML: нет вызовов -> пустой массив", () => {
  assert.deepEqual(parseToolCallAll("просто текст без вызова"), []);
  assert.equal(parseToolCall("просто текст без вызова"), null);
});

// --- direct-форма (раньше не разбиралась вовсе) -----------------------------

test("DSML: direct-форма name=… распознаётся", () => {
  const text = `<${D}DSML${D}tool_calls>\n<${D}DSML${D}direct name="exec">\n${PARAM("command", "pwd")}\n<${D}DSML${D}/direct>\n<${D}DSML${D}/tool_calls>`;
  const r = parseToolCall(text);
  assert.ok(r, "direct-форма должна распознаваться");
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "pwd" });
});

// --- строгая структура ------------------------------------------------------

test("DSML: self-closing parameter отвергается (не даёт ложное значение)", () => {
  const text = `<${D}DSML${D}tool_calls><${D}DSML${D}invoke name="exec"><${D}DSML${D}parameter name="command"/>x<${D}DSML${D}/invoke><${D}DSML${D}/tool_calls>`;
  assert.equal(parseToolCall(text), null);
});

test("DSML: незакрытая обёртка tool_calls отвергается", () => {
  const text = `<${D}DSML${D}tool_calls>\n<${D}DSML${D}invoke name="exec">\n${PARAM("command", "ls")}`;
  assert.equal(parseToolCall(text), null);
});

test("DSML: дубликат имени параметра отвергается", () => {
  const text = WRAP(INVOKE("exec", PARAM("command", "a") + "\n" + PARAM("command", "b")));
  assert.equal(parseToolCall(text), null);
});

// --- параметр name вместо атрибута ------------------------------------------

test("DSML: имя инструмента из параметра name", () => {
  const text = WRAP(
    `<${D}DSML${D}invoke>\n${PARAM("name", "exec")}\n${PARAM("command", "pwd")}\n<${D}DSML${D}/invoke>`,
  );
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "exec");
  assert.deepEqual(r.args, { command: "pwd" });
});

// --- CDATA ------------------------------------------------------------------

test("DSML: CDATA в параметре возвращается буквально", () => {
  const text = WRAP(INVOKE("write", PARAM("content", "<![CDATA[<raw> text]]>")));
  const r = parseToolCall(text);
  assert.ok(r);
  assert.equal(r.name, "write");
  assert.deepEqual(r.args, { content: "<raw> text" });
});

// --- множественные вызовы ---------------------------------------------------

test("DSML: два invoke в одной обёртке -> оба, порядок сохранён", () => {
  const text = WRAP(
    INVOKE("exec", PARAM("command", "ls -la")) + "\n" +
    INVOKE("read", PARAM("path", "/etc/hosts")),
  );
  const all = parseToolCallAll(text);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { name: "exec", args: { command: "ls -la" } });
  assert.deepEqual(all[1], { name: "read", args: { path: "/etc/hosts" } });
});

test("DSML: три invoke подряд -> все три", () => {
  const text = WRAP(
    INVOKE("a", PARAM("x", "1")) + "\n" +
    INVOKE("b", PARAM("y", "2")) + "\n" +
    INVOKE("c", PARAM("z", "3")),
  );
  const all = parseToolCallAll(text);
  assert.deepEqual(all.map((c) => c.name), ["a", "b", "c"]);
});

test("DSML: два одинаковых вызова не дедуплицируются", () => {
  const text = WRAP(INVOKE("exec", PARAM("command", "ls")) + "\n" + INVOKE("exec", PARAM("command", "ls")));
  const all = parseToolCallAll(text);
  assert.equal(all.length, 2);
});

// --- флуд-защита ------------------------------------------------------------

test("DSML: превышение числа параметров -> пустой массив", () => {
  let params = "";
  for (let i = 0; i < 130; i++) params += PARAM("p" + i, "v") + "\n";
  const text = WRAP(`<${D}DSML${D}invoke name="exec">\n${params}\n<${D}DSML${D}/invoke>`);
  assert.deepEqual(parseToolCallAll(text), []);
});

test("DSML: превышение числа структурных тегов -> пустой массив", () => {
  let invokes = "";
  for (let i = 0; i < 200; i++) invokes += INVOKE("t" + i, PARAM("x", "1")) + "\n";
  const text = WRAP(invokes);
  assert.deepEqual(parseToolCallAll(text), []);
});

// --- смешанный ответ (текст + два вызова) -----------------------------------

test("DSML: текст перед обёрткой + два вызова -> оба распознаны", () => {
  const text = "Вот что я сделаю:\n" + WRAP(
    INVOKE("exec", PARAM("command", "ls -la")) + "\n" +
    INVOKE("read", PARAM("path", "/etc/hosts")),
  );
  const all = parseToolCallAll(text);
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], { name: "exec", args: { command: "ls -la" } });
  assert.deepEqual(all[1], { name: "read", args: { path: "/etc/hosts" } });
});
