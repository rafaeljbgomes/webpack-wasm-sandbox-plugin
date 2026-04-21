import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const repoRoot = process.cwd();
const defaultOutputDir = resolve(repoRoot, "performance-harness", "results");
const runtimeHookUrl = pathToFileURL(
  resolve(repoRoot, "performance-harness", "runtime-hook.mjs"),
).href;

const RUNS_FIELDS = [
  "run_id",
  "timestamp",
  "library",
  "workload_id",
  "label",
  "mode",
  "iteration",
  "warmup",
  "command",
  "wall_ms",
  "cpu_user_ms",
  "cpu_system_ms",
  "peak_rss_mb",
  "peak_heap_used_mb",
  "peak_external_mb",
  "final_rss_mb",
  "final_heap_used_mb",
  "final_external_mb",
  "exit_code",
  "completed",
];

const EVENTS_FIELDS = [
  "run_id",
  "warmup",
  "sandbox_create_ms",
  "bundle_eval_ms",
  "membrane_call_count",
  "membrane_call_ms",
  "marshal_count",
  "marshal_ms",
  "unmarshal_count",
  "unmarshal_ms",
  "wrap_returned_count",
  "create_instance_count",
  "temp_object_peak_count",
];

const CROSSINGS_FIELDS = [
  "run_id",
  "warmup",
  "host_to_vm_count",
  "vm_to_host_count",
  "host_to_vm_total_bytes",
  "vm_to_host_total_bytes",
  "crossing_size_median_bytes",
  "crossing_size_p95_bytes",
  "crossing_size_max_bytes",
];

