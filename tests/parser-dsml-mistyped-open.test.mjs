// Регрессия: модель иногда пишет ОТКРЫВАЮЩИЙ тег параметра со слэшем:
//   </｜｜DSML｜｜parameter name="command" string="true">hostname</｜｜DSML｜｜parameter>
// Настоящий закрывающий тег атрибутов не несёт, поэтому name=/string= —
// признак опечатки. Раньше canonicalizeToolMarkupTag вырезал атрибуты у
// любого closing-тега, и такой вызов терялся целиком (parseToolCall -> null).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToolCall, parseToolCallAll } from "../dist/parser.js";

const B = "\uFF5C";
const D = B + B + "DSML" + B + B;

const full =
  "<" + D + " calls>\n" +
  "<" + D + " invoke name=\"exec\">\n" +
  "</" + D + " parameter name=\"command\" string=\"true\">hostname</" + D + " parameter>\n" +
  "</" + D + " invoke>\n" +
  "</" + D + " calls>";

test("DSML: открывающий тег со слэшем (опечатка) разбирается", () => {
  const tc = parseToolCall(full);
  assert.ok(tc, "tool call должен распарситься, несмотря на слэш в открывающем теге");
  assert.equal(tc.name, "exec");
  assert.equal(tc.args.command, "hostname");
});

test("DSML: опечатка со слэшем — ровно один вызов", () => {
  const all = parseToolCallAll(full);
  assert.equal(all.length, 1);
  assert.equal(all[0].name, "exec");
  assert.equal(all[0].args.command, "hostname");
});
