import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import webpack from "webpack";
import pluginModule from "../src/plugin.ts";
import { SandboxManager } from "../../.sandbox/core/sandbox-manager.js";

const { WebpackSandboxPlugin } = pluginModule;

const sandboxManagerUrl = pathToFileURL(
  fileURLToPath(new URL("../../.sandbox/core/sandbox-manager.js", import.meta.url)),
).href;

/**
 * Writes a package into the project's `node_modules`.
 *
 * @param {string} root Project directory.
 * @param {string} name Package name.
 * @param {Record<string, string>} files Package files keyed by relative path.
 * @param {object} [manifest] Extra `package.json` fields.
 */
function writePackage(root, name, files, manifest = {}) {
  const directory = path.join(root, "node_modules", name);
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), source);
  }
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", ...manifest }),
  );
}

/**
 * Builds the fixture project: configured and unconfigured packages, a
 * workload, and a host entry that imports them.
 *
 * Generated proxies and bundles land in `<root>/.sandbox/proxys` and
 * `<root>/dist`, the layout a generated proxy expects at run time. The
 * `.sandbox/core` shim re-exports the real runtime, and `package.json` marks
 * the project as ESM, as the repository root does.
 *
 * @param {string} root Project directory.
 */
function writeProject(root) {
  writePackage(root, "fixture-lib", {
    "index.js": "exports.add = (a, b) => a + b;\nexports.sub = require('./sub.js');\n",
    "sub.js": "module.exports = (a, b) => a - b;\n",
    "index.d.ts": "export declare function add(a: number, b: number): number;\nexport declare function sub(a: number, b: number): number;\n",
  }, { types: "index.d.ts" });
  writePackage(root, "other-lib", { "index.js": "exports.mul = (a, b) => a * b;\n" });
  // ADR 11: a package-level browser entry must not replace the Node entry.
  writePackage(root, "browser-entry-lib", {
    "node.js": "exports.flavour = () => 'node';\n",
    "browser.js": "exports.flavour = () => 'browser';\n",
    "index.d.ts": "export declare function flavour(): string;\n",
  }, { main: "node.js", browser: "browser.js", types: "index.d.ts" });
  writePackage(root, "browser-map-lib", {
    "index.js": "exports.flavour = require('./impl.js').flavour;\n",
    "impl.js": "exports.flavour = () => 'node';\n",
    "impl.browser.js": "exports.flavour = () => 'browser';\n",
    "index.d.ts": "export declare function flavour(): string;\n",
  }, { browser: { "./impl.js": "./impl.browser.js" }, types: "index.d.ts" });
  writePackage(root, "typed-lib", { "index.js": "exports.id = (x) => x;\n" });
  writePackage(root, "@types/typed-lib", { "index.d.ts": "export declare function id<T>(x: T): T;\n" });
  writePackage(root, "untyped-lib", { "index.js": "exports.id = (x) => x;\n" });

  fs.mkdirSync(path.join(root, "workloads"));
  fs.writeFileSync(
    path.join(root, "workloads", "batch.js"),
    "import { add } from 'sandbox-real/fixture-lib';\nexport const total = (xs) => xs.reduce(add, 0);\n",
  );
  fs.writeFileSync(path.join(root, "sandbox.config.cjs"), `module.exports = {
  "fixture-lib": { permissions: [], workloads: { batch: { entry: "./workloads/batch.js", exports: ["total"] } } },
  "browser-entry-lib": { permissions: [] },
  "browser-map-lib": { permissions: [] },
  "typed-lib": { permissions: [] },
  "untyped-lib": { permissions: [] },
};
`);
  fs.writeFileSync(path.join(root, "entry.js"), [
    'import { add } from "fixture-lib";',
    'import { mul } from "other-lib";',
    'import { flavour } from "browser-entry-lib";',
    'import { total } from "sandbox-workload/fixture-lib/batch";',
    "export const value = [add(1, 2), mul(2, 3), flavour(), total([1, 2])];",
    "",
  ].join("\n"));

  fs.mkdirSync(path.join(root, ".sandbox", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sandbox", "core", "sandbox-manager.js"), `export * from ${JSON.stringify(sandboxManagerUrl)};\n`);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
}

/**
 * Compiles the fixture project for the default web target.
 *
 * The runtime import is external so the host bundle stays small, and the
 * proxies' Node-only dynamic imports are stubbed as a browser build would.
 *
 * @param {string} root Project directory.
 * @returns {Promise<import("webpack").Stats>} Compilation stats.
 */
function compileProject(root) {
  return new Promise((resolve, reject) => {
    webpack({
      context: root,
      entry: path.join(root, "entry.js"),
      mode: "development",
      devtool: false,
      output: { path: path.join(root, "dist"), filename: "bundle.js" },
      resolve: { fallback: { fs: false, path: false, url: false } },
      externals: { "../core/sandbox-manager.js": "commonjs ../core/sandbox-manager.js" },
      plugins: [
        new WebpackSandboxPlugin({
          configPath: "sandbox.config.cjs",
          proxyDirectory: path.join(root, ".sandbox", "proxys"),
        }),
      ],
    }, (error, stats) => {
      if (error) reject(error);
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve(stats);
    });
  });
}

/**
 * Loads an emitted child bundle into a fresh sandbox through the
 * `__SANDBOXED_LIB__` contract.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} libraryName Configured library whose bundle is loaded.
 * @returns {Promise<object>} Sandbox runtime, disposed when the test ends.
 */
async function loadChildBundle(t, libraryName) {
  const code = fs.readFileSync(path.join(root, "dist", `${libraryName}.bundle.js`), "utf8");
  const sandbox = await SandboxManager.createSandbox(libraryName, code, { permissions: [] });
  t.after(() => sandbox.dispose());
  return sandbox;
}

/**
 * Imports a generated proxy from the compiled project.
 *
 * @param {string} file Proxy file name under `.sandbox/proxys`.
 * @returns {Promise<object>} Proxy module namespace.
 */
function importProxy(file) {
  return import(pathToFileURL(path.join(root, ".sandbox", "proxys", file)).href);
}

let root;
let hostModules;
let childModules;
let libraryProxy;

/**
 * Imports the `fixture-lib` proxy once. Modules are cached, so the cases share
 * its sandbox and the file disposes it at the end.
 *
 * @returns {Promise<object>} Proxy module namespace.
 */
async function importLibraryProxy() {
  libraryProxy ??= await importProxy("fixture-lib-proxy.js");
  return libraryProxy;
}

// Webpack start-up dominates this file, so every case shares one compilation.
before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-redirection-test-"));
  writeProject(root);
  // The plugin parses declarations with TypeScript, which loads every @types
  // package visible from the working directory. Compiling from the fixture
  // project keeps that to the fixture; this file runs in its own process.
  const previous = process.cwd();
  process.chdir(root);
  let compiled;
  try {
    compiled = await compileProject(root);
  } finally {
    process.chdir(previous);
  }
  const stats = compiled.toJson({ all: false, modules: true, children: true });
  hostModules = stats.modules.map((module) => module.name).filter(Boolean);
  childModules = Object.fromEntries(
    stats.children.map((child) => [child.name, child.modules.map((module) => module.name)]),
  );
});

