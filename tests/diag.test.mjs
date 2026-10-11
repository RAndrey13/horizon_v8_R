// The raw tool-call tap must be a strict no-op unless HORIZON_RAWTC_DIAG is set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { dumpRawToolCall } from "../dist/diag.js";

test("dumpRawToolCall is a no-op when HORIZON_RAWTC_DIAG is unset", () => {
  delete process.env.HORIZON_RAWTC_DIAG;
  // Must not throw and must not create anything.
  dumpRawToolCall("test", "hello", [{ name: "x", args: {} }], 3);
  assert.equal(process.env.HORIZON_RAWTC_DIAG, undefined);
});

test("dumpRawToolCall writes only when a path is configured", () => {
  const p = `${process.env.TEMP || "."}/horizon_diag_test_${Date.now()}.jsonl`;
  try {
    process.env.HORIZON_RAWTC_DIAG = p;
    dumpRawToolCall("test", "hello", [{ name: "x", args: { a: 1 } }], 3);
    assert.equal(existsSync(p), true);
  } finally {
    delete process.env.HORIZON_RAWTC_DIAG;
    try { rmSync(p, { force: true }); } catch {}
  }
});
