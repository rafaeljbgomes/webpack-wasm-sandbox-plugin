import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import webpack from "webpack";
import pluginModule from "../src/plugin.ts";

const { WebpackSandboxPlugin } = pluginModule;

function createTempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webpack-sandbox-plugin-test-"));
}

function compile(config) {
  return new Promise((resolve, reject) => {
    try {
      webpack(config, (error, stats) => {
        if (error) {
          reject(error);
          return;
        }
        if (stats?.hasErrors()) {
          reject(new Error(stats.toString({ all: false, errors: true })));
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Writes a minimal resolvable package so compilation does not depend on a
 * real dependency's layout or build time.
 */
function createFixturePackage(directory, name) {
  const packageDirectory = path.join(directory, "node_modules", name);
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packageDirectory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", types: "index.d.ts" }),
  );
  fs.writeFileSync(path.join(packageDirectory, "index.js"), "exports.add = (a, b) => a + b;\n");
  fs.writeFileSync(path.join(packageDirectory, "index.d.ts"), "export declare function add(a: number, b: number): number;\n");
}

/** Builds a compiler configuration whose context and outputs stay in `directory`. */
function createConfig(directory, configPath) {
  const entryPath = path.join(directory, "entry.js");
  fs.writeFileSync(entryPath, "export const value = 1;\n");

  return {
    context: directory,
    entry: entryPath,
    mode: "development",
    output: {
      path: path.join(directory, "dist"),
      filename: "bundle.js",
    },
    plugins: [
      new WebpackSandboxPlugin({
        configPath,
        proxyDirectory: path.join(directory, "proxys"),
      }),
    ],
  };
}

test("fails when the sandbox policy file is missing", async (t) => {
  const directory = createTempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    compile(createConfig(directory, path.join(directory, "missing-policy.cjs"))),
    /Sandbox policy file was not found/,
  );
});

test("fails when the sandbox policy cannot be loaded", async (t) => {
  const directory = createTempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "sandbox.config.cjs");
  fs.writeFileSync(configPath, "module.exports = ;\n");

  await assert.rejects(
    compile(createConfig(directory, configPath)),
    /Failed to load sandbox policy/,
  );
});

test("fails when the sandbox policy does not export a library map", async (t) => {
  const directory = createTempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "sandbox.config.cjs");
  fs.writeFileSync(configPath, "module.exports = [];\n");

  await assert.rejects(
    compile(createConfig(directory, configPath)),
    /must export an object keyed by library name/,
  );
});

test("fails when a configured library cannot be resolved", async (t) => {
  const directory = createTempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "sandbox.config.cjs");
  fs.writeFileSync(
    configPath,
    'module.exports = { "not-a-real-sandbox-package": { permissions: [] } };\n',
  );

  await assert.rejects(
    compile(createConfig(directory, configPath)),
    /Configured sandbox library could not be resolved: not-a-real-sandbox-package/,
  );
});

test("continues with a resolvable configured library", async (t) => {
  const directory = createTempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "sandbox.config.cjs");
  createFixturePackage(directory, "fixture-lib");
  fs.writeFileSync(
    configPath,
    'module.exports = { "fixture-lib": { permissions: [] } };\n',
  );

  await compile(createConfig(directory, configPath));
  assert.ok(fs.existsSync(path.join(directory, "dist", "bundle.js")));
  assert.ok(fs.existsSync(path.join(directory, "dist", "fixture-lib.bundle.js")));
  assert.ok(fs.existsSync(path.join(directory, "proxys", "fixture-lib-proxy.js")));
});

test("writes generated proxies only to the configured proxy directory", async (t) => {
  const directory = createTempDirectory();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, "sandbox.config.cjs");
  const name = `fixture-lib-${path.basename(directory).replace(/[^a-zA-Z0-9]/g, "")}`;
  createFixturePackage(directory, name);
  fs.writeFileSync(configPath, `module.exports = { "${name}": { permissions: [] } };\n`);

  await compile(createConfig(directory, configPath));
  assert.ok(fs.existsSync(path.join(directory, "proxys", `${name}-proxy.js`)));
  assert.equal(
    fs.existsSync(path.resolve(process.cwd(), ".sandbox/proxys", `${name}-proxy.js`)),
    false,
  );
});