after(() => {
  libraryProxy?.disposeLibrary();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("redirects a configured root request to its generated proxy", () => {
  assert.ok(hostModules.includes("./.sandbox/proxys/fixture-lib-proxy.js"));
  assert.equal(hostModules.some((name) => name.startsWith("./node_modules/fixture-lib/")), false);
  assert.deepEqual(childModules["SandboxCompiler-fixture-lib"].sort(), [
    "./node_modules/fixture-lib/index.js",
    "./node_modules/fixture-lib/sub.js",
  ]);
});

test("leaves unconfigured requests untouched", () => {
  assert.ok(hostModules.includes("./node_modules/other-lib/index.js"));
  assert.equal(fs.existsSync(path.join(root, ".sandbox", "proxys", "other-lib-proxy.js")), false);
  assert.equal(fs.existsSync(path.join(root, "dist", "other-lib.bundle.js")), false);
});

test("emits a child bundle that defines __SANDBOXED_LIB__ (ADR 6)", async (t) => {
  const code = fs.readFileSync(path.join(root, "dist", "fixture-lib.bundle.js"), "utf8");
  assert.match(code, /^var __SANDBOXED_LIB__;/);

  const sandbox = await loadChildBundle(t, "fixture-lib");
  assert.equal(sandbox.exports.add(2, 3), 5);
  assert.equal(sandbox.exports.sub(5, 1), 4);
});

test("runs the generated proxy against the emitted bundle", async () => {
  const proxy = await importLibraryProxy();
  assert.equal(proxy.add(20, 22), 42);
  assert.equal(proxy.sub(9, 4), 5);
});

test("redirects a workload request and runs it in the library sandbox", async () => {
  assert.ok(hostModules.includes("./.sandbox/proxys/fixture-lib-batch-workload-proxy.js"));
  assert.ok(fs.existsSync(path.join(root, "dist", "fixture-lib.batch.workload.bundle.js")));

  // The workload proxy imports the library proxy, so both share one sandbox.
  await importLibraryProxy();
  const workload = await importProxy("fixture-lib-batch-workload-proxy.js");
  assert.equal(workload.total([1, 2, 3]), 6);
});

test("bundles the Node entry of a package with a browser entry (ADR 11)", async (t) => {
  assert.deepEqual(childModules["SandboxCompiler-browser-entry-lib"], ["./node_modules/browser-entry-lib/node.js"]);

  const sandbox = await loadChildBundle(t, "browser-entry-lib");
  assert.equal(sandbox.exports.flavour(), "node");
});

test(
  "bundles Node modules for browser-mapped internal requests (ADR 11)",
  { todo: "compileLibrary() resolves only the entry for Node.js; the .browser. rewrite in ADR 11 is not applied (spec §3.2)" },
  async (t) => {
    const sandbox = await loadChildBundle(t, "browser-map-lib");
    assert.equal(sandbox.exports.flavour(), "node");
  },
);

test("generates a proxy from @types when the package has no declarations", async () => {
  const source = fs.readFileSync(path.join(root, ".sandbox", "proxys", "typed-lib-proxy.js"), "utf8");
  assert.ok(source.includes("export { _export_id as id };"));
});

test("writes a failing stub proxy when no declarations exist", async () => {
  const proxy = await importProxy("untyped-lib-proxy.js");
  assert.throws(() => proxy.default(), /Sandbox Proxy Generation Failed/);
});
