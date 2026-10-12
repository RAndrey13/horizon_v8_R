// Smoke: собранный dist/parser.js должен загружаться и экспортировать API.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as parser from "../dist/parser.js";

test("dist/parser.js загружается и экспортирует функции", () => {
  assert.equal(typeof parser.parseToolCall, "function");
  assert.equal(typeof parser.decodeDsmlParameterValue, "function");
  assert.equal(typeof parser.normalizeDsmlMarkup, "function");
});

test("parseToolCall(пустая строка) не падает и возвращает null", () => {
  assert.equal(parser.parseToolCall(""), null);
});
