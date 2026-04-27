const PERF_STATE_KEY = Symbol.for("spike-quickjs.performanceMetrics");
const PERF_ENABLED_KEY = Symbol.for("spike-quickjs.performanceMetrics.enabled");
const MB = 1024 * 1024;
const MAX_ESTIMATE_DEPTH = 4;
const MAX_ESTIMATE_NODES = 256;
const HISTOGRAM_BOUNDS = [
  16,
  32,
  64,
  128,
  256,
  512,
  1024,
  2048,
  4096,
  8192,
  16384,
  32768,
  65536,
  131072,
  262144,
  524288,
  1048576,
  2097152,
  4194304,
  8388608,
  16777216,
  33554432,
  67108864,
  Number.POSITIVE_INFINITY,
];

function isPerfEnabled() {
  if (globalThis[PERF_ENABLED_KEY] === true) {
    return true;
  }

  return (
    typeof process !== "undefined" &&
    process?.env?.SANDBOX_PERF_ENABLED === "1"
  );
}

function byteLengthOfString(value) {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(value, "utf8");
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(value).length;
  }
  return value.length * 2;
}

function createTrafficSummary() {
  return {
    count: 0,
    totalBytes: 0,
    maxBytes: 0,
    histogram: HISTOGRAM_BOUNDS.map(() => 0),
  };
}

function createState() {
  return {
    events: {
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
    },
    currentTempObjectCount: 0,
    crossings: {
      host_to_vm: createTrafficSummary(),
      vm_to_host: createTrafficSummary(),
    },
  };
}

function getState() {
  if (!isPerfEnabled()) {
    return null;
  }

  if (!globalThis[PERF_STATE_KEY]) {
    globalThis[PERF_STATE_KEY] = createState();
  }

  return globalThis[PERF_STATE_KEY];
}

function safeObjectKeys(value) {
  try {
    return Object.keys(value);
  } catch {
    return [];
  }
}

function estimatePayloadSize(value, depth = 0, seen = new WeakSet(), stats = { nodes: 0 }) {
  if (value === null || value === undefined) {
    return 4;
  }

  const valueType = typeof value;
  if (valueType === "string") {
    return byteLengthOfString(value);
  }
  if (valueType === "number" || valueType === "bigint") {
    return 8;
  }
  if (valueType === "boolean") {
    return 4;
  }
  if (valueType === "symbol") {
    return 16;
  }
  if (valueType === "function") {
    return 64;
  }

  if (depth >= MAX_ESTIMATE_DEPTH || stats.nodes >= MAX_ESTIMATE_NODES) {
    return 128;
  }

  if (typeof ArrayBuffer !== "undefined") {
    if (value instanceof ArrayBuffer) {
      return value.byteLength;
    }
    if (ArrayBuffer.isView(value)) {
      return value.byteLength ?? 0;
    }
  }

  if (value instanceof Date) {
    return 16;
  }
  if (value instanceof RegExp) {
    return byteLengthOfString(value.toString());
  }
  if (value instanceof Error) {
    return (
      byteLengthOfString(value.name ?? "") +
      byteLengthOfString(value.message ?? "") +
      byteLengthOfString(value.stack ?? "")
    );
  }

  if (seen.has(value)) {
    return 0;
  }
  seen.add(value);
  stats.nodes += 1;

  if (Array.isArray(value)) {
    let total = 24;
    const limit = Math.min(value.length, 32);
    for (let index = 0; index < limit; index += 1) {
      total += estimatePayloadSize(value[index], depth + 1, seen, stats);
    }
    return total;
  }

  let total = 32;
  const keys = safeObjectKeys(value).slice(0, 32);
  for (const key of keys) {
    total += byteLengthOfString(key);
    try {
      total += estimatePayloadSize(value[key], depth + 1, seen, stats);
    } catch {
      total += 64;
    }
  }

  return total;
}

function observeHistogram(summary, sizeBytes) {
  for (let index = 0; index < HISTOGRAM_BOUNDS.length; index += 1) {
    if (sizeBytes <= HISTOGRAM_BOUNDS[index]) {
      summary.histogram[index] += 1;
      return;
    }
  }
}

