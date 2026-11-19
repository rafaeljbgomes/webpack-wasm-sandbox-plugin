import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import webpack from "webpack";
import pluginModule from "../src/plugin.ts";
import classificationModule from "../src/classification.ts";

const { WebpackSandboxPlugin } = pluginModule;
const { packageNameFromPath } = classificationModule;

/** Creates a project directory resolved through symlinks (macOS /var). */
function createProject(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-classify-test-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Writes a package under `node_modules/<installName>`. `declaredName` lets a
 * test give the package a self-declared name different from its install path.
 */
function writePackage(root, installName, files, declaredName = installName, extra = {}) {
  const directory = path.join(root, "node_modules", ...installName.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: declaredName, version: "1.2.3", main: "index.js", types: "index.d.ts", ...extra }),
  );
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), content);
  }
}

/** A sandboxable fixture library with a declaration file and a deep module. */
function writeSandboxedLibrary(root) {
  writePackage(root, "sandboxed-lib", {
    "index.js": "const helper = require('helper-of-sandboxed');\nexports.add = (a, b) => helper.id(a) + b;\n",
    "index.d.ts": "export declare function add(a: number, b: number): number;\n",
    "deep.js": "exports.deep = () => 42;\n",
  });
  // A transitive dependency of the sandboxed library: it is bundled into the
  // library's sandbox, never into the host, and so needs no classification.
  writePackage(root, "helper-of-sandboxed", { "index.js": "exports.id = (x) => x;\n" });
}

/** Compiles `entrySource` with the sandbox plugin; resolves with stats. */
function compile(root, entrySource, classification, extraPolicy = {}) {
  fs.writeFileSync(path.join(root, "entry.js"), entrySource);
  fs.writeFileSync(
    path.join(root, "sandbox.config.cjs"),
    `module.exports = ${JSON.stringify({ "sandboxed-lib": { permissions: [] }, ...extraPolicy })};\n`,
  );
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
          classification,
        }),
      ],
    }, (error, stats) => (error ? reject(error) : resolve(stats)));
  });
}

function errorsOf(stats) {
  return stats.toJson({ all: false, errors: true }).errors.map((e) => e.message).join("\n");
}

function reportOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "dist", "sandbox-classification.json"), "utf8"));
}

test("derives package names from the install path, including scoped and nested packages", () => {
  const sep = path.sep;
  const p = (...parts) => parts.join(sep);
  assert.equal(packageNameFromPath(p("", "app", "node_modules", "lodash", "get.js")), "lodash");
  assert.equal(packageNameFromPath(p("", "app", "node_modules", "@scope", "pkg", "dist", "a.js")), "@scope/pkg");
  assert.equal(
    packageNameFromPath(p("", "app", "node_modules", "a", "node_modules", "b", "index.js")),
    "b",
    "the innermost node_modules segment identifies the package that owns the file",
  );
  assert.equal(packageNameFromPath(p("", "app", "src", "main.js")), undefined);
});

test("passes when every host package is sandboxed or trusted, and emits a report", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  writePackage(root, "trusted-lib", { "index.js": "exports.mul = (a, b) => a * b;\n" });
  const stats = await compile(
    root,
    "import { add } from 'sandboxed-lib';\nimport { mul } from 'trusted-lib';\nexport default add(1, mul(2, 3));\n",
    { trusted: ["trusted-lib"] },
  );
  assert.equal(stats.hasErrors(), false, errorsOf(stats));
  const report = reportOf(root);
  assert.equal(report.passed, true);
  assert.deepEqual(report.sandboxed, ["sandboxed-lib"]);
  assert.deepEqual(report.trusted.map((u) => u.name), ["trusted-lib"]);
  assert.deepEqual(report.unclassified, []);
  // The sandboxed library's own dependency lives in its sandbox bundle only.
  assert.equal(JSON.stringify(report).includes("helper-of-sandboxed"), false);
});

test("fails on a package that is neither sandboxed nor trusted (new or substituted dependency)", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  writePackage(root, "strip-ansii", { "index.js": "exports.strip = (s) => s;\n" });
  const stats = await compile(root, "import { strip } from 'strip-ansii';\nexport default strip('x');\n", {});
  assert.equal(stats.hasErrors(), true);
  assert.match(errorsOf(stats), /Package "strip-ansii"@1\.2\.3 is neither sandboxed nor trusted/);
  assert.match(errorsOf(stats), /strip-ansii \(from entry\.js\)/);
});

