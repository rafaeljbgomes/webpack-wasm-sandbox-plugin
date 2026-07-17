import assert from "node:assert/strict";
import test from "node:test";

import {
  bindWebApi,
  makeCallable,
} from "../.sandbox/membrane/forward-membrane.js";
import { bindSandboxFunction } from "../.sandbox/membrane/reverse-membrane.js";
import {
  getRuntimeMetricsSnapshot,
  setRuntimeMetricsEnabled,
} from "./runtime-metrics.js";

const PERF_STATE_KEY = Symbol.for("spike-quickjs.performanceMetrics");

function resetMetrics() {
  delete globalThis[PERF_STATE_KEY];
  setRuntimeMetricsEnabled(true);
}

test("forward function calls record arguments and successful results", () => {
  resetMetrics();

  const callable = makeCallable((left, right) => left + right, globalThis);
  assert.equal(callable(2, 3), 5);

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.forward_vm_to_host_count, 2);
  assert.equal(crossings.forward_host_to_vm_count, 1);
  assert.equal(crossings.reverse_host_to_vm_count, 0);
});

test("forward constructor fallback records one argument and one result", () => {
  resetMetrics();

  class Example {
    constructor(value) {
      this.value = value;
    }
  }

  const callable = makeCallable(Example, globalThis);
  const instance = callable("value");
  assert.equal(instance.value, "value");

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.forward_vm_to_host_count, 1);
  assert.equal(crossings.forward_host_to_vm_count, 2);
});

test("forward getters and setters record their transferred values", () => {
  resetMetrics();

  const source = { value: 1 };
  const exposed = bindWebApi(source);
  assert.equal(exposed.value, 1);
  exposed.value = 2;
  assert.equal(source.value, 2);

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.forward_host_to_vm_count, 1);
  assert.equal(crossings.forward_vm_to_host_count, 1);
});

test("forward failures record arguments but no result", () => {
  resetMetrics();

  const callable = makeCallable(() => {
    throw new Error("expected");
  }, globalThis);
  assert.throws(() => callable("argument"), /expected/);

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.forward_vm_to_host_count, 1);
  assert.equal(crossings.forward_host_to_vm_count, 0);
});

test("reverse membrane calls populate only reverse metrics", () => {
  resetMetrics();

  const arena = {
    evalCode() {
      return (value) => value.toUpperCase();
    },
  };
  const bound = bindSandboxFunction(
    arena,
    () => {},
    "__SANDBOXED_LIB__.example",
    0,
    {},
  );
  assert.equal(bound("value"), "VALUE");

  const { crossings } = getRuntimeMetricsSnapshot();
  assert.equal(crossings.reverse_host_to_vm_count, 1);
  assert.equal(crossings.reverse_vm_to_host_count, 1);
  assert.equal(crossings.forward_host_to_vm_count, 0);
});
