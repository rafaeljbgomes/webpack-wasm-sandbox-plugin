import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  convertBytesToMb,
  getRuntimeMetricsSnapshot,
  initializeRuntimeMetrics,
  setRuntimeMetricsEnabled,
} from "./runtime-metrics.js";

const outputPath = process.env.SANDBOX_PERF_OUTPUT;
const outputDir = process.env.SANDBOX_PERF_OUTPUT_DIR;
const sampleIntervalMs = Number(process.env.SANDBOX_PERF_SAMPLE_MS ?? "100");

if (process.env.SANDBOX_PERF_ENABLED === "1" && (outputPath || outputDir)) {
  setRuntimeMetricsEnabled(true);
  initializeRuntimeMetrics();

  const startedAt = performance.now();
  const startedCpu = process.cpuUsage();
  const memoryPeaks = {
    rss: 0,
    heapUsed: 0,
    external: 0,
  };
  const memoryFinal = {
    rss: 0,
    heapUsed: 0,
    external: 0,
  };

  let wroteMetrics = false;

  function sampleMemory() {
    const snapshot = process.memoryUsage();
    memoryPeaks.rss = Math.max(memoryPeaks.rss, snapshot.rss);
    memoryPeaks.heapUsed = Math.max(memoryPeaks.heapUsed, snapshot.heapUsed);
    memoryPeaks.external = Math.max(memoryPeaks.external, snapshot.external);
    memoryFinal.rss = snapshot.rss;
    memoryFinal.heapUsed = snapshot.heapUsed;
    memoryFinal.external = snapshot.external;
  }

  function writeMetrics(exitCode) {
    if (wroteMetrics) {
      return;
    }

    wroteMetrics = true;
    clearInterval(sampler);
    sampleMemory();

    const cpu = process.cpuUsage(startedCpu);
    const runtimeMetrics = getRuntimeMetricsSnapshot();
    const payload = JSON.stringify(
      {
        pid: process.pid,
        run: {
          wall_ms: performance.now() - startedAt,
          cpu_user_ms: cpu.user / 1000,
          cpu_system_ms: cpu.system / 1000,
          peak_rss_mb: convertBytesToMb(memoryPeaks.rss),
          peak_heap_used_mb: convertBytesToMb(memoryPeaks.heapUsed),
          peak_external_mb: convertBytesToMb(memoryPeaks.external),
          final_rss_mb: convertBytesToMb(memoryFinal.rss),
          final_heap_used_mb: convertBytesToMb(memoryFinal.heapUsed),
          final_external_mb: convertBytesToMb(memoryFinal.external),
          exit_code: exitCode ?? process.exitCode ?? 0,
          completed: true,
        },
        events: runtimeMetrics.events,
        crossings: runtimeMetrics.crossings,
      },
      null,
      2,
    );

    if (outputPath) {
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, payload, "utf8");
    }

    if (outputDir) {
      mkdirSync(outputDir, { recursive: true });
      const fragmentPath = `${outputDir}/${process.pid}-${randomUUID()}.json`;
      writeFileSync(fragmentPath, payload, "utf8");
    }
  }

  sampleMemory();
  const sampler = setInterval(sampleMemory, sampleIntervalMs);
  if (typeof sampler.unref === "function") {
    sampler.unref();
  }

  process.on("exit", (exitCode) => {
    writeMetrics(exitCode);
  });
}
