import {
  getRuntimeMetricsSnapshot,
  initializeRuntimeMetrics,
  setRuntimeMetricsEnabled,
} from "../runtime-metrics.js";

function serializeError(error) {
  if (!error) {
    return null;
  }

  return {
    name: error.name ?? "Error",
    message: error.message ?? String(error),
    stack: error.stack ?? "",
  };
}

async function runScenario() {
  window.__SANDBOX_PERF_RESULT__ = {
    status: "running",
  };

  let context = {};
  let scenario = {};
  let runWorkload = null;
  let measuredWallMs = 0;
  let completed = false;
  let exitCode = 1;
  let failure = null;
  let teardownStarted = false;
  const repetitions = __SANDBOX_PERF_REPETITIONS__;

  setRuntimeMetricsEnabled(true);
  initializeRuntimeMetrics();

  try {
    const scenarioModule = await import("__SANDBOX_PERF_SCENARIO__");
    const scenarioExport = scenarioModule.default;

    if (typeof scenarioExport === "function") {
      runWorkload = scenarioExport;
    } else if (scenarioExport && typeof scenarioExport.run === "function") {
      scenario = scenarioExport;
      runWorkload = scenarioExport.run.bind(scenarioExport);
    } else {
      throw new Error("Scenario must export a default function or an object with a run(context) function.");
    }

    if (!Number.isInteger(repetitions) || repetitions < 1) {
      throw new Error("Harness repetitions must be a positive integer.");
    }

    context = (await scenario.setup?.()) ?? {};
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const iterationStartedAt = performance.now();
      try {
        await runWorkload(context);
      } finally {
        measuredWallMs += performance.now() - iterationStartedAt;
      }
    }

    teardownStarted = true;
    await scenario.teardown?.(context);
    completed = true;
    exitCode = 0;
  } catch (error) {
    failure = error;

    if (!teardownStarted) {
      try {
        await scenario.teardown?.(context);
      } catch (teardownError) {
        if (!failure) {
          failure = teardownError;
        }
      }
    }
  }

  const runtimeMetrics = getRuntimeMetricsSnapshot();
  window.__SANDBOX_PERF_RESULT__ = {
    status: "finished",
    wall_ms: measuredWallMs,
    completed,
    exit_code: exitCode,
    events: runtimeMetrics.events,
    crossings: runtimeMetrics.crossings,
    error: serializeError(failure),
  };
}

runScenario();
