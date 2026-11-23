// Preload for the Lodash QUnit suite: records every failed assertion
// (module, test, message, expected, actual, source line) to QUNIT_DUMP.
const fs = require("node:fs");
const path = require("node:path");
const QUnit = require(path.resolve("node_modules/qunit-extras"));
const out = [];
const tests = [];
let total = 0;
let cur = [];
QUnit.testStart(() => { cur = []; });
QUnit.testDone((d) => { tests.push({ module: d.module, test: d.name, failed: d.failed, passed: d.passed, total: d.total, assertions: cur }); });
const str = (v) => { try { return typeof v === "symbol" ? v.toString() : JSON.stringify(v, (k, x) => (typeof x === "function" ? `[Function ${x.name}]` : typeof x === "symbol" ? x.toString() : x)); } catch { try { return String(v); } catch { return "[unprintable]"; } } };
QUnit.log((d) => {
  total++;
  if (d.result) return;
  cur.push({ module: d.module, test: d.name, message: d.message, expected: str(d.expected)?.slice(0, 300), actual: str(d.actual)?.slice(0, 300),
    source: (d.source || "").split("\n").find((l) => l.includes("test.js")) ?? "" });
});
process.on("exit", () => fs.writeFileSync(process.env.QUNIT_DUMP, JSON.stringify({ total, tests }, null, 1)));
