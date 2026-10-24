import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import generatorModule from "../src/proxy-generator.ts";
import { fixtureBundle } from "../../.sandbox/test/helpers/fixture-sandbox.mjs";

const { ProxyGenerator } = generatorModule;

const sandboxManagerUrl = pathToFileURL(
  fileURLToPath(new URL("../../.sandbox/core/sandbox-manager.js", import.meta.url)),
).href;

/** Shim that re-exports the real runtime into the temporary project layout. */
const reexportShim = `export * from ${JSON.stringify(sandboxManagerUrl)};\n`;

/**
 * Shim that records sandbox creation and pump release in `globalThis.__proxyEvents`,
 * so a test can check the order in which the generated proxy uses them.
 */
const recordingShim = `import { SandboxManager as RealSandboxManager } from ${JSON.stringify(sandboxManagerUrl)};
const events = (globalThis.__proxyEvents = []);
export const SandboxManager = {
  async createSandbox(...args) {
    events.push("createSandbox:start");
    const sandbox = await RealSandboxManager.createSandbox(...args);
    events.push("createSandbox:resolved");
    const unrefPump = sandbox.unrefPump;
    sandbox.unrefPump = () => {
      events.push("unrefPump");
      return unrefPump();
    };
    return sandbox;
  },
};
`;

/**
 * Generates a proxy into a temporary project and imports it.
 *
 * The layout mirrors the repository: the proxy imports
 * `../core/sandbox-manager.js` and reads `../../dist/<lib>.bundle.js`. A
 * `package.json` marks the project as ESM, as the repository root does.
 * The library is disposed when the test ends unless the test already did so.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {object} options Proxy inputs.
 * @param {object} options.libraryData Parsed export metadata.
 * @param {string} options.body Fixture body passed to `fixtureBundle()`.
 * @param {string[]} [options.permissions] Compiler-selected permissions.
 * @param {object[]} [options.workloads] Workloads with `workloadName`, `exports` and bundle `code`.
 * @param {string} [options.shim] Source for `.sandbox/core/sandbox-manager.js`.
 * @returns {Promise<object>} The imported proxy module namespace.
 */
async function importGeneratedProxy(t, { libraryData, body, permissions = [], workloads = [], shim = reexportShim }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-generated-proxy-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".sandbox", "core"), { recursive: true });
  fs.mkdirSync(path.join(root, ".sandbox", "proxys"), { recursive: true });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(root, ".sandbox", "core", "sandbox-manager.js"), shim);
  fs.writeFileSync(path.join(root, "dist", "fixture.bundle.js"), fixtureBundle(body));
  for (const workload of workloads) {
    fs.writeFileSync(path.join(root, "dist", `fixture.${workload.workloadName}.workload.bundle.js`), workload.code);
  }

  const source = new ProxyGenerator().generate(libraryData, "fixture", workloads, permissions);
  const proxyPath = path.join(root, ".sandbox", "proxys", "fixture-proxy.js");
  fs.writeFileSync(proxyPath, source);

  const proxy = await import(pathToFileURL(proxyPath).href);
  t.after(() => {
    try {
      proxy.disposeLibrary();
    } catch (error) {
      // A second disposal throws; tests that pin disposeLibrary() dispose first.
      if (error?.name !== "QuickJSUseAfterFree") throw error;
    }
  });
  return proxy;
}

const namedBody = `
  function add(a, b) { return a + b; }
  add.label = "adder";
  const counts = new WeakMap();
  class Counter {
    constructor(start) { counts.set(this, start); }
    increment() { const next = counts.get(this) + 1; counts.set(this, next); return next; }
    static describe() { return "counter"; }
  }
  return { add, Counter, VERSION: "1.2.3", delete: (key) => "deleted " + key };
`;

test("exports each declared name once, plus disposeLibrary", async (t) => {
  const proxy = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["add", "Counter", "VERSION", "delete", "add"] },
    body: namedBody,
  });

  assert.deepEqual(Object.keys(proxy).sort(), ["Counter", "VERSION", "add", "delete", "disposeLibrary"]);
  assert.equal(proxy.VERSION, "1.2.3");
  assert.equal(proxy.delete("key"), "deleted key");
});

test("routes calls on named function exports through the apply trap", async (t) => {
  // ADR 17: without an apply trap, calls reached the empty host target and returned undefined.
  const proxy = await importGeneratedProxy(t, { libraryData: { exportedNames: ["add"] }, body: namedBody });

  assert.equal(typeof proxy.add, "function");
  assert.equal(proxy.add(2, 3), 5);
  assert.equal(proxy.add.call({ unrelated: true }, 4, 5), 9);
  assert.equal(Reflect.apply(proxy.add, null, [1, 1]), 2);
  assert.equal(proxy.add.label, "adder");
});

test("constructs named class exports inside QuickJS", async (t) => {
  const proxy = await importGeneratedProxy(t, { libraryData: { exportedNames: ["Counter"] }, body: namedBody });

  const counter = new proxy.Counter(10);
  assert.deepEqual([counter.increment(), counter.increment()], [11, 12]);
  assert.equal(new proxy.Counter(0).increment(), 1);
  assert.equal(proxy.Counter.describe(), "counter");
  assert.equal(typeof proxy.Counter.prototype, "object");
});

