import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);

const repoRoot = process.cwd();
const sandboxConfigPath = path.resolve(repoRoot, ".sandbox", "sandbox.config.js");
const defaultOutputDir = path.resolve(
  repoRoot,
  "performance-harness",
  "results-browser",
);

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
  "environment",
  "browser_name",
  "scenario_path",
  "repetitions",
  "browser_elapsed_ms",
  "browser_task_ms",
  "browser_script_ms",
];

const EVENTS_FIELDS = [
  "run_id",
  "warmup",
  "sandbox_create_ms",
  "bundle_eval_ms",
  "webapi_expose_ms",
  "webapi_exposed_count",
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

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

function usage() {
  console.error(
    [
      "Usage:",
      "  node performance-harness/run-browser-scenario.mjs --mode <native|sandbox> --library <name> --workload-id <id> --scenario <path> [options]",
      "",
      "Options:",
      "  --label <label>         Optional label recorded in CSV output",
      "  --iterations <n>        Measured runs; defaults to 5",
      "  --warmup <n>            Warmup runs; defaults to 1",
      "  --repetitions <n>       Workload executions per run; defaults to 1",
      "  --sample-ms <n>         CDP sampling interval in ms; defaults to 100",
      "  --out-dir <path>        Output directory; defaults to performance-harness/results-browser",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    label: "",
    iterations: 5,
    repetitions: 1,
    warmup: 1,
    sampleMs: 100,
    outDir: defaultOutputDir,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

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
      case "--scenario":
        options.scenario = next;
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
      case "--repetitions":
        options.repetitions = Number(next);
        index += 1;
        break;
      case "--sample-ms":
        options.sampleMs = Number(next);
        index += 1;
        break;
      case "--out-dir":
        options.outDir = path.resolve(repoRoot, next);
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
  if (!options.library) {
    throw new Error("Expected --library <name>.");
  }
  if (!options.workloadId) {
    throw new Error("Expected --workload-id <id>.");
  }
  if (!options.scenario) {
    throw new Error("Expected --scenario <path>.");
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) {
    throw new Error("--iterations must be a positive integer.");
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0) {
    throw new Error("--warmup must be a non-negative integer.");
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer.");
  }
  if (!Number.isFinite(options.sampleMs) || options.sampleMs <= 0) {
    throw new Error("--sample-ms must be a positive number.");
  }

  options.scenarioPath = path.resolve(repoRoot, options.scenario);
  options.scenarioPathRelative = path.relative(repoRoot, options.scenarioPath).replaceAll("\\", "/");
  return options;
}

function formatInvocation(options) {
  const segments = [
    "node",
    "performance-harness/run-browser-scenario.mjs",
    "--mode",
    options.mode,
    "--library",
    options.library,
    "--workload-id",
    options.workloadId,
    "--scenario",
    options.scenarioPathRelative,
  ];

  if (options.label) {
    segments.push("--label", options.label);
  }
  if (options.iterations !== 5) {
    segments.push("--iterations", String(options.iterations));
  }
  if (options.warmup !== 1) {
    segments.push("--warmup", String(options.warmup));
  }
  if (options.repetitions !== 1) {
    segments.push("--repetitions", String(options.repetitions));
  }
  if (options.sampleMs !== 100) {
    segments.push("--sample-ms", String(options.sampleMs));
  }

  return segments.join(" ");
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

  const existingHeader = readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0];
  if (existingHeader !== fields.join(",")) {
    throw new Error(
      `CSV header mismatch for ${filePath}. Use a fresh --out-dir or remove the existing file.`,
    );
  }

  appendFileSync(filePath, line, "utf8");
}

function ensureOutputDir(outDir) {
  mkdirSync(outDir, { recursive: true });
}

async function loadConfiguredSandboxLibraries() {
  if (!existsSync(sandboxConfigPath)) {
    return [];
  }

  const configUrl = pathToFileURL(sandboxConfigPath);
  configUrl.search = `mtime=${Date.now()}`;
  const configModule = await import(configUrl.href);
  const sandboxConfig = configModule.default ?? configModule;
  return Object.keys(sandboxConfig ?? {});
}

async function validateSandboxTarget(options) {
  if (options.mode !== "sandbox") {
    return;
  }

  const configuredLibraries = await loadConfiguredSandboxLibraries();
  if (configuredLibraries.includes(options.library)) {
    return;
  }

  const configuredLabel = configuredLibraries.length > 0
    ? configuredLibraries.join(", ")
    : "none";
  throw new Error(
    [
      `Sandbox mode requested for "${options.library}", but .sandbox/sandbox.config.js does not enable that library.`,
      `Currently configured sandbox libraries: ${configuredLabel}.`,
      "Enable the target library in the sandbox config before collecting sandbox browser measurements.",
    ].join(" "),
  );
}

function validateScenarioExists(options) {
  if (!existsSync(options.scenarioPath)) {
    throw new Error(
      `Scenario file does not exist: ${options.scenarioPathRelative}. Check --scenario before collecting browser measurements.`,
    );
  }

  if (!statSync(options.scenarioPath).isFile()) {
    throw new Error(
      `Scenario path is not a file: ${options.scenarioPathRelative}. Check --scenario before collecting browser measurements.`,
    );
  }
}

function emptyEvents() {
  return {
    sandbox_create_ms: 0,
    bundle_eval_ms: 0,
    webapi_expose_ms: 0,
    webapi_exposed_count: 0,
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

function createTempSiteRoot(mode, library, workloadId) {
  const tempRoot = path.join(
    tmpdir(),
    "spike-quickjs-browser-performance",
    `${mode}-${library}-${workloadId}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(tempRoot, { recursive: true });
  return tempRoot;
}

function writeHarnessHtml(tempRoot) {
  writeFileSync(
    path.join(tempRoot, "index.html"),
    [
      "<!doctype html>",
      "<html>",
      "<head>",
      '  <meta charset="utf-8">',
      "  <title>spike-quickjs performance harness</title>",
      "</head>",
      "<body>",
      "  <main id=\"app\"></main>",
      "</body>",
      "</html>",
    ].join("\n"),
    "utf8",
  );
}

function compileWebpack(config) {
  const webpack = require("webpack");
  return new Promise((resolvePromise, rejectPromise) => {
    webpack(config, (error, stats) => {
      if (error) {
        rejectPromise(error);
        return;
      }

      if (!stats || stats.hasErrors()) {
        rejectPromise(new Error(stats?.toString({ all: false, errors: true, warnings: true }) ?? "Webpack compilation failed."));
        return;
      }

      resolvePromise(stats);
    });
  });
}

function getContentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function createStaticServer(rootDir) {
  const server = http.createServer((request, response) => {
    const requestPath = request.url === "/" ? "/index.html" : request.url ?? "/";
    const normalizedPath = path.normalize(decodeURIComponent(requestPath.split("?")[0]));
    const filePath = path.resolve(rootDir, `.${normalizedPath}`);

    if (!filePath.startsWith(rootDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    try {
      const body = readFileSync(filePath);
      response.writeHead(200, {
        "Content-Type": getContentType(filePath),
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500);
      response.end(error.message);
    }
  });

  return new Promise((resolvePromise, rejectPromise) => {
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolvePromise({
        server,
        origin: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

function metricValue(metrics, name) {
  return metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
}

function bytesToMb(value) {
  return value / (1024 * 1024);
}

function createFailureResult(error) {
  return {
    wall_ms: 0,
    completed: false,
    exit_code: 1,
    events: emptyEvents(),
    crossings: emptyCrossings(),
    error: {
      name: error.name ?? "Error",
      message: error.message ?? String(error),
      stack: error.stack ?? "",
    },
  };
}

async function runIteration(browser, origin, sampleMs) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const client = await page.context().newCDPSession(page);
  let sampler = null;
  const pageErrors = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error);
  });

  try {
    await client.send("Performance.enable");
    await page.goto(`${origin}/`, { waitUntil: "load" });

    const baselineMetrics = await client.send("Performance.getMetrics");
    let peakHeapBytes = metricValue(baselineMetrics, "JSHeapUsedSize");

    sampler = setInterval(async () => {
      try {
        const sample = await client.send("Performance.getMetrics");
        peakHeapBytes = Math.max(
          peakHeapBytes,
          metricValue(sample, "JSHeapUsedSize"),
        );
      } catch {
        // Ignore polling races during page teardown.
      }
    }, sampleMs);

    await page.addScriptTag({
      type: "module",
      url: `${origin}/dist/browser-scenario.js`,
    });

    const handle = await page.waitForFunction(
      () => {
        const result = globalThis.__SANDBOX_PERF_RESULT__;
        return result && result.status === "finished" ? result : undefined;
      },
      { timeout: 0 },
    );
    const result = await handle.jsonValue();

    const finalMetrics = await client.send("Performance.getMetrics");
    peakHeapBytes = Math.max(peakHeapBytes, metricValue(finalMetrics, "JSHeapUsedSize"));

    return {
      pageResult: result,
      browserMetrics: {
        peak_heap_used_mb: bytesToMb(peakHeapBytes),
        final_heap_used_mb: bytesToMb(metricValue(finalMetrics, "JSHeapUsedSize")),
        browser_task_ms:
          (metricValue(finalMetrics, "TaskDuration") -
            metricValue(baselineMetrics, "TaskDuration")) * 1000,
        browser_script_ms:
          (metricValue(finalMetrics, "ScriptDuration") -
            metricValue(baselineMetrics, "ScriptDuration")) * 1000,
      },
    };
  } catch (error) {
    const surfacedError = pageErrors[0] ?? error;
    try {
      const finalMetrics = await client.send("Performance.getMetrics");
      return {
        pageResult: createFailureResult(surfacedError),
        browserMetrics: {
          peak_heap_used_mb: bytesToMb(metricValue(finalMetrics, "JSHeapUsedSize")),
          final_heap_used_mb: bytesToMb(metricValue(finalMetrics, "JSHeapUsedSize")),
          browser_task_ms: 0,
          browser_script_ms: 0,
        },
      };
    } catch {
      return {
        pageResult: createFailureResult(surfacedError),
        browserMetrics: {
          peak_heap_used_mb: 0,
          final_heap_used_mb: 0,
          browser_task_ms: 0,
          browser_script_ms: 0,
        },
      };
    }
  } finally {
    if (sampler) {
      clearInterval(sampler);
    }
    await context.close();
  }
}

async function buildBrowserSite(options) {
  const {
    createBrowserWebpackConfig,
  } = require("./browser/webpack.browser.config.cjs");
  const tempRoot = createTempSiteRoot(options.mode, options.library, options.workloadId);
  writeHarnessHtml(tempRoot);

  const webpackConfig = createBrowserWebpackConfig({
    repoRoot,
    buildMode: options.mode,
    repetitions: options.repetitions,
    scenarioPath: options.scenarioPath,
    tempRoot,
  });

  await compileWebpack(webpackConfig);
  return tempRoot;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  validateScenarioExists(options);
  await validateSandboxTarget(options);
  ensureOutputDir(options.outDir);

  const tempRoot = await buildBrowserSite(options);
  const { server, origin } = await createStaticServer(tempRoot);
  const browser = await chromium.launch({ headless: true });
  const formattedCommand = formatInvocation(options);

  try {
    const runsCsvPath = path.join(options.outDir, "runs.csv");
    const eventsCsvPath = path.join(options.outDir, "events.csv");
    const crossingsCsvPath = path.join(options.outDir, "crossings.csv");
    const totalRuns = options.warmup + options.iterations;

    for (let iteration = 0; iteration < totalRuns; iteration += 1) {
      const warmup = iteration < options.warmup;
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.mode}-${randomUUID().slice(0, 8)}`;
      console.log(
        `[perf-harness:browser] ${warmup ? "Warmup" : "Measured"} run ${iteration + 1}/${totalRuns}: ${options.library} ${options.scenarioPathRelative}`,
      );

      const browserIterationStartedAt = performance.now();
      const { pageResult, browserMetrics } = await runIteration(
        browser,
        origin,
        options.sampleMs,
      );
      const browserElapsedMs = performance.now() - browserIterationStartedAt;
      const exitCode = pageResult.exit_code ?? (pageResult.completed ? 0 : 1);
      if (exitCode != 0 && pageResult.error) {
        console.error(
          `[perf-harness:browser] ${options.mode} ${options.library}:${options.workloadId} failed: ${pageResult.error.message}`,
        );
      }

      appendCsvRow(runsCsvPath, RUNS_FIELDS, {
        run_id: runId,
        timestamp: new Date().toISOString(),
        library: options.library,
        workload_id: options.workloadId,
        label: options.label,
        mode: options.mode,
        iteration,
        warmup,
        command: formattedCommand,
        wall_ms: pageResult.wall_ms ?? 0,
        cpu_user_ms: 0,
        cpu_system_ms: 0,
        peak_rss_mb: 0,
        peak_heap_used_mb: browserMetrics.peak_heap_used_mb ?? 0,
        peak_external_mb: 0,
        final_rss_mb: 0,
        final_heap_used_mb: browserMetrics.final_heap_used_mb ?? 0,
        final_external_mb: 0,
        exit_code: exitCode,
        completed: pageResult.completed ?? exitCode === 0,
        environment: "browser",
        browser_name: "chromium",
        scenario_path: options.scenarioPathRelative,
        repetitions: options.repetitions,
        browser_elapsed_ms: browserElapsedMs,
        browser_task_ms: browserMetrics.browser_task_ms ?? 0,
        browser_script_ms: browserMetrics.browser_script_ms ?? 0,
      });

      appendCsvRow(eventsCsvPath, EVENTS_FIELDS, {
        run_id: runId,
        warmup,
        ...emptyEvents(),
        ...(pageResult.events ?? {}),
      });

      appendCsvRow(crossingsCsvPath, CROSSINGS_FIELDS, {
        run_id: runId,
        warmup,
        ...emptyCrossings(),
        ...(pageResult.crossings ?? {}),
      });
    }
  } finally {
    await browser.close();
    await closeServer(server);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[perf-harness:browser] ${error.stack || error.message}`);
  process.exitCode = 1;
});
