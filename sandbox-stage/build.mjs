#!/usr/bin/env node
// Separate sandbox stage (prototype).
//
// Builds the sandbox bundles in an isolated working directory and writes a
// manifest that pins each bundle's digest and grant. Intended to run as its
// own CI job, separate from the application build, with:
//   - the policy read from a protected location (code-owner review),
//   - a fresh node_modules installed from the lockfile with install scripts
//     disabled (npm verifies every tarball against the lockfile's integrity),
//   - no dependency code executed: patches are applied as plain diffs, and the
//     bundler only parses library code,
//   - the bundler and plugin taken from this stage's own pinned toolchain,
//     never from the application's node_modules.
//
// Usage:
//   node --import tsx sandbox-stage/build.mjs --app-dir <dir> --policy <file> --out <dir>
//        [--base-config <webpack config>] [--patches <dir>]
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import webpack from "webpack";
import pluginModule from "../webpack-sandbox-plugin/src/plugin.ts";

const { WebpackSandboxPlugin } = pluginModule;
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument ${argv[i]}`);
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const key of ["app-dir", "policy", "out"]) {
    if (!args[key]) throw new Error(`Missing --${key}`);
  }
  return args;
}

const sri = (bytes) => `sha384-${crypto.createHash("sha384").update(bytes).digest("base64")}`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

/** Rewrites absolute paths into another node_modules tree to the stage's own. */
function remapIntoStage(value, stageModules) {
  if (typeof value === "string") {
    const marker = `${path.sep}node_modules${path.sep}`;
    const index = value.indexOf(marker);
    return index === -1 ? value : path.join(stageModules, value.slice(index + marker.length));
  }
  if (Array.isArray(value)) return value.map((v) => remapIntoStage(v, stageModules));
  if (value && typeof value === "object" && !(value instanceof RegExp)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapIntoStage(v, stageModules)]));
  }
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const appDir = path.resolve(args["app-dir"]);
  const policyPath = path.resolve(args.policy);
  const outDir = path.resolve(args.out);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-stage-")));
  const timings = {};
  let t = Date.now();

  // 1. Fresh, private install from the lockfile; no lifecycle scripts.
  for (const file of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(appDir, file), path.join(work, file));
  }
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], work);
  timings.installMs = Date.now() - t;

  // 2. Reviewed patches are applied as plain diffs, never by running code.
  const patchesDir = args.patches ? path.resolve(args.patches) : path.join(appDir, "patches");
  const applied = [];
  if (fs.existsSync(patchesDir)) {
    for (const patch of fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch")).sort()) {
      run("git", ["apply", "--unsafe-paths", "--ignore-whitespace", "-p1", path.join(patchesDir, patch)], work);
      applied.push({ patch, sha256: sha256(fs.readFileSync(path.join(patchesDir, patch))) });
    }
  }

  // 3. The policy comes from the protected location, copied byte for byte.
  const policyBytes = fs.readFileSync(policyPath);
  const stagePolicy = path.join(work, path.basename(policyPath));
  fs.writeFileSync(stagePolicy, policyBytes);
  const policyModule = await import(`${pathToFileUrl(stagePolicy)}?t=${Date.now()}`);
  const policy = policyModule.default ?? policyModule;

  // Workload entries are application code; copy them as declared.
  for (const entry of Object.values(policy)) {
    for (const workload of Object.values(entry.workloads ?? {})) {
      const from = path.resolve(appDir, workload.entry);
      const to = path.resolve(work, workload.entry);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }

  // 4. Bundle with this stage's pinned toolchain. Classification is off: this
  //    compilation has no host code, only the sandboxed child bundles.
  t = Date.now();
  const stageModules = path.join(work, "node_modules");
  let base = {};
  if (args["base-config"]) {
    const loaded = require(path.resolve(args["base-config"]));
    const env = Object.fromEntries((args["base-env"] ?? "").split(",").filter(Boolean).map((kv) => kv.split("=")));
    base = typeof loaded === "function" ? loaded(env) : loaded;
  }
  const entry = path.join(work, "__sandbox_stage_entry__.js");
  fs.writeFileSync(entry, "export {};\n");
  const buildOut = path.join(work, "out");
  await new Promise((resolve, reject) => {
    webpack({
      context: work,
      entry,
      mode: "production",
      devtool: false,
      target: base.target ?? ["web", "es2022"],
      output: { path: buildOut, filename: "__stage_trigger__.js" },
      resolve: {
        ...remapIntoStage(base.resolve ?? {}, stageModules),
        modules: [stageModules],
      },
      module: base.module,
      experiments: base.experiments,
      infrastructureLogging: { level: "error" },
      plugins: [
        new WebpackSandboxPlugin({
          configPath: stagePolicy,
          proxyDirectory: path.join(work, "proxys"),
          classification: { mode: "off" },
        }),
      ],
    }, (error, stats) => {
      if (error) reject(error);
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    });
  });
  timings.bundleMs = Date.now() - t;

  // 5. Pin digests, grants and lockfile provenance.
  const lock = JSON.parse(fs.readFileSync(path.join(work, "package-lock.json"), "utf8"));
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = { manifestVersion: 1, policySha256: sha256(policyBytes), libraries: {} };
  for (const [name, entry] of Object.entries(policy)) {
    const bundle = `${name}.bundle.js`;
    const bytes = fs.readFileSync(path.join(buildOut, bundle));
    fs.writeFileSync(path.join(outDir, bundle), bytes);
    const lockEntry = lock.packages?.[`node_modules/${name}`] ?? {};
    const library = {
      bundle,
      integrity: sri(bytes),
      grant: [...(entry.permissions ?? [])],
      packageVersion: lockEntry.version,
      lockfileIntegrity: lockEntry.integrity,
    };
    const workloads = Object.keys(entry.workloads ?? {});
    if (workloads.length) {
      library.workloads = {};
      for (const workload of workloads) {
        const file = `${name}.${workload}.workload.bundle.js`;
        const wbytes = fs.readFileSync(path.join(buildOut, file));
        fs.writeFileSync(path.join(outDir, file), wbytes);
        library.workloads[workload] = { bundle: file, integrity: sri(wbytes) };
      }
    }
    manifest.libraries[name] = library;
  }
  manifest.stage = { patchesApplied: applied, timings };
  fs.writeFileSync(path.join(outDir, "sandbox-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.rmSync(work, { recursive: true, force: true });
  console.log(JSON.stringify({ out: outDir, libraries: Object.keys(manifest.libraries), timings }, null, 1));
}

function pathToFileUrl(file) {
  return new URL(`file://${file}`).href;
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
