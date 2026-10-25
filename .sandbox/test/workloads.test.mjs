import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSandbox } from "./helpers/fixture-sandbox.mjs";

const LIBRARY_BODY = `
  globalThis.libraryState = "from-library";
  return { add: (a, b) => a + b };
`;

/**
 * Builds a workload definition in the shape generated proxies pass to the runtime.
 *
 * @param {string} name Workload policy key.
 * @param {string} exportsSource Object literal source for the workload exports.
 * @returns {{name: string, globalName: string, code: string}} Workload definition.
 */
function workload(name, exportsSource) {
  const globalName = `__SANDBOXED_WORKLOAD_${name}__`;
  return { name, globalName, code: `var ${globalName} = ${exportsSource};` };
}

const SUM_WORKLOAD = workload("sum", `{
  sumAll: (values) => values.reduce((total, value) => __SANDBOXED_LIB__.add(total, value), 0),
  readLibraryState: () => globalThis.libraryState,
  loads: (globalThis.sumLoads = (globalThis.sumLoads ?? 0) + 1),
}`);

test("a workload runs in the library context and can call the library", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY);
  const loaded = sandbox.loadWorkload(SUM_WORKLOAD);
  assert.equal(loaded.sumAll([1, 2, 3]), 6);
  assert.equal(loaded.readLibraryState(), "from-library");
});

test("a workload is evaluated once and its bound exports are reused", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY);
  const first = sandbox.loadWorkload(SUM_WORKLOAD);
  const second = sandbox.loadWorkload(SUM_WORKLOAD);
  assert.equal(first, second);
  assert.equal(sandbox.workloads.sum, first);
  assert.equal(first.loads, 1);
});

test("workloads listed at creation are loaded before the sandbox is returned", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY, { workloads: [SUM_WORKLOAD] });
  assert.equal(sandbox.workloads.sum.sumAll([4, 5]), 9);
});

test("workloads in different sandboxes do not share state", async (t) => {
  const first = await createFixtureSandbox(t, LIBRARY_BODY, { libraryName: "first" });
  const second = await createFixtureSandbox(t, LIBRARY_BODY, { libraryName: "second" });
  assert.equal(first.loadWorkload(SUM_WORKLOAD).loads, 1);
  assert.equal(second.loadWorkload(SUM_WORKLOAD).loads, 1);
});
