// Регрессия: одиночная косая кавычка (`) и вертикальная черта (|) в обычной
// прозе НЕ должны приниматься за tool-call markup. Ни findToolCallStartBroad,
// ни parseToolCallAll не срабатывают, и видимый текст не режется.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findToolCallStartBroad, parseToolCallAll } from "../dist/parser.js";

const BACKTICK_PROSE = [
  "Вот пример: используй флаг `verbose` при запуске.",
  "Код: `npm run build`",
  "Готово, коммичу.\n\n`git commit -m \"x\"`",
  "Проза с ` и дальше ничего.",
  "Отчёт: `id=5` готов.",
  "`inline code` в середине предложения и `ещё один` в конце.",
  "Значение `a|b` — это не таблица.",
];

for (const input of BACKTICK_PROSE) {
  test(`backtick-проза не анкорится: ${JSON.stringify(input.slice(0, 32))}`, () => {
    assert.equal(findToolCallStartBroad(input), -1, "анкор не должен находиться");
    assert.deepEqual(parseToolCallAll(input), [], "tool call не должен парситься");
  });
}

test("одиночный backtick не является tool-call маркером", () => {
  // Прямая проверка: разбор длинной прозы с backtick-фрагментами даёт []
  const long = Array.from({ length: 50 }, (_, i) => `Шаг ${i}: запусти \`cmd${i}\`.`).join("\n");
  assert.equal(findToolCallStartBroad(long), -1);
  assert.deepEqual(parseToolCallAll(long), []);
});

test("проза + реальный markup всё ещё режется по анкору", () => {
  const input = 'Проза с `backtick`.\n\nTOOL_CALL: exec\narguments: {"command":"echo hi"}';
  const start = findToolCallStartBroad(input);
  assert.notEqual(start, -1);
  assert.equal(input.slice(0, start), "Проза с `backtick`.\n\n");
  const calls = parseToolCallAll(input);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "exec");
});
