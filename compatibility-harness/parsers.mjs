import { existsSync, readFileSync } from "node:fs";

const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value) {
  return value.replace(ANSI_PATTERN, "");
}

function numeric(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createResult({ executed, passed, failed, skipped = 0, failures = [] }) {
  return {
    executed: numeric(executed),
    passed: numeric(passed),
    failed: numeric(failed),
    skipped: numeric(skipped),
    failures,
  };
}

function parseJsonReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return null;
  }
}

export function parseJestCompatibleJson(reportPath) {
  const report = parseJsonReport(reportPath);
  if (!report || report.numTotalTests === undefined) {
    return null;
  }

  const failures = [];
  for (const suite of report.testResults ?? []) {
    const assertions = suite.assertionResults ?? suite.testResults ?? [];
    let assertionFailureCount = 0;
    for (const assertion of assertions) {
      if (assertion.status !== "failed") {
        continue;
      }
      assertionFailureCount += 1;
      failures.push({
        test: [...(assertion.ancestorTitles ?? []), assertion.title]
          .filter(Boolean)
          .join(" > "),
        file: suite.name ?? suite.testFilePath ?? "",
        message: assertion.failureMessages?.[0] ?? assertion.failureMessage ?? "",
      });
    }
    if (!assertionFailureCount && suite.failureMessage) {
      failures.push({
        test: "",
        file: suite.name ?? suite.testFilePath ?? "",
        message: suite.failureMessage,
      });
    }
  }

  return createResult({
    executed: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: numeric(report.numPendingTests) + numeric(report.numTodoTests),
    failures,
  });
}

export function parseTap(output) {
  const text = stripAnsi(output);
  const tests = [...text.matchAll(/^\s*#\s*tests\s+(\d+)\s*$/gim)].at(-1);
  const pass = [...text.matchAll(/^\s*#\s*pass\s+(\d+)\s*$/gim)].at(-1);
  const fail = [...text.matchAll(/^\s*#\s*fail\s+(\d+)\s*$/gim)].at(-1);
  const skipped = [...text.matchAll(/^\s*#\s*skip(?:ped)?\s+(\d+)\s*$/gim)].at(-1);

  if (!tests && !pass && !fail) {
    return null;
  }

  const executed = numeric(tests?.[1], numeric(pass?.[1]) + numeric(fail?.[1]));
  const failed = numeric(fail?.[1]);
  const skippedCount = numeric(skipped?.[1]);
  const passed = pass
    ? numeric(pass[1])
    : Math.max(0, executed - failed - skippedCount);

  const failures = [...text.matchAll(/^\s*not ok\s+\d+\s*-\s*(.+)$/gim)].map(
    (match) => ({
      test: match[1].trim(),
      file: "",
      message: match[1].trim(),
    }),
  );

  return createResult({
    executed,
    passed,
    failed,
    skipped: skippedCount,
    failures,
  });
}

export function parseQUnit(output) {
  const text = stripAnsi(output);
  const summaries = [
    ...text.matchAll(/PASS:\s*(\d+)\s+FAIL:\s*(\d+)\s+TOTAL:\s*(\d+)/gi),
  ];

  if (!summaries.length) {
    return null;
  }

  let passed = 0;
  let failed = 0;
  let executed = 0;
  for (const summary of summaries) {
    passed += numeric(summary[1]);
    failed += numeric(summary[2]);
    executed += numeric(summary[3]);
  }

  const failures = [...text.matchAll(/^\s*FAIL\s*-\s*(.+)$/gim)].map(
    (match) => ({
      test: match[1].trim(),
      file: "",
      message: match[1].trim(),
    }),
  );

  return createResult({ executed, passed, failed, failures });
}

export function parseTextSummary(output) {
  const text = stripAnsi(output);
  const match = text.match(
    /Tests?\s+(\d+)\s+failed(?:\s*\|\s*(\d+)\s+skipped)?(?:\s*\|\s*(\d+)\s+passed)?\s*\((\d+)\)/i,
  );
  if (!match) {
    return null;
  }

  return createResult({
    failed: match[1],
    skipped: match[2],
    passed: match[3],
    executed: match[4],
  });
}

export function parseResult(parser, { output, reportPath }) {
  switch (parser) {
    case "vitest-json":
    case "jest-json":
      return parseJestCompatibleJson(reportPath) ?? parseTextSummary(output);
    case "tap":
      return parseTap(output);
    case "qunit":
      return parseQUnit(output);
    default:
      throw new Error(`Unknown compatibility result parser: ${parser}`);
  }
}
