import assert from "node:assert/strict";
import test from "node:test";
import generatorModule from "../src/proxy-generator.ts";

const { ProxyGenerator } = generatorModule;

/**
 * Generates a proxy module for the `fixture` library.
 *
 * @param {object} libraryData Parsed export metadata.
 * @param {object[]} [workloads] Workloads sharing the library sandbox.
 * @param {string[]} [permissions] Compiler-selected permissions; omitted to test the default.
 * @returns {string} Generated module source.
 */
function generate(libraryData, workloads, permissions) {
  return new ProxyGenerator().generate(libraryData, "fixture", workloads, permissions);
}

/**
 * Reads back the permission list passed to `createSandbox()`.
 *
 * @param {string} source Generated module source.
 * @returns {unknown} The parsed permission literal.
 */
function serialisedPermissions(source) {
  const match = source.match(/\{ permissions: (.*) \}\n\);/);
  assert.ok(match, "createSandbox() call with a permissions literal");
  return JSON.parse(match[1]);
}

/**
 * Counts non-overlapping occurrences of a literal fragment.
 *
 * @param {string} source Text to search.
 * @param {string} fragment Literal fragment.
 * @returns {number} Occurrence count.
 */
function count(source, fragment) {
  return source.split(fragment).length - 1;
}

test("serialises an explicit empty permission list", () => {
  const source = generate({ exportedNames: ["add"] }, [], []);

  assert.deepEqual(serialisedPermissions(source), []);
  assert.ok(source.includes("{ permissions: [] }"));
});

test("serialises an explicit permission list exactly and in order", () => {
  const source = generate({ exportedNames: ["add"] }, [], ["Intl", "crypto"]);

  assert.deepEqual(serialisedPermissions(source), ["Intl", "crypto"]);
});

test("defaults omitted permissions to an empty list", () => {
  assert.deepEqual(serialisedPermissions(generate({ exportedNames: ["add"] })), []);
});

test("never defers permissions to the runtime policy module", () => {
  // ADR 25: the runtime falls back to sandbox.config.js only when permissions are omitted.
  const source = generate({ exportedNames: ["add"] }, [], ["crypto"]);

  assert.equal(source.includes("sandbox.config"), false);
  assert.equal(count(source, "SandboxManager.createSandbox("), 1);
});

test("releases the job pump only after the sandbox is created", () => {
  const source = generate({ exportedNames: ["add"] });
  const created = source.indexOf("await SandboxManager.createSandbox(");
  const released = source.indexOf("librarySandbox.unrefPump()");

  assert.ok(created >= 0 && released > created);
  assert.equal(count(source, "unrefPump()"), 1);
});

test("emits one binding per export name", () => {
  const source = generate({ exportedNames: ["sub", "add", "sub"] });

  assert.equal(count(source, "export { _export_sub as sub };"), 1);
  assert.equal(count(source, "export { _export_add as add };"), 1);
});

test("aliases reserved-word export names through a safe identifier", () => {
  const source = generate({ exportedNames: ["delete", "get"] });

  assert.ok(source.includes("export { _export_delete as delete };"));
  assert.equal(/\b(?:const|let|var|function) delete\b/.test(source), false);
});

test("falls back to the first named export for a default constructor", () => {
  const source = generate({ exportedNames: ["default", "Mime"] });

  assert.ok(source.includes('typeof proxyExports["Mime"] === "function" ? proxyExports["Mime"] : null'));
  assert.ok(source.includes('"default" : "Mime"'));
});

test("embeds declaration export names only as escaped literals", () => {
  const hostile = 'x"]; globalThis.pwned = 1; //';
  const source = generate({ exportedNames: [hostile, "a-b", "a_b"] });

  assert.equal(source.includes(hostile), false);
  assert.ok(source.includes(`proxyExports[${JSON.stringify(hostile)}]`));
  assert.ok(source.includes(`export { _exportString0 as ${JSON.stringify(hostile)} };`));
  // Sanitising to `a_b` used to declare `_export_a_b` twice.
  assert.ok(source.includes('export { _exportString1 as "a-b" };'));
  assert.ok(source.includes("export { _export_a_b as a_b };"));
});

test("rejects export names that are not well-formed Unicode", () => {
  assert.throws(() => generate({ exportedNames: ["x\uD800"] }), /malformed name/);
});

test("escapes policy-supplied library and workload names", () => {
  const source = new ProxyGenerator().generate(
    { exportedNames: ["add"] },
    "evil'lib",
    [{ workloadName: 'w"x', exports: ["total"] }],
  );

  assert.ok(source.includes(`'dist', "evil'lib.bundle.js"`));
  assert.ok(source.includes(`"w\\"x": {`));
  assert.ok(source.includes(`const bundleName = "evil'lib." + workloadName + ".workload.bundle.js";`));
});

test("emits only a callable default for export =", () => {
  const source = generate({ exportedNames: [], callableSingletonExport: "double" });

  assert.equal(count(source, "export default new Proxy(_callable_target"), 1);
  assert.equal(source.includes("export {"), false);
  assert.ok(source.includes("export function disposeLibrary()"));
});

test("emits workload helpers only when workloads are configured", () => {
  assert.equal(generate({ exportedNames: ["add"] }).includes("__getSandboxWorkloadExport"), false);

  const source = generate({ exportedNames: ["add"] }, [{ workloadName: "batch-sum", exports: ["total"] }]);
  assert.ok(source.includes("export async function __getSandboxWorkloadExport("));
  assert.ok(source.includes('globalName: "__SANDBOXED_WORKLOAD_batch_sum__"'));
});
