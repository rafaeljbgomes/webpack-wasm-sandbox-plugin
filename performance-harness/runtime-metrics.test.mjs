import assert from "node:assert/strict";
import test from "node:test";

import {
  getRuntimeMetricsSnapshot,
  recordCrossing,
  setRuntimeMetricsEnabled,
  setRuntimeMetricsPhase,
} from "./runtime-metrics.js";

const PERF_STATE_KEY = Symbol.for("spike-quickjs.performanceMetrics");

function resetMetrics() {
  delete globalThis[PERF_STATE_KEY];
  setRuntimeMetricsEnabled(true);
}

test("crossings are separated by membrane and combined in totals", () => {
  resetMetrics();

  recordCrossing("forward", "vm_to_host", "forward");
  recordCrossing("reverse", "host_to_vm", "reverse");

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.forward_vm_to_host_count, 1);
  assert.equal(crossings.reverse_host_to_vm_count, 1);
  assert.equal(crossings.vm_to_host_count, 1);
  assert.equal(crossings.host_to_vm_count, 1);
  assert.equal(
    crossings.vm_to_host_total_bytes,
    crossings.forward_vm_to_host_total_bytes,
  );
  assert.equal(
    crossings.host_to_vm_total_bytes,
    crossings.reverse_host_to_vm_total_bytes,
  );
});

test("phase buckets remain isolated", () => {
  resetMetrics();

  recordCrossing("forward", "host_to_vm", "startup");
  setRuntimeMetricsPhase("scenario");
  recordCrossing("reverse", "vm_to_host", "scenario");

  const snapshot = getRuntimeMetricsSnapshot();
  assert.equal(snapshot.phases.startup.crossings.forward_host_to_vm_count, 1);
  assert.equal(snapshot.phases.startup.crossings.reverse_vm_to_host_count, 0);
  assert.equal(snapshot.phases.scenario.crossings.forward_host_to_vm_count, 0);
  assert.equal(snapshot.phases.scenario.crossings.reverse_vm_to_host_count, 1);
});

test("payload distribution metrics are retained per membrane and combined", () => {
  resetMetrics();

  recordCrossing("forward", "host_to_vm", "12345678");
  recordCrossing("forward", "host_to_vm", "12345678901234567890");
  recordCrossing("reverse", "vm_to_host", "x".repeat(100));

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.forward_crossing_size_median_bytes, 16);
  assert.equal(crossings.forward_crossing_size_p95_bytes, 32);
  assert.equal(crossings.forward_crossing_size_max_bytes, 20);
  assert.equal(crossings.reverse_crossing_size_median_bytes, 128);
  assert.equal(crossings.reverse_crossing_size_max_bytes, 100);
  assert.equal(crossings.crossing_size_median_bytes, 32);
  assert.equal(crossings.crossing_size_p95_bytes, 128);
  assert.equal(crossings.crossing_size_max_bytes, 100);
});
