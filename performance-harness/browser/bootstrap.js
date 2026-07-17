import {
  getRuntimeMetricsSnapshot,
  initializeRuntimeMetrics,
  setRuntimeMetricsEnabled,
  setRuntimeMetricsPhase,
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

  let scenarioTotalMs = 0;
  let completedRepetitions = 0;
  let completed = false;
  let exitCode = 1;
  let failure = null;
  const repetitions = __SANDBOX_PERF_REPETITIONS__;

  setRuntimeMetricsEnabled(true);
  initializeRuntimeMetrics();
  setRuntimeMetricsPhase("startup");

  try {
    const scenarioModule = await import("__SANDBOX_PERF_SCENARIO__");
    const scenarioExport = scenarioModule.default;

    if (typeof scenarioExport !== "function") {
      throw new Error("Scenario must export a default function.");
    }

    if (!Number.isInteger(repetitions) || repetitions < 1) {
      throw new Error("Harness repetitions must be a positive integer.");
    }

    setRuntimeMetricsPhase("scenario");
    for (let iteration = 0; iteration < repetitions; iteration += 1) {
      const iterationStartedAt = performance.now();
      try {
        await scenarioExport();
        completedRepetitions += 1;
      } finally {
        scenarioTotalMs += performance.now() - iterationStartedAt;
      }
    }

    completed = true;
    exitCode = 0;
  } catch (error) {
    failure = error;
  }

  const runtimeMetrics = getRuntimeMetricsSnapshot();
  window.__SANDBOX_PERF_RESULT__ = {
    status: "finished",
    scenario_total_ms: scenarioTotalMs,
    scenario_ms: scenarioTotalMs / repetitions,
    completed_repetitions: completedRepetitions,
    completed,
    exit_code: exitCode,
    events: runtimeMetrics.events,
    crossings: runtimeMetrics.crossings,
    phase_metrics: runtimeMetrics.phases,
    error: serializeError(failure),
  };
}

runScenario();
