// Компакт ядра = новая web-сессия: детект сводки по роли/тексту.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countCompactionSummaries, latestCompactionSignature, COMPACTION_SUMMARY_PREFIX } from "../dist/registry.js";

test("countCompactionSummaries: роль compactionSummary", () => {
  const msgs = [
    { role: "user", content: "вопрос" },
    { role: "assistant", content: "ответ" },
    { role: "compactionSummary", summary: "## Goal\n..." },
    { role: "user", content: "следующий вопрос" },
  ];
  assert.equal(countCompactionSummaries(msgs), 1);
});

test("countCompactionSummaries: текстовый префикс (роль сплющена в user)", () => {
  const msgs = [{ role: "user", content: COMPACTION_SUMMARY_PREFIX + "\n\n<summary>\n...\n</summary>" }];
  assert.equal(countCompactionSummaries(msgs), 1);
});

test("countCompactionSummaries: чистая история -> 0", () => {
  assert.equal(countCompactionSummaries([{ role: "user", content: "привет" }]), 0);
  assert.equal(countCompactionSummaries([]), 0);
  assert.equal(countCompactionSummaries(undefined), 0);
});

test("countCompactionSummaries: два компакта -> 2", () => {
  const msgs = [
    { role: "compactionSummary", summary: "a" },
    { role: "user", content: "x" },
    { role: "compactionSummary", summary: "b" },
  ];
  assert.equal(countCompactionSummaries(msgs), 2);
});

// РЕГРЕССИЯ 2026-09-22: ядро (convertToLlm, dist/session-*.mjs) отдаёт сводку
// как role="user" с content-МАССИВОМ text-блоков, а не строкой. Прежняя
// проверка `typeof content === "string"` такой формы не видела, поэтому
// детект компакта не срабатывал: в транскрипте было 7 compaction-событий,
// а session.compactions остался 0 и web-сессия росла до token-limit.
test("countCompactionSummaries: content-массив text-блоков (форма ядра)", () => {
  const msgs = [{
    role: "user",
    content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + "\n\n<summary>\n...\n</summary>" }],
  }];
  assert.equal(countCompactionSummaries(msgs), 1);
});

test("countCompactionSummaries: сводка во втором блоке массива", () => {
  const msgs = [{
    role: "user",
    content: [
      { type: "text", text: "без префикса" },
      { type: "text", text: COMPACTION_SUMMARY_PREFIX + "\n..." },
    ],
  }];
  assert.equal(countCompactionSummaries(msgs), 1);
});

test("countCompactionSummaries: массив без сводки -> 0", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: "обычный текст" }] }];
  assert.equal(countCompactionSummaries(msgs), 0);
});

test("latestCompactionSignature: без сводок -> пусто", () => {
  assert.equal(latestCompactionSignature([]), "");
  assert.equal(latestCompactionSignature(undefined), "");
  assert.equal(latestCompactionSignature([{ role: "user", content: "привет" }]), "");
});

test("latestCompactionSignature: роль compactionSummary отдаёт summary", () => {
  assert.match(latestCompactionSignature([{ role: "compactionSummary", summary: "A" }]), /^[0-9a-f]{64}$/);
});

test("latestCompactionSignature: content-массив отдаёт текст сводки", () => {
  const msgs = [{ role: "user", content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + " BODY" }] }];
  const sig = latestCompactionSignature(msgs);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.notEqual(sig, latestCompactionSignature([]));
});

// Ключевое свойство триггера ротации: после второго компакта в окне снова
// РОВНО одна сводка (старая история заменена), поэтому счётчик не растёт.
// Сигнатура обязана отличать новый компакт от предыдущего.
test("latestCompactionSignature: второй компакт даёт ДРУГУЮ сигнатуру", () => {
  const first = [{ role: "compactionSummary", summary: "SUMMARY-1" }, { role: "user", content: "x" }];
  const second = [{ role: "compactionSummary", summary: "SUMMARY-2" }, { role: "user", content: "y" }];
  const s1 = latestCompactionSignature(first);
  const s2 = latestCompactionSignature(second);
  assert.match(s1, /^[0-9a-f]{64}$/);
  assert.match(s2, /^[0-9a-f]{64}$/);
  assert.notEqual(s1, s2);
  // и счётчик в обоих окнах одинаковый — сигнатура единственный рабочий триггер
  assert.equal(countCompactionSummaries(first), countCompactionSummaries(second));
});

test("latestCompactionSignature: branchSummary не считается компактом", () => {
  assert.equal(latestCompactionSignature([{ role: "branchSummary", summary: "BR" }]), "");
});
