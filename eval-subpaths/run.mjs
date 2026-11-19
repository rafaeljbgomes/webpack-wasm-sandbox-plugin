// Subpath evaluation on the real packages: the documented deep imports that
// previously ran natively (see eval-classify) are declared as subpaths and
// served by each package's sandbox.
//
// For each case it reports: build result under classify-or-fail (error mode),
// native modules of the package in the host bundle, whether the subpath's
// modules ship in the package's single sandbox bundle, the result of a call
// compared with the same call made natively, and the host functions the
// sandbox registered for that call (a value passed from a subpath into the
// root would register host functions if it left QuickJS).
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs --import tsx eval-subpaths/run.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import webpack from "webpack";
import { QuickJSContext } from "quickjs-emscripten-core";
import pluginModule from "../webpack-sandbox-plugin/src/plugin.ts";

const { WebpackSandboxPlugin } = pluginModule;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Count host functions registered per QuickJS context.
const registrations = new WeakMap();
const originalNewFunction = QuickJSContext.prototype.newFunction;
QuickJSContext.prototype.newFunction = function (name, fn) {
  registrations.set(this, (registrations.get(this) ?? 0) + 1);
  return originalNewFunction.call(this, name, fn);
};
const hostFunctions = () => {
  let total = 0;
  for (const ctx of contexts) total += registrations.get(ctx) ?? 0;
  return total;
};
const contexts = new Set();
const originalEval = QuickJSContext.prototype.evalCode;
QuickJSContext.prototype.evalCode = function (...args) {
  contexts.add(this);
  return originalEval.apply(this, args);
};

const POLICY = {
  "date-fns": { permissions: ["Intl"], subpaths: ["locale"] },
  lodash: { permissions: [], subpaths: ["get.js"] },
  zod: { permissions: [], subpaths: ["mini"] },
  mime: { permissions: [], subpaths: ["lite"] },
};

const ENTRY = [
  "import { format } from 'date-fns';",
  "import { ptBR } from 'date-fns/locale';",
  "import get from 'lodash/get.js';",
  "import * as zm from 'zod/mini';",
  "import mime from 'mime/lite';",
  "export default [format, ptBR, get, zm, mime];",
  "",
].join("\n");

function build(work, policy) {
  fs.writeFileSync(path.join(work, "sandbox.config.cjs"), `module.exports = ${JSON.stringify(policy)};\n`);
  fs.writeFileSync(path.join(work, "entry.js"), ENTRY);
  const started = process.hrtime.bigint();
  return new Promise((resolve) => webpack({
    context: repo,
    entry: path.join(work, "entry.js"),
    mode: "development",
    devtool: false,
    target: ["web", "es2022"],
    experiments: { topLevelAwait: true },
    output: { path: path.join(work, "dist"), filename: "bundle.js" },
    resolve: {
      fallback: { fs: false, path: false, url: false },
      alias: { "quickjs-emscripten-sync": path.join(repo, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js") },
    },
    plugins: [new WebpackSandboxPlugin({
      configPath: path.join(work, "sandbox.config.cjs"),
      proxyDirectory: path.join(work, ".sandbox", "proxys"),
      classification: { mode: "error" },
    })],
    infrastructureLogging: { level: "none" },
  }, (error, stats) => {
    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e6);
    if (error) return resolve({ ok: false, ms, error: String(error) });
    const json = stats.toJson({ all: false, modules: true, children: true, errors: true, modulesSpace: Infinity });
    const host = json.modules.map((m) => m.name || "");
    const native = Object.fromEntries(Object.keys(POLICY).map((p) => [p, host.filter((n) => n.startsWith(`./node_modules/${p}/`)).length]));
    const child = Object.fromEntries(json.children.map((c) => [c.name, c.modules?.length ?? 0]));
    const bundleBytes = Object.fromEntries(Object.keys(POLICY).map((p) => {
      const file = path.join(work, "dist", `${p}.bundle.js`);
      return [p, fs.existsSync(file) ? fs.statSync(file).size : null];
    }));
    resolve({
      ok: !stats.hasErrors(), ms, nativeModulesInHost: native, sandboxBundleModules: child, bundleBytes,
      firstError: stats.hasErrors() ? json.errors[0].message.slice(0, 200) : "",
    });
  }));
}

function project() {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eval-subpaths-")));
  fs.mkdirSync(path.join(work, ".sandbox", "core"), { recursive: true });
  const manager = pathToFileURL(path.join(repo, ".sandbox/core/sandbox-manager.js")).href;
  fs.writeFileSync(path.join(work, ".sandbox", "core", "sandbox-manager.js"), `export * from ${JSON.stringify(manager)};\n`);
  fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ type: "module" }));
  return work;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function timeCalls(fn, n = 2000) {
  for (let i = 0; i < 50; i++) fn();
  const samples = [];
  for (let r = 0; r < 5; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < n; i++) fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e3 / n);
  }
  return Number(median(samples).toFixed(2)); // microseconds per call
}

