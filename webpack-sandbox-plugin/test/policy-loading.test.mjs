import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import buildHelpersModule from "../src/build-helpers.ts";

const { loadSandboxPolicy } = buildHelpersModule;

const MALFORMED_PERMISSIONS = /Permissions for fixture-lib must be an array of nonempty strings/;

/**
 * Creates a project directory with a resolvable `fixture-lib` package.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @returns {string} Project directory, removed when the test ends.
 */
function createProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-policy-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packageDirectory = path.join(directory, "node_modules", "fixture-lib");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "fixture-lib", main: "index.js" }));
  fs.writeFileSync(path.join(packageDirectory, "index.js"), "exports.value = 1;\n");
  return directory;
}

/**
 * Writes a CommonJS policy module and loads it relative to the project.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} source Policy module source.
 * @returns {Record<string, object>} Normalized policy.
 */
function loadPolicy(t, source) {
  const directory = createProject(t);
  fs.writeFileSync(path.join(directory, "sandbox.config.cjs"), source);
  return loadSandboxPolicy("sandbox.config.cjs", directory);
}

test("normalizes omitted permissions to an empty list", (t) => {
  const policy = loadPolicy(t, 'module.exports = { "fixture-lib": {} };\n');

  assert.deepEqual(policy["fixture-lib"], { permissions: [] });
});

test("keeps explicit permissions, workloads and other fields", (t) => {
  const policy = loadPolicy(
    t,
    `module.exports = { "fixture-lib": {
      permissions: ["crypto", "Intl"],
      workloads: { batch: { entry: "./batch.js", exports: ["total"] } },
      note: "kept",
    } };\n`,
  );

  assert.deepEqual(policy["fixture-lib"], {
    permissions: ["crypto", "Intl"],
    workloads: { batch: { entry: "./batch.js", exports: ["total"] } },
    note: "kept",
  });
});

test("copies permissions instead of sharing the developer's array", (t) => {
  const directory = createProject(t);
  const configPath = path.join(directory, "sandbox.config.cjs");
  fs.writeFileSync(configPath, 'module.exports = { "fixture-lib": { permissions: ["crypto"] } };\n');

  const policy = loadSandboxPolicy(configPath, directory);
  policy["fixture-lib"].permissions.push("fetch");

  assert.deepEqual(loadSandboxPolicy(configPath, directory)["fixture-lib"].permissions, ["crypto"]);
});

test("returns a null-prototype map keyed by library name", (t) => {
  const policy = loadPolicy(t, 'module.exports = { "fixture-lib": { permissions: [] } };\n');

  assert.equal(Object.getPrototypeOf(policy), null);
  assert.deepEqual(Object.keys(policy), ["fixture-lib"]);
});

test("reads a policy exported as default", (t) => {
  const policy = loadPolicy(t, 'module.exports = { default: { "fixture-lib": { permissions: ["crypto"] } } };\n');

  assert.deepEqual(policy["fixture-lib"].permissions, ["crypto"]);
});

test("rejects null permissions", (t) => {
  assert.throws(() => loadPolicy(t, 'module.exports = { "fixture-lib": { permissions: null } };\n'), MALFORMED_PERMISSIONS);
});

test("rejects non-array permissions", (t) => {
  for (const value of ['"crypto"', "{ crypto: true }", "1"]) {
    assert.throws(
      () => loadPolicy(t, `module.exports = { "fixture-lib": { permissions: ${value} } };\n`),
      MALFORMED_PERMISSIONS,
      value,
    );
  }
});

test("rejects empty-string and non-string permission entries", (t) => {
  for (const value of ['[""]', '["crypto", ""]', "[1]", "[null]"]) {
    assert.throws(
      () => loadPolicy(t, `module.exports = { "fixture-lib": { permissions: ${value} } };\n`),
      MALFORMED_PERMISSIONS,
      value,
    );
  }
});

test("rejects a library entry that is not an object", (t) => {
  for (const value of ["null", "[]", '"crypto"']) {
    assert.throws(
      () => loadPolicy(t, `module.exports = { "fixture-lib": ${value} };\n`),
      /Policy for fixture-lib must be an object/,
      value,
    );
  }
});
