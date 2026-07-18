import { spawn } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compatibilityManifest } from "./manifest.mjs";
import { parseResult, stripAnsi } from "./parsers.mjs";
import {
  createExecutionUnits,
  discoverTestFiles,
  fingerprintFiles,
  normalizeTestPath,
  selectTestFiles,
  shouldFallbackUnit,
  strategies,
  unitSlug,
} from "./units.mjs";

const harnessRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessRoot, "..");
const defaultResultsRoot = resolve(repoRoot, "compatibility-results");
const modes = ["native", "sandbox"];
let activeChild = null;
let interrupted = false;

function usage() {
  console.log(`Usage:
  node compatibility-harness/run-compat.mjs [options]

Options:
  --library <name>     Run one configured library
  --mode <mode>        Run only native or sandbox
  --strategy <value>   Override suite, per-file, or batch strategy
  --batch-size <n>     Override the batch size
  --test-file <path>   Select one configured test file (repeatable)
  --build              Build sandbox bundles before sandbox runs
  --out-dir <path>     Override the compatibility-results directory
  --list               List configured libraries
  --help               Show this help`);
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    library: null,
    mode: null,
    strategy: null,
    batchSize: null,
    testFiles: [],
    build: false,
    outDir: defaultResultsRoot,
    list: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--library":
        options.library = requiredValue(argv, index, arg);
        index += 1;
        break;
      case "--mode":
        options.mode = requiredValue(argv, index, arg);
        index += 1;
        break;
      case "--strategy":
        options.strategy = requiredValue(argv, index, arg);
        index += 1;
        break;
      case "--batch-size":
        options.batchSize = Number(requiredValue(argv, index, arg));
        index += 1;
        break;
      case "--test-file":
        options.testFiles.push(requiredValue(argv, index, arg));
        index += 1;
        break;
      case "--build":
        options.build = true;
        break;
      case "--out-dir":
        options.outDir = resolve(repoRoot, requiredValue(argv, index, arg));
        index += 1;
        break;
      case "--list":
        options.list = true;
        break;
      case "--help":
      case "-h":
        usage();
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.mode && !modes.includes(options.mode)) {
    throw new Error("--mode must be native or sandbox.");
  }
  if (options.strategy && !strategies.includes(options.strategy)) {
    throw new Error("--strategy must be suite, per-file, or batch.");
  }
  if (
    options.batchSize !== null &&
    (!Number.isInteger(options.batchSize) || options.batchSize < 1)
  ) {
    throw new Error("--batch-size must be a positive integer.");
  }
  if (
    (options.strategy || options.batchSize !== null || options.testFiles.length) &&
    !options.library
  ) {
    throw new Error(
      "--strategy, --batch-size, and --test-file require --library.",
    );
  }

  const names = compatibilityManifest.map((entry) => entry.name);
  if (options.library && !names.includes(options.library)) {
    throw new Error(
      `Unknown library "${options.library}". Expected one of: ${names.join(", ")}`,
    );
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, fields, rows) {
  const lines = [
    fields.join(","),
    ...rows.map((row) => fields.map((field) => csvEscape(row[field])).join(",")),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function formatCommand(command) {
  return [command.executable, ...command.args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function writeStreams(streams, text) {
  for (const stream of streams) {
    stream.write(text);
  }
}

function runProcess(command, { cwd, env, logStreams, label }) {
  return new Promise((resolvePromise) => {
    const commandText = formatCommand(command);
    const heading = `\n===== ${label} =====\n${commandText}\n\n`;
    writeStreams(logStreams, heading);
    process.stdout.write(heading);

    const startedAt = Date.now();
    const output = [];
    let spawnError = null;
    let child;
    try {
      child = spawn(command.executable, command.args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const text = `${error.stack ?? error.message}\n`;
      output.push(text);
      writeStreams(logStreams, text);
      resolvePromise({
        exitCode: 1,
        signal: null,
        spawnError: error,
        durationMs: Date.now() - startedAt,
        output: output.join(""),
      });
      return;
    }
    activeChild = child;

    const capture = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      writeStreams(logStreams, text);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      spawnError = error;
      const text = `${error.stack ?? error.message}\n`;
      output.push(text);
      writeStreams(logStreams, text);
    });
    child.on("close", (exitCode, signal) => {
      activeChild = null;
      resolvePromise({
        exitCode: exitCode ?? 1,
        signal,
        spawnError,
        durationMs: Date.now() - startedAt,
        output: output.join(""),
      });
    });
  });
}

export function classifyStatus({
  parsed,
  exitCode,
  signal,
  spawnError,
  wasInterrupted = interrupted,
}) {
  if (wasInterrupted) {
    return "interrupted";
  }
  if (spawnError || signal) {
    return "crashed";
  }
  if (!parsed) {
    return exitCode === 0 ? "parse_error" : "crashed";
  }
  if (parsed.failed > 0 || exitCode !== 0) {
    return "failed_tests";
  }
  return "completed";
}

export function validateUnitParsedResult(parsed, files) {
  if (files.length > 0 && parsed?.executed === 0) {
    return null;
  }
  return parsed;
}

export function aggregateStatus(units, wasInterrupted = interrupted) {
  const statuses = units.map((unit) => unit.status);
  if (wasInterrupted || statuses.includes("interrupted")) {
    return "interrupted";
  }
  if (statuses.includes("crashed")) {
    return "crashed";
  }
  if (statuses.includes("parse_error")) {
    return "parse_error";
  }
  if (statuses.includes("failed_tests")) {
    return "failed_tests";
  }
  return "completed";
}

export function combineIncludedResults(attempts) {
  const units = attempts.filter((unit) => unit.included);
  return units
    .filter((unit) => unit.parsed)
    .reduce(
      (combined, unit) => ({
        executed: combined.executed + unit.parsed.executed,
        passed: combined.passed + unit.parsed.passed,
        failed: combined.failed + unit.parsed.failed,
        skipped: combined.skipped + unit.parsed.skipped,
      }),
      { executed: 0, passed: 0, failed: 0, skipped: 0 },
    );
}

function extractProcessFailure(output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const errorLine = lines.find((line) =>
    /(?:ReferenceError|TypeError|SyntaxError|RangeError|Error):/.test(line),
  );
  return errorLine ?? lines.at(-1) ?? "Test process exited without a summary.";
}

export function resolveExecutionPlan(entry, options, mode = null) {
  const harnessDir = resolve(repoRoot, entry.harness);
  const discoveredFiles = discoverTestFiles(harnessDir, entry.discovery);
  if (options.testFiles.length && !entry.discovery) {
    throw new Error(`${entry.name} does not define an isolated test file set.`);
  }

  const files = selectTestFiles(discoveredFiles, options.testFiles);
  const modeStrategy = mode ? entry.modeStrategies?.[mode] : null;
  const strategy = options.strategy ?? modeStrategy?.strategy ?? entry.strategy;
  const batchSize =
    options.batchSize ?? modeStrategy?.batchSize ?? entry.batchSize ?? 1;
  const fallback =
    strategy === "batch"
      ? modeStrategy?.fallback ?? entry.fallback ?? null
      : null;
  if (strategy !== "suite" && !entry.discovery) {
    throw new Error(
      `${entry.name} cannot use strategy "${strategy}" without file discovery.`,
    );
  }
  if (options.strategy && options.batchSize !== null && strategy !== "batch") {
    throw new Error("--batch-size can only be used with the batch strategy.");
  }

  const units = createExecutionUnits({
    strategy,
    batchSize,
    files,
    commandCount: entry.commands.native.length,
  });
  return {
    strategy,
    batchSize: strategy === "batch" ? batchSize : null,
    fallback,
    files,
    expectedFiles: entry.discovery ? files.length : null,
    testSetFingerprint: fingerprintFiles({
      strategy,
      testFilePattern: entry.testFilePattern,
      files,
    }),
    units,
  };
}

async function executeUnit({
  entry,
  mode,
  unit,
  sequence,
  fallbackFor,
  resultDir,
  aggregateLog,
}) {
  const harnessDir = resolve(repoRoot, entry.harness);
  const slug = unitSlug(sequence, unit.files, unit.kind);
  const unitDir = resolve(resultDir, "units", slug);
  const logFile = resolve(unitDir, "run.log");
  const resultFile = resolve(unitDir, "result.json");
  const reportPath = resolve(unitDir, "runner-report.json");
  mkdirSync(unitDir, { recursive: true });
  const unitLog = createWriteStream(logFile, { encoding: "utf8" });

  const commandFactory = entry.commands[mode][unit.commandIndex];
  const command = commandFactory({
    repoRoot,
    harnessDir,
    resultDir,
    reportPath,
    testFiles: unit.files,
  });
  const step = await runProcess(command, {
    cwd: harnessDir,
    env: {
      ...process.env,
      SANDBOX_TARGET_LIBRARY: mode === "sandbox" ? entry.name : "",
    },
    logStreams: [aggregateLog, unitLog],
    label: `${entry.name} ${mode} unit ${sequence} (${unit.kind})`,
  });
  await new Promise((resolvePromise) => unitLog.end(resolvePromise));

  const rawParsed = parseResult(entry.parser, {
    output: step.output,
    reportPath,
  });
  const parsed = validateUnitParsedResult(rawParsed, unit.files);
  const status = classifyStatus({
    parsed,
    exitCode: step.exitCode,
    signal: step.signal,
    spawnError: step.spawnError,
  });
  const result = {
    id: slug,
    sequence,
    kind: unit.kind,
    files: unit.files,
    included: true,
    fallbackFor,
    status,
    executed: parsed?.executed ?? null,
    passed: parsed?.passed ?? null,
    failed: parsed?.failed ?? null,
    skipped: parsed?.skipped ?? null,
    exitCode: interrupted ? null : step.exitCode,
    signal: step.signal,
    durationMs: step.durationMs,
    command: formatCommand(command),
    log: relative(repoRoot, logFile),
    report: existsSync(reportPath) ? relative(repoRoot, reportPath) : null,
    resultFile: relative(repoRoot, resultFile),
    parsed,
    output: step.output,
  };
  writeJson(resultFile, { ...result, parsed: undefined, output: undefined });
  return result;
}

function unitFailureRows(entry, mode, unit) {
  const parsedFailures = unit.parsed?.failures ?? [];
  const failures =
    parsedFailures.length
      ? parsedFailures
      : unit.status === "completed"
        ? []
        : [
            {
              test: "",
              file:
                unit.files.length === 1 ? unit.files[0] : unit.files.join(";"),
              message: extractProcessFailure(unit.output),
            },
          ];

  return failures.map((failure) => ({
    library: entry.name,
    mode,
    unit: unit.id,
    test: failure.test ?? "",
    file:
      failure.file ||
      (unit.files.length === 1 ? unit.files[0] : unit.files.join(";")),
    message: String(failure.message ?? "").split(/\r?\n/, 1)[0],
    log: unit.log,
  }));
}

async function runMode(entry, mode, libraryDir, plan) {
  const resultDir = resolve(libraryDir, mode);
  const logFile = resolve(resultDir, "run.log");
  const resultFile = resolve(resultDir, "result.json");
  mkdirSync(resolve(resultDir, "units"), { recursive: true });
  const aggregateLog = createWriteStream(logFile, { encoding: "utf8" });
  const startedAt = new Date().toISOString();

  if (mode === "sandbox" && !existsSync(resolve(repoRoot, entry.proxy))) {
    const message = `Sandbox proxy not found: ${entry.proxy}`;
    aggregateLog.end(`${message}\n`);
    const result = {
      library: entry.name,
      mode,
      runner: entry.runner,
      strategy: plan.strategy,
      testFilePattern: entry.testFilePattern,
      testSetFingerprint: plan.testSetFingerprint,
      expectedFiles: plan.expectedFiles,
      completedFiles: 0,
      failedUnits: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "crashed",
      executed: null,
      passed: null,
      failed: null,
      skipped: null,
      exitCode: null,
      durationMs: 0,
      completeFileSet: false,
      error: message,
      log: relative(repoRoot, logFile),
      resultFile: relative(repoRoot, resultFile),
      units: [],
    };
    writeJson(resultFile, result);
    return {
      result,
      attempts: [],
      failures: [
        {
          library: entry.name,
          mode,
          unit: "",
          test: "",
          file: "",
          message,
          log: result.log,
        },
      ],
    };
  }

  const attempts = [];
  const included = [];
  let sequence = 0;
  for (const plannedUnit of plan.units) {
    if (interrupted) {
      break;
    }
    sequence += 1;
    const attempt = await executeUnit({
      entry,
      mode,
      unit: plannedUnit,
      sequence,
      fallbackFor: null,
      resultDir,
      aggregateLog,
    });
    attempts.push(attempt);

    if (shouldFallbackUnit(plannedUnit, attempt.status, plan.fallback)) {
      attempt.included = false;
      writeJson(resolve(repoRoot, attempt.resultFile), {
        ...attempt,
        parsed: undefined,
        output: undefined,
      });
      for (const file of plannedUnit.files) {
        if (interrupted) {
          break;
        }
        sequence += 1;
        const fallbackAttempt = await executeUnit({
          entry,
          mode,
          unit: {
            kind: "file",
            commandIndex: plannedUnit.commandIndex,
            files: [file],
          },
          sequence,
          fallbackFor: attempt.id,
          resultDir,
          aggregateLog,
        });
        attempts.push(fallbackAttempt);
        included.push(fallbackAttempt);
      }
    } else {
      included.push(attempt);
    }
  }
  await new Promise((resolvePromise) => aggregateLog.end(resolvePromise));

  const totals = combineIncludedResults(attempts);
  const completedFileSet = new Set();
  for (const unit of included) {
    if (unit.parsed) {
      for (const file of unit.files) {
        completedFileSet.add(file);
      }
    }
  }
  const completedFiles =
    plan.expectedFiles === null ? null : completedFileSet.size;
  const status = aggregateStatus(included);
  const invalidStatuses = new Set(["crashed", "parse_error", "interrupted"]);
  const completeFileSet =
    plan.expectedFiles === null
      ? !included.some((unit) => invalidStatuses.has(unit.status))
      : completedFiles === plan.expectedFiles &&
        !included.some((unit) => invalidStatuses.has(unit.status));
  const durationMs = attempts.reduce(
    (total, attempt) => total + attempt.durationMs,
    0,
  );
  const failedUnits = included.filter(
    (unit) => unit.status !== "completed",
  ).length;
  const result = {
    library: entry.name,
    mode,
    runner: entry.runner,
    strategy: plan.strategy,
    batchSize: plan.batchSize,
    fallback: plan.fallback,
    testFilePattern: entry.testFilePattern,
    testSetFingerprint: plan.testSetFingerprint,
    expectedFiles: plan.expectedFiles,
    completedFiles,
    failedUnits,
    startedAt,
    finishedAt: new Date().toISOString(),
    status,
    executed: included.some((unit) => unit.parsed) ? totals.executed : null,
    passed: included.some((unit) => unit.parsed) ? totals.passed : null,
    failed: included.some((unit) => unit.parsed) ? totals.failed : null,
    skipped: included.some((unit) => unit.parsed) ? totals.skipped : null,
    exitCode: interrupted
      ? null
      : included.find((unit) => unit.exitCode)?.exitCode ?? 0,
    durationMs,
    completeFileSet,
    log: relative(repoRoot, logFile),
    resultFile: relative(repoRoot, resultFile),
    units: attempts.map((unit) => ({
      id: unit.id,
      kind: unit.kind,
      files: unit.files,
      included: unit.included,
      fallbackFor: unit.fallbackFor,
      status: unit.status,
      resultFile: unit.resultFile,
    })),
  };
  writeJson(resultFile, result);

  return {
    result,
    attempts,
    failures: included.flatMap((unit) =>
      unitFailureRows(entry, mode, unit),
    ),
  };
}

export function addComparison(native, sandbox) {
  let comparable = false;
  let compatibilityRatio = null;
  let comparisonNote = "Both native and sandbox results are required.";
  const completedStatuses = new Set(["completed", "failed_tests"]);

  if (native && sandbox) {
    if (
      !completedStatuses.has(native.status) ||
      !completedStatuses.has(sandbox.status)
    ) {
      comparisonNote = `Comparison unavailable because native is ${native.status} and sandbox is ${sandbox.status}.`;
    } else if (
      !native.completeFileSet ||
      !sandbox.completeFileSet
    ) {
      comparisonNote = "Not all expected test files produced valid results.";
    } else if (native.testSetFingerprint !== sandbox.testSetFingerprint) {
      comparisonNote = "Native and sandbox used different test file sets.";
    } else if (native.executed !== sandbox.executed) {
      comparisonNote = "Native and sandbox executed different test totals.";
    } else if (!native.passed) {
      comparisonNote = "Native mode has no passing tests.";
    } else {
      comparable = true;
      compatibilityRatio = sandbox.passed / native.passed;
      comparisonNote = "";
    }
  }

  const comparison = { comparable, compatibilityRatio, comparisonNote };
  for (const result of [native, sandbox].filter(Boolean)) {
    Object.assign(result, comparison);
  }
  return comparison;
}

async function runBuild(logPath) {
  const logStream = createWriteStream(logPath, { encoding: "utf8" });
  const buildCommand =
    process.platform === "win32"
      ? {
          executable: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/s", "/c", "npm run build:bundles"],
        }
      : { executable: "npm", args: ["run", "build:bundles"] };
  const step = await runProcess(buildCommand, {
    cwd: repoRoot,
    env: process.env,
    logStreams: [logStream],
    label: "sandbox bundle build",
  });
  await new Promise((resolvePromise) => logStream.end(resolvePromise));
  const { output: _output, spawnError: _spawnError, ...result } = step;
  return result;
}

function unitCsvRow(entry, mode, unit) {
  return {
    library: entry.name,
    mode,
    unit: unit.id,
    sequence: unit.sequence,
    kind: unit.kind,
    files: unit.files.join(";"),
    included: unit.included,
    fallback_for: unit.fallbackFor,
    status: unit.status,
    executed: unit.executed,
    passed: unit.passed,
    failed: unit.failed,
    skipped: unit.skipped,
    exit_code: unit.exitCode,
    duration_ms: unit.durationMs,
    log: unit.log,
    report: unit.report,
  };
}

function writeLibraryArtifacts({
  entry,
  libraryDir,
  metadata,
  modeRuns,
  comparison,
}) {
  const results = modeRuns.map((run) => run.result);
  for (const result of results) {
    writeJson(resolve(repoRoot, result.resultFile), result);
  }

  writeCsv(
    resolve(libraryDir, "summary.csv"),
    [
      "library",
      "mode",
      "status",
      "executed",
      "passed",
      "failed",
      "skipped",
      "expected_files",
      "completed_files",
      "failed_units",
      "exit_code",
      "duration_ms",
      "compatibility_ratio",
      "comparable",
      "comparison_note",
      "log",
    ],
    results.map((result) => ({
      ...result,
      expected_files: result.expectedFiles,
      completed_files: result.completedFiles,
      failed_units: result.failedUnits,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      compatibility_ratio: result.compatibilityRatio,
      comparison_note: result.comparisonNote,
    })),
  );
  writeCsv(
    resolve(libraryDir, "failures.csv"),
    ["library", "mode", "unit", "test", "file", "message", "log"],
    modeRuns.flatMap((run) => run.failures),
  );
  writeCsv(
    resolve(libraryDir, "units.csv"),
    [
      "library",
      "mode",
      "unit",
      "sequence",
      "kind",
      "files",
      "included",
      "fallback_for",
      "status",
      "executed",
      "passed",
      "failed",
      "skipped",
      "exit_code",
      "duration_ms",
      "log",
      "report",
    ],
    modeRuns.flatMap((run) =>
      run.attempts.map((unit) => unitCsvRow(entry, run.result.mode, unit)),
    ),
  );
  metadata.comparison = comparison;
  metadata.finishedAt = new Date().toISOString();
  writeJson(resolve(libraryDir, "run-metadata.json"), metadata);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    return;
  }
  if (options.list) {
    for (const entry of compatibilityManifest) {
      console.log(`${entry.name}\t${entry.runner}\t${entry.strategy}`);
    }
    return;
  }

  const selectedLibraries = compatibilityManifest.filter(
    (entry) => !options.library || entry.name === options.library,
  );
  const selectedModes = options.mode ? [options.mode] : modes;
  const campaignTimestamp = timestamp();
  const plans = new Map(
    selectedLibraries.map((entry) => {
      const plansByMode = new Map(
        selectedModes.map((mode) => [
          mode,
          resolveExecutionPlan(entry, options, mode),
        ]),
      );
      return [entry.name, plansByMode];
    }),
  );
  const libraryDirs = new Map(
    selectedLibraries.map((entry) => {
      const directory = resolve(options.outDir, entry.name, campaignTimestamp);
      mkdirSync(directory, { recursive: true });
      return [entry.name, directory];
    }),
  );

  let buildResult = null;
  if (options.build && selectedModes.includes("sandbox")) {
    const firstLibraryDir = libraryDirs.get(selectedLibraries[0].name);
    const firstBuildLog = resolve(firstLibraryDir, "build.log");
    buildResult = await runBuild(firstBuildLog);
    for (const entry of selectedLibraries.slice(1)) {
      copyFileSync(firstBuildLog, resolve(libraryDirs.get(entry.name), "build.log"));
    }
  }

  for (const entry of selectedLibraries) {
    const libraryDir = libraryDirs.get(entry.name);
    const plansByMode = plans.get(entry.name);
    const localBuild = buildResult
      ? {
          ...buildResult,
          log: relative(repoRoot, resolve(libraryDir, "build.log")),
        }
      : null;
    const metadata = {
      startedAt: new Date().toISOString(),
      finishedAt: null,
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      timestamp: campaignTimestamp,
      library: entry.name,
      modes: selectedModes,
      options: {
        mode: options.mode,
        build: options.build,
        strategy: options.strategy,
        batchSize: options.batchSize,
        testFiles: options.testFiles.map(normalizeTestPath),
      },
      plan: {
        byMode: Object.fromEntries(
          selectedModes.map((mode) => {
            const plan = plansByMode.get(mode);
            return [
              mode,
              {
                strategy: plan.strategy,
                batchSize: plan.batchSize,
                fallback: plan.fallback,
                expectedFiles: plan.expectedFiles,
                testSetFingerprint: plan.testSetFingerprint,
                files: plan.files,
              },
            ];
          }),
        ),
      },
      comparison: {},
      build: localBuild,
    };

    if (
      localBuild &&
      (localBuild.exitCode !== 0 || localBuild.signal)
    ) {
      metadata.finishedAt = new Date().toISOString();
      writeJson(resolve(libraryDir, "run-metadata.json"), metadata);
      continue;
    }

    const modeRuns = [];
    for (const mode of selectedModes) {
      if (interrupted) {
        break;
      }
      console.log(`\n[compat] Running ${entry.name} in ${mode} mode`);
      modeRuns.push(
        await runMode(entry, mode, libraryDir, plansByMode.get(mode)),
      );
    }
    const native = modeRuns.find((run) => run.result.mode === "native")?.result;
    const sandbox = modeRuns.find(
      (run) => run.result.mode === "sandbox",
    )?.result;
    const comparison = addComparison(native, sandbox);
    writeLibraryArtifacts({
      entry,
      libraryDir,
      metadata,
      modeRuns,
      comparison,
    });
    console.log(
      `[compat] ${entry.name} results: ${relative(repoRoot, libraryDir)}`,
    );
    if (interrupted) {
      break;
    }
  }

  if (
    buildResult &&
    (buildResult.exitCode !== 0 || buildResult.signal)
  ) {
    throw new Error("Sandbox bundle build failed. See each library build.log.");
  }
  if (interrupted) {
    process.exitCode = 130;
  }
}

if (typeof process !== "undefined") {
  process.on("SIGINT", () => {
    interrupted = true;
    if (activeChild && !activeChild.killed) {
      activeChild.kill("SIGINT");
    }
  });

  const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
  if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
      console.error(`[compat] ${error.stack ?? error.message}`);
      process.exitCode = 1;
    });
  }
}