async function main() {
  const work = project();
  const withSubpaths = await build(work, POLICY);
  const withoutWork = project();
  const rootOnlyPolicy = Object.fromEntries(Object.entries(POLICY).map(([k, v]) => [k, { permissions: v.permissions }]));
  const withoutSubpaths = await build(withoutWork, rootOnlyPolicy);

  const proxy = (file) => import(pathToFileURL(path.join(work, ".sandbox", "proxys", file)).href);
  const dateFns = await proxy("date-fns-proxy.js");
  const locale = await proxy("date-fns--locale-proxy.js");
  const get = (await proxy("lodash--get.js-proxy.js")).default;
  const zm = await proxy("zod--mini-proxy.js");
  const mime = (await proxy("mime--lite-proxy.js")).default;

  const nativeDateFns = await import("date-fns");
  const nativeLocale = await import("date-fns/locale");
  const nativeGet = (await import("lodash/get.js")).default;
  const nativeZm = await import("zod/mini");
  const nativeMime = (await import("mime/lite")).default;

  const date = new Date(Date.UTC(2026, 10, 19, 12));
  const calls = {
    "date-fns + date-fns/locale": {
      sandbox: () => dateFns.format(date, "PPPP", { locale: locale.ptBR }),
      native: () => nativeDateFns.format(date, "PPPP", { locale: nativeLocale.ptBR }),
    },
    "lodash/get.js": {
      sandbox: () => get({ a: { b: [1, { c: 3 }] } }, "a.b[1].c"),
      native: () => nativeGet({ a: { b: [1, { c: 3 }] } }, "a.b[1].c"),
    },
    "zod/mini": {
      sandbox: () => [zm.safeParse(zm.string(), "x").success, zm.safeParse(zm.string(), 1).success],
      native: () => [nativeZm.safeParse(nativeZm.string(), "x").success, nativeZm.safeParse(nativeZm.string(), 1).success],
    },
    "mime/lite": {
      sandbox: () => [mime.getType("a.txt"), mime.getExtension("application/json")],
      native: () => [nativeMime.getType("a.txt"), nativeMime.getExtension("application/json")],
    },
  };

  const runtime = {};
  for (const [name, call] of Object.entries(calls)) {
    const before = hostFunctions();
    let sandboxResult;
    let error = null;
    try {
      sandboxResult = call.sandbox();
    } catch (e) {
      error = `${e?.name}: ${String(e?.message ?? e).slice(0, 160)}`;
    }
    const firstCallHostFunctions = hostFunctions() - before;
    const nativeResult = call.native();
    const afterFirst = hostFunctions();
    let sandboxMicros = null;
    if (!error) sandboxMicros = timeCalls(call.sandbox, name.startsWith("date-fns") ? 200 : 2000);
    const steadyHostFunctions = hostFunctions() - afterFirst;
    runtime[name] = {
      sandboxResult, nativeResult, equal: JSON.stringify(sandboxResult) === JSON.stringify(nativeResult), error,
      hostFunctionsFirstCall: firstCallHostFunctions, hostFunctionsOverTimedCalls: steadyHostFunctions,
      sandboxMicrosPerCall: sandboxMicros, nativeMicrosPerCall: timeCalls(call.native, name.startsWith("date-fns") ? 200 : 2000),
    };
  }

  // Leak check for the locale: passing a host-side (native) locale object into
  // the sandboxed format makes QuickJS call back into the host for its methods.
  const beforeForeign = hostFunctions();
  const foreign = dateFns.format(date, "PPPP", { locale: nativeLocale.ptBR });
  const foreignLocale = { result: foreign, hostFunctionsRegistered: hostFunctions() - beforeForeign };

  const result = {
    environment: { node: process.version, date: new Date().toISOString() },
    policy: POLICY,
    build: { withSubpaths, withoutSubpaths },
    runtime,
    comparison_hostLocalePassedIn: foreignLocale,
  };
  console.log(JSON.stringify(result, null, 1));
  dateFns.disposeLibrary?.();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(withoutWork, { recursive: true, force: true });
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