function observeCrossing(direction, sizeBytes) {
  const state = getState();
  if (!state) {
    return;
  }

  const summary = state.crossings[direction];
  if (!summary) {
    return;
  }

  summary.count += 1;
  summary.totalBytes += sizeBytes;
  summary.maxBytes = Math.max(summary.maxBytes, sizeBytes);
  observeHistogram(summary, sizeBytes);
}

function quantileFromHistogram(summary, quantile) {
  if (!summary.count) {
    return 0;
  }

  const target = Math.ceil(summary.count * quantile);
  let cumulative = 0;

  for (let index = 0; index < summary.histogram.length; index += 1) {
    cumulative += summary.histogram[index];
    if (cumulative >= target) {
      const bound = HISTOGRAM_BOUNDS[index];
      return Number.isFinite(bound) ? bound : summary.maxBytes;
    }
  }

  return summary.maxBytes;
}

export function initializeRuntimeMetrics() {
  return getState();
}

export function setRuntimeMetricsEnabled(enabled = true) {
  globalThis[PERF_ENABLED_KEY] = Boolean(enabled);
  return enabled ? initializeRuntimeMetrics() : null;
}

export function recordDuration(metricName, durationMs) {
  const state = getState();
  if (!state) {
    return;
  }

  state.events[metricName] = (state.events[metricName] ?? 0) + durationMs;
}

export function incrementCounter(metricName, delta = 1) {
  const state = getState();
  if (!state) {
    return;
  }

  state.events[metricName] = (state.events[metricName] ?? 0) + delta;
}

export function recordMembraneCall(durationMs) {
  incrementCounter("membrane_call_count", 1);
  recordDuration("membrane_call_ms", durationMs);
}

export function recordMarshal(durationMs, direction, value) {
  incrementCounter("marshal_count", 1);
  recordDuration("marshal_ms", durationMs);
}

export function recordUnmarshal(durationMs, direction, value) {
  incrementCounter("unmarshal_count", 1);
  recordDuration("unmarshal_ms", durationMs);
}

export function recordCrossing(direction, value) {
  const state = getState();
  if (!state) {
    return;
  }

  const normalizedDirection =
    direction === "host_to_vm" ? "host_to_vm" : "vm_to_host";
  observeCrossing(normalizedDirection, estimatePayloadSize(value));
}

export function observeWrappedReturn() {
  incrementCounter("wrap_returned_count", 1);
}

export function observeCreateInstance() {
  incrementCounter("create_instance_count", 1);
}

export function observeTempObjectCreated() {
  const state = getState();
  if (!state) {
    return;
  }

  state.currentTempObjectCount += 1;
  state.events.temp_object_peak_count = Math.max(
    state.events.temp_object_peak_count,
    state.currentTempObjectCount,
  );
}

export function observeTempObjectReset() {
  const state = getState();
  if (!state) {
    return;
  }

  state.currentTempObjectCount = 0;
}

export function getRuntimeMetricsSnapshot() {
  const state = getState();
  if (!state) {
    return {
      events: createState().events,
      crossings: {
        host_to_vm_count: 0,
        vm_to_host_count: 0,
        host_to_vm_total_bytes: 0,
        vm_to_host_total_bytes: 0,
        crossing_size_median_bytes: 0,
        crossing_size_p95_bytes: 0,
        crossing_size_max_bytes: 0,
      },
    };
  }

  const hostToVm = state.crossings.host_to_vm;
  const vmToHost = state.crossings.vm_to_host;
  const combinedHistogram = HISTOGRAM_BOUNDS.map(
    (_, index) => hostToVm.histogram[index] + vmToHost.histogram[index],
  );
  const combinedSummary = {
    count: hostToVm.count + vmToHost.count,
    maxBytes: Math.max(hostToVm.maxBytes, vmToHost.maxBytes),
    histogram: combinedHistogram,
  };

  return {
    events: { ...state.events },
    crossings: {
      host_to_vm_count: hostToVm.count,
      vm_to_host_count: vmToHost.count,
      host_to_vm_total_bytes: hostToVm.totalBytes,
      vm_to_host_total_bytes: vmToHost.totalBytes,
      crossing_size_median_bytes: quantileFromHistogram(combinedSummary, 0.5),
      crossing_size_p95_bytes: quantileFromHistogram(combinedSummary, 0.95),
      crossing_size_max_bytes: combinedSummary.maxBytes,
    },
  };
}

export function convertBytesToMb(value) {
  return value / MB;
}