test("exposes a singleton default and constructs its named class (ADR 12)", async (t) => {
  const proxy = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["default", "Mime"] },
    body: `
      class Mime {
        constructor(types) { this.types = types || { html: "text/html" }; }
        getType(extension) { return this.types[extension] ?? null; }
      }
      return { default: new Mime(), Mime };
    `,
  });

  assert.equal(proxy.default.getType("html"), "text/html");
  assert.equal(new proxy.default({ css: "text/css" }).getType("css"), "text/css");
  assert.equal(new proxy.Mime({ js: "text/javascript" }).getType("js"), "text/javascript");
});

test("exports a singleton default unchanged when no class is declared", async (t) => {
  const proxy = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["default"] },
    body: `return { default: { greet: (name) => "hi " + name } };`,
  });

  assert.equal(typeof proxy.default, "object");
  assert.equal(proxy.default.greet("host"), "hi host");
});

test("calls and constructs a function default", async (t) => {
  const callable = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["default"] },
    body: `function triple(x) { return x * 3; } triple.tag = "maker"; return { default: triple };`,
  });
  assert.equal(callable.default(2), 6);
  assert.equal(callable.default.tag, "maker");

  const constructable = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["default"] },
    body: `class Box { constructor(v) { this.v = v; } get() { return this.v; } } return { default: Box };`,
  });
  assert.equal(new constructable.default(7).get(), 7);
});

test("calls an export = singleton and reads its properties", async (t) => {
  const proxy = await importGeneratedProxy(t, {
    libraryData: { exportedNames: [], callableSingletonExport: "double" },
    body: `
      function double(x) { return x * 2; }
      double.version = "2.0.0";
      double.triple = (x) => x * 3;
      double.make = (n) => ({ n, twice() { return this.n * 2; } });
      return double;
    `,
  });

  assert.deepEqual(Object.keys(proxy).sort(), ["default", "disposeLibrary"]);
  assert.equal(typeof proxy.default, "function");
  assert.equal(proxy.default(21), 42);
  assert.equal(proxy.default.version, "2.0.0");
  assert.equal(proxy.default.triple(3), 9);
  assert.equal(proxy.default.make(4).twice(), 8);
});

test(
  "constructs an export = class",
  { todo: "the construct trap calls the export = value without new, so class constructors throw (spec §4)" },
  async (t) => {
    const proxy = await importGeneratedProxy(t, {
      libraryData: { exportedNames: [], callableSingletonExport: "Thing" },
      body: `class Thing { constructor(x) { this.x = x; } value() { return this.x; } } return Thing;`,
    });

    assert.equal(new proxy.default(5).value(), 5);
  },
);

test("serialises permissions into the sandbox it creates", async (t) => {
  const body = `return { probe: () => [typeof crypto, typeof fetch, typeof Intl].join() };`;
  const denied = await importGeneratedProxy(t, { libraryData: { exportedNames: ["probe"] }, body });
  const granted = await importGeneratedProxy(t, { libraryData: { exportedNames: ["probe"] }, body, permissions: ["crypto"] });

  assert.equal(denied.probe(), "undefined,undefined,undefined");
  assert.equal(granted.probe(), "object,undefined,undefined");
});

test("releases the Node job pump only after initialization (ADR 10)", async (t) => {
  const proxy = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["add"] },
    body: namedBody,
    shim: recordingShim,
  });

  assert.deepEqual(globalThis.__proxyEvents, ["createSandbox:start", "createSandbox:resolved", "unrefPump"]);
  assert.equal(proxy.add(1, 2), 3);
});

test("loads a workload lazily into the library context", async (t) => {
  const proxy = await importGeneratedProxy(t, {
    libraryData: { exportedNames: ["add"] },
    body: namedBody,
    workloads: [
      {
        workloadName: "batch",
        exports: ["total"],
        code: "var __SANDBOXED_WORKLOAD_batch__ = { total: (xs) => xs.reduce(__SANDBOXED_LIB__.add, 0) };",
      },
    ],
  });

  const total = await proxy.__getSandboxWorkloadExport("batch", "total");
  assert.equal(total([1, 2, 3]), 6);
  assert.equal(await proxy.__getSandboxWorkloadExport("batch", "total"), total);
  await assert.rejects(proxy.__getSandboxWorkloadExport("other", "total"), /Sandbox workload not configured: other/);
  await assert.rejects(proxy.__getSandboxWorkloadExport("batch", "missing"), /Sandbox workload export not found: batch.missing/);
});

test("disposeLibrary() releases the sandbox and later calls fail", async (t) => {
  const proxy = await importGeneratedProxy(t, { libraryData: { exportedNames: ["add"] }, body: namedBody });
  assert.equal(proxy.add(1, 1), 2);

  proxy.disposeLibrary();

  assert.throws(() => proxy.add(1, 1), { name: "QuickJSUseAfterFree" });
});