test("fails when a deep import bypasses the sandbox redirect", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  // The root specifier is redirected to the proxy, but a subpath is not.
  const stats = await compile(root, "import { deep } from 'sandboxed-lib/deep.js';\nexport default deep();\n", {
    trusted: ["sandboxed-lib"],
  });
  assert.equal(stats.hasErrors(), true);
  assert.match(errorsOf(stats), /Sandboxed package "sandboxed-lib" reached the host bundle natively/);
  assert.match(errorsOf(stats), /sandboxed-lib\/deep\.js \(from entry\.js\)/);
});

test("does not accept a package's self-declared name", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  // Installed as "evil-lib" but claims to be the trusted "trusted-lib".
  writePackage(root, "evil-lib", { "index.js": "exports.x = 1;\n" }, "trusted-lib");
  const stats = await compile(root, "import { x } from 'evil-lib';\nexport default x;\n", { trusted: ["trusted-lib"] });
  assert.equal(stats.hasErrors(), true);
  assert.match(errorsOf(stats), /Package "evil-lib"/);
});

test("requires transitive dependencies of trusted packages to be classified too", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  writePackage(root, "trusted-lib", { "index.js": "module.exports = require('new-transitive');\n" });
  writePackage(root, "new-transitive", { "index.js": "exports.y = 2;\n" });
  const stats = await compile(root, "import t from 'trusted-lib';\nexport default t;\n", { trusted: ["trusted-lib"] });
  assert.equal(stats.hasErrors(), true);
  assert.match(errorsOf(stats), /Package "new-transitive"@1\.2\.3 is neither sandboxed nor trusted but is bundled into the host via: new-transitive \(from node_modules\/trusted-lib\/index\.js\)/);
});

test("warn mode reports violations without failing the build", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  writePackage(root, "loose-lib", { "index.js": "exports.z = 3;\n" });
  const stats = await compile(root, "import { z } from 'loose-lib';\nexport default z;\n", { mode: "warn" });
  assert.equal(stats.hasErrors(), false, errorsOf(stats));
  assert.equal(stats.hasWarnings(), true);
  const report = reportOf(root);
  assert.equal(report.passed, false);
  assert.deepEqual(report.unclassified.map((u) => u.name), ["loose-lib"]);
});

test("off mode restores the previous opt-in behaviour", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  writePackage(root, "loose-lib", { "index.js": "exports.z = 3;\n" });
  const stats = await compile(root, "import { z } from 'loose-lib';\nexport default z;\n", { mode: "off" });
  assert.equal(stats.hasErrors(), false, errorsOf(stats));
  assert.equal(fs.existsSync(path.join(root, "dist", "sandbox-classification.json")), false);
});

test("loads the trusted list from a file and rejects malformed lists", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  writePackage(root, "trusted-lib", { "index.js": "exports.mul = (a, b) => a * b;\n" });
  fs.writeFileSync(path.join(root, "trusted.cjs"), "module.exports = { trusted: ['trusted-lib'] };\n");
  const ok = await compile(root, "import { mul } from 'trusted-lib';\nexport default mul(2, 3);\n", {
    trustedPath: "trusted.cjs",
  });
  assert.equal(ok.hasErrors(), false, errorsOf(ok));

  fs.writeFileSync(path.join(root, "bad.cjs"), "module.exports = { trusted: 'trusted-lib' };\n");
  await assert.rejects(
    compile(root, "export default 1;\n", { trustedPath: "bad.cjs" }),
    /must export \{ trusted: string\[\] \}/,
  );
});

test("does not flag packages that are pruned from the shipped bundle", async (t) => {
  const root = createProject(t);
  writeSandboxedLibrary(root);
  // A side-effect-free trusted barrel re-exports an unclassified package that
  // the application never uses; webpack prunes it, so it never ships or runs.
  writePackage(root, "trusted-barrel", {
    "index.js": "export { used } from './used.js';\nexport { unused } from 'never-shipped';\n",
    "used.js": "export const used = 1;\n",
  }, "trusted-barrel", { sideEffects: false, type: "module" });
  writePackage(root, "never-shipped", { "index.js": "export const unused = 2;\n" }, "never-shipped", {
    sideEffects: false,
    type: "module",
  });
  const stats = await compile(root, "import { used } from 'trusted-barrel';\nexport default used;\n", {
    trusted: ["trusted-barrel"],
  });
  assert.equal(stats.hasErrors(), false, errorsOf(stats));
  assert.deepEqual(reportOf(root).unclassified, []);
});
