import test from "node:test";
import assert from "node:assert/strict";
import {
  parseJestCompatibleJson,
  parseQUnit,
  parseTap,
} from "../parsers.mjs";
import { compatibilityManifest } from "../manifest.mjs";
import {
  addComparison,
  aggregateStatus,
  classifyStatus,
  combineIncludedResults,
  parseArgs,
  resolveExecutionPlan,
  validateUnitParsedResult,
} from "../run-compat.mjs";
import {
  createExecutionUnits,
  discoverTestFiles,
  selectTestFiles,
  shouldFallbackUnit,
} from "../units.mjs";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");

test("parses TAP summaries and failures", () => {
  const result = parseTap(`
TAP version 13
ok 1 - works
not ok 2 - breaks
1..2
# tests 2
# pass 1
# fail 1
`);

  assert.deepEqual(result, {
    executed: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    failures: [{ test: "breaks", file: "", message: "breaks" }],
  });
});

test("aggregates multiple QUnit summaries", () => {
  const result = parseQUnit(`
PASS: 10  FAIL: 2  TOTAL: 12
PASS: 4  FAIL: 0  TOTAL: 4
`);

  assert.equal(result.executed, 16);
  assert.equal(result.passed, 14);
  assert.equal(result.failed, 2);
});

test("manifest contains only the ten evaluation libraries", () => {
  assert.deepEqual(
    compatibilityManifest.map((entry) => entry.name),
    [
      "date-fns",
      "image-js",
      "lodash",
      "luxon",
      "marked",
      "mime",
      "strip-ansi",
      "tweetnacl",
      "yup",
      "zod",
    ],
  );
});

test("parses JSON test reports and suite-level failures", () => {
  const directory = mkdtempSync(join(tmpdir(), "compat-parser-"));
  const reportPath = join(directory, "report.json");
  writeFileSync(
    reportPath,
    JSON.stringify({
      numTotalTests: 2,
      numPassedTests: 1,
      numFailedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: "suite.test.js",
          assertionResults: [],
          failureMessage: "ReferenceError: module is not defined",
        },
      ],
    }),
  );

  const result = parseJestCompatibleJson(reportPath);
  assert.equal(result.executed, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].file, "suite.test.js");
});

test("all manifest harnesses and immutable configs exist", () => {
  for (const entry of compatibilityManifest) {
    assert.equal(
      existsSync(resolve(repoRoot, entry.harness)),
      true,
      `${entry.name} harness is missing`,
    );
    assert.ok(["suite", "per-file", "batch"].includes(entry.strategy));
    for (const modeStrategy of Object.values(entry.modeStrategies ?? {})) {
      assert.ok(["suite", "per-file", "batch"].includes(modeStrategy.strategy));
    }
    assert.ok(entry.testFilePattern);
    assert.ok(entry.commands.native.length);
    assert.ok(entry.commands.sandbox.length);
  }

  for (const configPath of [
    "test-harness/date-fns/vitest.native.config.ts",
    "test-harness/date-fns/vitest.sandbox.config.ts",
    "test-harness/image-js/vitest.native.config.ts",
    "test-harness/image-js/vitest.sandbox.config.ts",
    "test-harness/luxon/jest.native.config.js",
    "test-harness/luxon/jest.sandbox.config.js",
    "compatibility-harness/configs/yup.native.config.mjs",
    "compatibility-harness/configs/yup.sandbox.config.mjs",
    "test-harness/zod/vitest.config.ts",
    "test-harness/zod/vitest-sandbox.config.ts",
  ]) {
    assert.equal(existsSync(resolve(repoRoot, configPath)), true, configPath);
  }
});

test("discovers the configured Date-fns, Yup, and Zod test sets", () => {
  const dateFns = compatibilityManifest.find((entry) => entry.name === "date-fns");
  const yup = compatibilityManifest.find((entry) => entry.name === "yup");
  const zod = compatibilityManifest.find((entry) => entry.name === "zod");
  const dateFiles = discoverTestFiles(
    resolve(repoRoot, dateFns.harness),
    dateFns.discovery,
  );
  const yupFiles = discoverTestFiles(
    resolve(repoRoot, yup.harness),
    yup.discovery,
  );
  const zodFiles = discoverTestFiles(
    resolve(repoRoot, zod.harness),
    zod.discovery,
  );

  assert.equal(dateFiles.length, 250);
  assert.equal(yupFiles.length, 14);
  assert.equal(zodFiles.length, 74);
  assert.ok(dateFiles.every((file) => file.endsWith("/test.ts")));
  assert.ok(yupFiles.every((file) => file.startsWith("test/")));
  assert.equal(yupFiles.includes("test/helpers.ts"), false);
  assert.equal(yupFiles.includes("test/types/types.ts"), false);
  assert.ok(
    zodFiles.every((file) =>
      file.startsWith("packages/zod/src/v4/classic/tests/"),
    ),
  );
});

