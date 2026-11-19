import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import webpack from "webpack";
import pluginModule from "../src/plugin.ts";

const { WebpackSandboxPlugin } = pluginModule;

const sri = (bytes) => `sha384-${crypto.createHash("sha384").update(bytes).digest("base64")}`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Sets up an application with one sandboxed library and a stage output. */
function setup(t, { grant = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-manifest-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lib = path.join(root, "node_modules", "lib-a");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, "package.json"), JSON.stringify({ name: "lib-a", version: "1.0.0", main: "index.js", types: "index.d.ts" }));
  // If the plugin ever compiled this source, the marker would reach a bundle.
  fs.writeFileSync(path.join(lib, "index.js"), "exports.f = () => 'APP_TREE_SOURCE';\n");
  fs.writeFileSync(path.join(lib, "index.d.ts"), "export declare function f(): string;\n");
  fs.writeFileSync(path.join(root, "entry.js"), "import { f } from 'lib-a';\nexport default f;\n");
  const policyBytes = Buffer.from(`module.exports = ${JSON.stringify({ "lib-a": { permissions: grant } })};\n`);
  fs.writeFileSync(path.join(root, "sandbox.config.cjs"), policyBytes);

  const stage = path.join(root, "stage");
  fs.mkdirSync(stage);
  const bundle = Buffer.from("var __SANDBOXED_LIB__ = { f: () => 'STAGE_BUILT' };\n");
  fs.writeFileSync(path.join(stage, "lib-a.bundle.js"), bundle);
  const manifest = {
    manifestVersion: 1,
    policySha256: sha256(policyBytes),
    libraries: { "lib-a": { bundle: "lib-a.bundle.js", integrity: sri(bundle), grant } },
  };
  const writeManifest = (m) => fs.writeFileSync(path.join(stage, "sandbox-manifest.json"), JSON.stringify(m));
  writeManifest(manifest);
  return { root, stage, manifest, writeManifest, bundle };
}

function compile(root) {
  return new Promise((resolve, reject) => {
    webpack({
      context: root,
      entry: path.join(root, "entry.js"),
      mode: "development",
      devtool: false,
      output: { path: path.join(root, "dist"), filename: "main.js" },
      resolve: { fallback: { fs: false, path: false, url: false } },
      externals: { "../core/sandbox-manager.js": "commonjs ../core/sandbox-manager.js" },
      plugins: [new WebpackSandboxPlugin({
        configPath: "sandbox.config.cjs",
        proxyDirectory: path.join(root, ".sandbox", "proxys"),
        sandboxManifest: { path: "stage/sandbox-manifest.json", bundleDir: "stage" },
      })],
    }, (error, stats) => {
      if (error) reject(error);
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve(stats);
    });
  });
}

test("uses the stage's bundle, never compiles library code, and pins its digest", async (t) => {
  const { root, manifest } = setup(t);
  await compile(root);
  const emitted = fs.readFileSync(path.join(root, "dist", "lib-a.bundle.js"), "utf8");
  assert.match(emitted, /STAGE_BUILT/);
  for (const file of fs.readdirSync(path.join(root, "dist"))) {
    assert.equal(fs.readFileSync(path.join(root, "dist", file), "utf8").includes("APP_TREE_SOURCE"), false, file);
  }
  assert.ok(fs.readFileSync(path.join(root, "dist", "main.js"), "utf8").includes(manifest.libraries["lib-a"].integrity));
});

test("fails when the application's policy differs from the stage's", async (t) => {
  const { root } = setup(t);
  fs.appendFileSync(path.join(root, "sandbox.config.cjs"), "// edited\n");
  await assert.rejects(compile(root), /differs from the policy the sandbox stage built/);
});

test("fails when a grant differs from the manifest", async (t) => {
  const { root, manifest, writeManifest } = setup(t);
  manifest.libraries["lib-a"].grant = ["fetch"];
  writeManifest(manifest);
  await assert.rejects(compile(root), /Grant for lib-a in the policy \(none\) differs from the manifest \(fetch\)/);
});

test("fails when the set of sandboxed libraries differs from the manifest", async (t) => {
  const { root, manifest, writeManifest } = setup(t);
  manifest.libraries["lib-b"] = { ...manifest.libraries["lib-a"], bundle: "lib-b.bundle.js" };
  writeManifest(manifest);
  await assert.rejects(compile(root), /Sandboxed libraries in the policy \(lib-a\) differ from the manifest \(lib-a, lib-b\)/);
});

test("fails when a stage bundle does not match its pinned digest", async (t) => {
  const { root, stage } = setup(t);
  fs.appendFileSync(path.join(stage, "lib-a.bundle.js"), ";globalThis.x = 1;\n");
  await assert.rejects(compile(root), /Sandbox bundle lib-a\.bundle\.js does not match the manifest/);
});
