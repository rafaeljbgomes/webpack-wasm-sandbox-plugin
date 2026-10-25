import assert from "node:assert/strict";
import test from "node:test";
import { getQuickJS } from "quickjs-emscripten";
import sandboxConfig from "../sandbox.config.js";
import { SandboxManager } from "../core/sandbox-manager.js";
import { createFixtureSandbox, fixtureBundle } from "./helpers/fixture-sandbox.mjs";

// Globals the runtime itself installs for its reverse membrane.
const RUNTIME_GLOBALS = ["__SANDBOXED_LIB__", "__SANDBOX_TEMP__"];

const INSPECT_BODY = `
  return {
    globalNames: () => Object.getOwnPropertyNames(globalThis),
    kind: (name) => typeof globalThis[name],
  };
`;

/**
 * Lists the global names of a bare QuickJS context, so the deny-by-default
 * check tracks the engine's own built-ins instead of a hard-coded list.
 *
 * @returns {Promise<Set<string>>} Built-in global names.
 */
async function bareContextGlobals() {
  const qjs = await getQuickJS();
  const vm = qjs.newContext();
  try {
    const handle = vm.unwrapResult(vm.evalCode("Object.getOwnPropertyNames(globalThis)"));
    const names = vm.dump(handle);
    handle.dispose();
    return new Set(names);
  } finally {
    vm.dispose();
  }
}

/**
 * Returns the globals a sandbox adds on top of a bare QuickJS context.
 *
 * @param {object} sandbox Sandbox built from {@link INSPECT_BODY}.
 * @returns {Promise<string[]>} Sorted added global names.
 */
async function addedGlobals(sandbox) {
  const builtIns = await bareContextGlobals();
  return sandbox.exports.globalNames().filter((name) => !builtIns.has(name)).sort();
}

/**
 * Creates a sandbox without the fixture helper's explicit-permission default
 * and disposes it after the test.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} libraryName Policy key used for the fallback lookup.
 * @returns {Promise<object>} Sandbox runtime.
 */
async function createWithOmittedPermissions(t, libraryName) {
  const sandbox = await SandboxManager.createSandbox(libraryName, fixtureBundle(INSPECT_BODY));
  t.after(() => sandbox.dispose());
  return sandbox;
}

test("an empty permission list adds no host globals beyond the runtime's own", async (t) => {
  const sandbox = await createFixtureSandbox(t, INSPECT_BODY, { permissions: [] });
  assert.deepEqual(await addedGlobals(sandbox), [...RUNTIME_GLOBALS].sort());
});

test("an empty permission list leaves ambient host authority undefined", async (t) => {
  const sandbox = await createFixtureSandbox(t, INSPECT_BODY, { permissions: [] });
  const ambient = [
    "fetch", "XMLHttpRequest", "WebSocket", "process", "require", "module", "Buffer",
    "document", "window", "self", "navigator", "localStorage", "crypto", "Intl",
    "TextEncoder", "TextDecoder", "setTimeout", "setInterval", "console",
  ];
  for (const name of ambient) {
    assert.equal(sandbox.exports.kind(name), "undefined", `${name} must not be exposed`);
  }
});

test("a listed permission exposes only that global", async (t) => {
  const sandbox = await createFixtureSandbox(t, INSPECT_BODY, { permissions: ["Intl"] });
  assert.deepEqual(await addedGlobals(sandbox), [...RUNTIME_GLOBALS, "Intl"].sort());
});

test("an exposed Intl capability works and is absent when not listed", async (t) => {
  const body = "return { format: (n) => new Intl.NumberFormat('en-US').format(n) };";
  const allowed = await createFixtureSandbox(t, body, { permissions: ["Intl"] });
  const denied = await createFixtureSandbox(t, body, { permissions: [] });
  assert.equal(allowed.exports.format(1234567.5), "1,234,567.5");
  assert.throws(() => denied.exports.format(1), /'Intl' is not defined/);
});

test("an exposed TextEncoder constructor keeps its host behaviour", async (t) => {
  const sandbox = await createFixtureSandbox(
    t,
    "return { encode: (s) => Array.from(new TextEncoder().encode(s)) };",
    { permissions: ["TextEncoder"] },
  );
  assert.deepEqual(sandbox.exports.encode("hi"), [104, 105]);
});

test("the crypto permission installs only the facade and hides its helpers", async (t) => {
  const sandbox = await createFixtureSandbox(t, INSPECT_BODY, { permissions: ["crypto"] });
  // The facade installer also aliases `self` for libraries that read self.crypto.
  assert.deepEqual(await addedGlobals(sandbox), [...RUNTIME_GLOBALS, "crypto", "self"].sort());
  assert.equal(sandbox.exports.kind("__sandboxCryptoGetRandomBytes"), "undefined");
  assert.equal(sandbox.exports.kind("__sandboxCryptoRandomUUID"), "undefined");
});

test("an unavailable host global is skipped without failing creation", async (t) => {
  const sandbox = await createFixtureSandbox(t, INSPECT_BODY, {
    permissions: ["DefinitelyMissingHostGlobal"],
  });
  assert.equal(sandbox.exports.kind("DefinitelyMissingHostGlobal"), "undefined");
  assert.deepEqual(await addedGlobals(sandbox), [...RUNTIME_GLOBALS].sort());
});

test("an explicit empty list never falls back to the policy module", async (t) => {
  assert.ok(sandboxConfig.luxon?.permissions.includes("Intl"), "precondition: example policy grants luxon Intl");
  const sandbox = await createFixtureSandbox(t, INSPECT_BODY, { libraryName: "luxon", permissions: [] });
  assert.equal(sandbox.exports.kind("Intl"), "undefined");
});

test("omitted permissions fall back to the policy module entry", async (t) => {
  const sandbox = await createWithOmittedPermissions(t, "luxon");
  assert.equal(sandbox.exports.kind("Intl"), "object");
});

test("omitted permissions for an unconfigured library expose nothing", async (t) => {
  const sandbox = await createWithOmittedPermissions(t, "library-not-in-policy");
  assert.deepEqual(await addedGlobals(sandbox), [...RUNTIME_GLOBALS].sort());
});

for (const [label, permissions] of [
  ["a string", "crypto"],
  ["null", null],
  ["an object", { crypto: true }],
  ["an empty name", [""]],
  ["a non-string entry", [1]],
]) {
  test(`asynchronous creation rejects ${label} as permissions`, async () => {
    await assert.rejects(
      SandboxManager.createSandbox("fixture", fixtureBundle("return {};"), { permissions }),
      { name: "TypeError", message: /permissions must be an array of nonempty strings/ },
    );
  });

  test(`synchronous creation rejects ${label} as permissions`, async () => {
    await getQuickJS();
    assert.throws(
      () => SandboxManager.createSandboxSync("fixture", fixtureBundle("return {};"), { permissions }),
      { name: "TypeError", message: /permissions must be an array of nonempty strings/ },
    );
  });
}