test("creates suite native plans and isolated sandbox plans", () => {
  const dateFns = compatibilityManifest.find(
    (entry) => entry.name === "date-fns",
  );
  const yup = compatibilityManifest.find((entry) => entry.name === "yup");
  const zod = compatibilityManifest.find((entry) => entry.name === "zod");
  const options = {
    strategy: null,
    batchSize: null,
    testFiles: [],
  };
  const dateNativePlan = resolveExecutionPlan(dateFns, options, "native");
  const dateSandboxPlan = resolveExecutionPlan(dateFns, options, "sandbox");
  const yupNativePlan = resolveExecutionPlan(yup, options, "native");
  const yupSandboxPlan = resolveExecutionPlan(yup, options, "sandbox");
  const zodPlan = resolveExecutionPlan(zod, options);

  assert.equal(dateNativePlan.strategy, "suite");
  assert.equal(dateNativePlan.units.length, 1);
  assert.equal(dateNativePlan.units[0].files.length, 250);
  assert.equal(dateSandboxPlan.strategy, "batch");
  assert.equal(dateSandboxPlan.units.length, 25);
  assert.ok(dateSandboxPlan.units.every((unit) => unit.files.length === 10));
  assert.equal(yupNativePlan.strategy, "suite");
  assert.equal(yupNativePlan.units.length, 1);
  assert.equal(yupNativePlan.units[0].files.length, 14);
  assert.equal(yupSandboxPlan.strategy, "batch");
  assert.equal(yupSandboxPlan.units.length, 3);
  assert.deepEqual(
    yupSandboxPlan.units.map((unit) => unit.files.length),
    [5, 5, 4],
  );
  assert.equal(zodPlan.units.length, 74);
  assert.ok(zodPlan.units.every((unit) => unit.files.length === 1));
});

test("falls back only for invalid batches and excludes replaced totals", () => {
  const [batch] = createExecutionUnits({
    strategy: "batch",
    batchSize: 2,
    files: ["a.test.ts", "b.test.ts"],
    commandCount: 1,
  });
  assert.equal(shouldFallbackUnit(batch, "crashed", "per-file"), true);
  assert.equal(shouldFallbackUnit(batch, "parse_error", "per-file"), true);
  assert.equal(shouldFallbackUnit(batch, "failed_tests", "per-file"), false);

  const totals = combineIncludedResults([
    {
      included: false,
      parsed: { executed: 2, passed: 0, failed: 2, skipped: 0 },
    },
    {
      included: true,
      parsed: { executed: 1, passed: 1, failed: 0, skipped: 0 },
    },
    {
      included: true,
      parsed: { executed: 1, passed: 0, failed: 1, skipped: 0 },
    },
  ]);
  assert.deepEqual(totals, {
    executed: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
  });
});

test("validates CLI overrides and selected test files", () => {
  assert.throws(
    () => parseArgs(["--strategy", "per-file"]),
    /require --library/,
  );
  assert.throws(
    () => parseArgs(["--library", "zod", "--batch-size", "0"]),
    /positive integer/,
  );

  const options = parseArgs([
    "--library",
    "zod",
    "--strategy",
    "per-file",
    "--test-file",
    "packages/zod/src/v4/classic/tests/array.test.ts",
    "--test-file",
    "packages/zod/src/v4/classic/tests/object.test.ts",
  ]);
  assert.equal(options.testFiles.length, 2);
  assert.throws(
    () => selectTestFiles(["valid.test.ts"], ["../outside.test.ts"]),
    /inside the harness/,
  );
  assert.throws(
    () => selectTestFiles(["valid.test.ts"], ["missing.test.ts"]),
    /configured test set/,
  );
});

test("preserves status precedence and strict comparison requirements", () => {
  assert.equal(
    validateUnitParsedResult(
      { executed: 0, passed: 0, failed: 0, skipped: 0 },
      ["array.test.ts"],
    ),
    null,
  );
  assert.equal(
    classifyStatus({
      parsed: null,
      exitCode: 0,
      signal: null,
      spawnError: null,
      wasInterrupted: false,
    }),
    "parse_error",
  );
  assert.equal(
    aggregateStatus(
      [{ status: "failed_tests" }, { status: "crashed" }],
      false,
    ),
    "crashed",
  );
  assert.equal(
    aggregateStatus([{ status: "completed" }], true),
    "interrupted",
  );

  const native = {
    status: "failed_tests",
    completeFileSet: true,
    testSetFingerprint: "same",
    executed: 10,
    passed: 8,
  };
  const sandbox = {
    status: "failed_tests",
    completeFileSet: true,
    testSetFingerprint: "same",
    executed: 10,
    passed: 6,
  };
  const comparison = addComparison(native, sandbox);
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.compatibilityRatio, 0.75);

  sandbox.testSetFingerprint = "different";
  assert.equal(addComparison(native, sandbox).comparable, false);
});