function usage() {
  console.error(
    [
      "Usage:",
      "  node performance-harness/run-command.mjs --mode <native|sandbox> [options] -- <command> [args...]",
      "",
      "Options:",
      "  --library <name>        Metadata only; defaults to 'unknown'",
      "  --workload-id <id>      Metadata only; defaults to 'default'",
      "  --label <label>         Optional label recorded in CSV output",
      "  --iterations <n>        Measured runs; defaults to 5",
      "  --warmup <n>            Warmup runs; defaults to 1",
      "  --sample-ms <n>         Memory sampling interval in ms; defaults to 100",
      "  --out-dir <path>        Output directory; defaults to performance-harness/results",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1 || separatorIndex === argv.length - 1) {
    usage();
    throw new Error("Expected a command after '--'.");
  }

  const options = {
    library: "unknown",
    workloadId: "default",
    label: "",
    iterations: 5,
    warmup: 1,
    sampleMs: 100,
    outDir: defaultOutputDir,
  };

  const optionArgs = argv.slice(0, separatorIndex);
  const commandArgs = argv.slice(separatorIndex + 1);

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    const next = optionArgs[index + 1];

    switch (arg) {
      case "--mode":
        options.mode = next;
        index += 1;
        break;
      case "--library":
        options.library = next;
        index += 1;
        break;
      case "--workload-id":
        options.workloadId = next;
        index += 1;
        break;
      case "--label":
        options.label = next;
        index += 1;
        break;
      case "--iterations":
        options.iterations = Number(next);
        index += 1;
        break;
      case "--warmup":
        options.warmup = Number(next);
        index += 1;
        break;
      case "--sample-ms":
        options.sampleMs = Number(next);
        index += 1;
        break;
      case "--out-dir":
        options.outDir = resolve(repoRoot, next);
        index += 1;
        break;
      default:
        usage();
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.mode || !["native", "sandbox"].includes(options.mode)) {
    throw new Error("Expected --mode native or --mode sandbox.");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer.");
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error("--warmup must be a non-negative integer.");
  }
  if (!Number.isFinite(options.sampleMs) || options.sampleMs <= 0) {
    throw new Error("--sample-ms must be a positive number.");
  }

  return {
    options,
    commandArgs,
  };
}

function formatCommand(commandArgs) {
  return commandArgs
    .map((arg) => (/\s|"/.test(arg) ? JSON.stringify(arg) : arg))
    .join(" ");
}

function csvEscape(value) {
  const stringValue = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(stringValue)) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }
  return stringValue;
}

function appendCsvRow(filePath, fields, row) {
  const header = `${fields.join(",")}\n`;
  const line = `${fields.map((field) => csvEscape(row[field])).join(",")}\n`;

  if (!existsSync(filePath)) {
    writeFileSync(filePath, header + line, "utf8");
    return;
  }

  appendFileSync(filePath, line, "utf8");
}

function ensureOutputDir(outDir) {
  mkdirSync(outDir, { recursive: true });
}

function createTempOutputPath(runId) {
  const tempDir = join(tmpdir(), "spike-quickjs-performance");
  mkdirSync(tempDir, { recursive: true });
  return join(tempDir, `${runId}.json`);
}

function createTempFragmentsDir(runId) {
  const tempDir = join(tmpdir(), "spike-quickjs-performance", `${runId}-fragments`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

function isDirectNodeCommand(commandArgs) {
  const executable = basename(commandArgs[0]).toLowerCase();
  return executable === "node" || executable === "node.exe";
}

function buildInstrumentedInvocation(commandArgs, tempOutputPath, fragmentsDir, sampleMs) {
  const env = {
    ...process.env,
    SANDBOX_PERF_ENABLED: "1",
    SANDBOX_PERF_OUTPUT: tempOutputPath,
    SANDBOX_PERF_OUTPUT_DIR: fragmentsDir,
    SANDBOX_PERF_SAMPLE_MS: String(sampleMs),
  };

  if (isDirectNodeCommand(commandArgs)) {
    return {
      executable: commandArgs[0],
      args: ["--import", runtimeHookUrl, ...commandArgs.slice(1)],
      env,
    };
  }

  const existingNodeOptions = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : "";
  env.NODE_OPTIONS = `${existingNodeOptions}--import=${runtimeHookUrl}`.trim();
  return {
    executable: commandArgs[0],
    args: commandArgs.slice(1),
    env,
  };
}

function emptyEvents() {
  return {
    sandbox_create_ms: 0,
    bundle_eval_ms: 0,
    membrane_call_count: 0,
    membrane_call_ms: 0,
    marshal_count: 0,
    marshal_ms: 0,
    unmarshal_count: 0,
    unmarshal_ms: 0,
    wrap_returned_count: 0,
    create_instance_count: 0,
    temp_object_peak_count: 0,
  };
}

function emptyCrossings() {
  return {
    host_to_vm_count: 0,
    vm_to_host_count: 0,
    host_to_vm_total_bytes: 0,
    vm_to_host_total_bytes: 0,
    crossing_size_median_bytes: 0,
    crossing_size_p95_bytes: 0,
    crossing_size_max_bytes: 0,
  };
}

function readMetricsFile(tempOutputPath, exitCode) {
  if (!existsSync(tempOutputPath)) {
    return {
      run: {
        wall_ms: 0,
        cpu_user_ms: 0,
        cpu_system_ms: 0,
        peak_rss_mb: 0,
        peak_heap_used_mb: 0,
        peak_external_mb: 0,
        final_rss_mb: 0,
        final_heap_used_mb: 0,
        final_external_mb: 0,
        exit_code: exitCode,
        completed: false,
      },
      events: emptyEvents(),
      crossings: emptyCrossings(),
    };
  }

  const payload = JSON.parse(readFileSync(tempOutputPath, "utf8"));
  return {
    run: payload.run ?? {},
    events: payload.events ?? emptyEvents(),
    crossings: payload.crossings ?? emptyCrossings(),
  };
}

function aggregateMetrics(parts, directChildPid, exitCode) {
  if (!parts.length) {
    return {
      run: {
        wall_ms: 0,
        cpu_user_ms: 0,
        cpu_system_ms: 0,
        peak_rss_mb: 0,
        peak_heap_used_mb: 0,
        peak_external_mb: 0,
        final_rss_mb: 0,
        final_heap_used_mb: 0,
        final_external_mb: 0,
        exit_code: exitCode,
        completed: false,
      },
      events: emptyEvents(),
      crossings: emptyCrossings(),
    };
  }

  const runSource =
    parts.find((part) => part.pid === directChildPid) ??
    parts[0];

  const events = emptyEvents();
  for (const part of parts) {
    for (const [key, value] of Object.entries(part.events ?? {})) {
      events[key] = (events[key] ?? 0) + (value ?? 0);
    }
  }

  const crossings = emptyCrossings();
  for (const part of parts) {
    const current = part.crossings ?? {};
    crossings.host_to_vm_count += current.host_to_vm_count ?? 0;
    crossings.vm_to_host_count += current.vm_to_host_count ?? 0;
    crossings.host_to_vm_total_bytes += current.host_to_vm_total_bytes ?? 0;
    crossings.vm_to_host_total_bytes += current.vm_to_host_total_bytes ?? 0;
    crossings.crossing_size_max_bytes = Math.max(
      crossings.crossing_size_max_bytes,
      current.crossing_size_max_bytes ?? 0,
    );
  }

  const totalCrossings =
    crossings.host_to_vm_count + crossings.vm_to_host_count;
  if (totalCrossings > 0) {
    const weightedMedian =
      parts.reduce(
        (sum, part) =>
          sum +
          ((part.crossings?.host_to_vm_count ?? 0) +
            (part.crossings?.vm_to_host_count ?? 0)) *
            (part.crossings?.crossing_size_median_bytes ?? 0),
        0,
      ) / totalCrossings;
    const weightedP95 =
      parts.reduce(
        (sum, part) =>
          sum +
          ((part.crossings?.host_to_vm_count ?? 0) +
            (part.crossings?.vm_to_host_count ?? 0)) *
            (part.crossings?.crossing_size_p95_bytes ?? 0),
        0,
      ) / totalCrossings;
    crossings.crossing_size_median_bytes = weightedMedian;
    crossings.crossing_size_p95_bytes = weightedP95;
  }

  return {
    run: {
      ...runSource.run,
      exit_code: runSource.run?.exit_code ?? exitCode,
      completed: runSource.run?.completed ?? exitCode === 0,
    },
    events,
    crossings,
  };
}

function readAggregatedMetrics(tempOutputPath, fragmentsDir, directChildPid, exitCode) {
  const parts = [];
  const fragmentEntries = existsSync(fragmentsDir)
    ? readdirSync(fragmentsDir).filter((entry) => entry.endsWith(".json"))
    : [];

  if (!fragmentEntries.length && existsSync(tempOutputPath)) {
    parts.push(JSON.parse(readFileSync(tempOutputPath, "utf8")));
  }

  if (fragmentEntries.length) {
    for (const entry of fragmentEntries) {
      const fragmentPath = join(fragmentsDir, entry);
      parts.push(JSON.parse(readFileSync(fragmentPath, "utf8")));
    }
  }

  return aggregateMetrics(parts, directChildPid, exitCode);
}

function runOnce(commandArgs, sampleMs, runId) {
  const tempOutputPath = createTempOutputPath(runId);
  const fragmentsDir = createTempFragmentsDir(runId);
  const invocation = buildInstrumentedInvocation(
    commandArgs,
    tempOutputPath,
    fragmentsDir,
    sampleMs,
  );

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd: repoRoot,
      env: invocation.env,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      try {
        const metrics = readAggregatedMetrics(
          tempOutputPath,
          fragmentsDir,
          child.pid,
          exitCode ?? 1,
        );
        rmSync(tempOutputPath, { force: true });
        rmSync(fragmentsDir, { recursive: true, force: true });
        resolvePromise({
          exitCode: exitCode ?? metrics.run.exit_code ?? 1,
          metrics,
        });
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}

async function main() {
  const { options, commandArgs } = parseArgs(process.argv.slice(2));
  ensureOutputDir(options.outDir);

  const runsCsvPath = join(options.outDir, "runs.csv");
  const eventsCsvPath = join(options.outDir, "events.csv");
  const crossingsCsvPath = join(options.outDir, "crossings.csv");
  const formattedCommand = formatCommand(commandArgs);
  const totalRuns = options.warmup + options.iterations;

  for (let iteration = 0; iteration < totalRuns; iteration += 1) {
    const warmup = iteration < options.warmup;
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.mode}-${randomUUID().slice(0, 8)}`;
    console.log(
      `[perf-harness] ${warmup ? "Warmup" : "Measured"} run ${iteration + 1}/${totalRuns}: ${formattedCommand}`,
    );

    const { exitCode, metrics } = await runOnce(
      commandArgs,
      options.sampleMs,
      runId,
    );

    const runRow = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      library: options.library,
      workload_id: options.workloadId,
      label: options.label,
      mode: options.mode,
      iteration,
      warmup,
      command: formattedCommand,
      wall_ms: metrics.run.wall_ms ?? 0,
      cpu_user_ms: metrics.run.cpu_user_ms ?? 0,
      cpu_system_ms: metrics.run.cpu_system_ms ?? 0,
      peak_rss_mb: metrics.run.peak_rss_mb ?? 0,
      peak_heap_used_mb: metrics.run.peak_heap_used_mb ?? 0,
      peak_external_mb: metrics.run.peak_external_mb ?? 0,
      final_rss_mb: metrics.run.final_rss_mb ?? 0,
      final_heap_used_mb: metrics.run.final_heap_used_mb ?? 0,
      final_external_mb: metrics.run.final_external_mb ?? 0,
      exit_code: exitCode,
      completed: metrics.run.completed ?? exitCode === 0,
    };
    appendCsvRow(runsCsvPath, RUNS_FIELDS, runRow);

    appendCsvRow(eventsCsvPath, EVENTS_FIELDS, {
      run_id: runId,
      warmup,
      ...emptyEvents(),
      ...metrics.events,
    });

    appendCsvRow(crossingsCsvPath, CROSSINGS_FIELDS, {
      run_id: runId,
      warmup,
      ...emptyCrossings(),
      ...metrics.crossings,
    });
  }
}

main().catch((error) => {
  console.error(`[perf-harness] ${error.stack || error.message}`);
  process.exitCode = 1;
});
