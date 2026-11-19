// Callback-count metric: host entry points reachable from inside each library's
// QuickJS context. Every host function a sandboxed library can invoke is
// registered through QuickJSContext#newFunction and dispatched through the
// single `callFunction` Wasm import, so counting newFunction registrations per
// context enumerates the library's host-callable surface.
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-callbacks/measure.mjs
import fs from "node:fs";
import path from "node:path";
import { QuickJSContext } from "quickjs-emscripten";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";
import policy from "../.sandbox/sandbox.config.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// --- instrumentation -------------------------------------------------------
const registry = new WeakMap(); // QuickJSContext -> string[] (function names)
const original = QuickJSContext.prototype.newFunction;
QuickJSContext.prototype.newFunction = function (name, fn) {
  if (!registry.has(this)) registry.set(this, []);
  registry.get(this).push(String(name || "<anonymous>"));
  return original.call(this, name, fn);
};
let lastContext;
const originalEval = QuickJSContext.prototype.evalCode;
QuickJSContext.prototype.evalCode = function (...args) {
  lastContext = this;
  return originalEval.apply(this, args);
};
const count = (ctx) => (registry.get(ctx) ?? []).length;
const names = (ctx) => registry.get(ctx) ?? [];

// --- representative calls (illustrative, one per library) -----------------
const exercises = {
  "strip-ansi": (e) => (e.default ?? e)("\u001b[31mred\u001b[0m"),
  tweetnacl: (e) => (e.default ?? e).sign.keyPair(),
  mime: (e) => (e.default ?? e).getType("a.json"),
  luxon: (e) => e.DateTime.fromISO("2026-11-19T10:00:00Z").setLocale("pt-PT").toLocaleString(e.DateTime.DATETIME_FULL),
  "date-fns": (e) => e.format(new Date(Date.UTC(2026, 10, 19)), "PPPP"),
  lodash: (e) => (e.default ?? e).groupBy([1.1, 2.3, 2.4], Math.floor),
  zod: (e) => (e.z ?? e).string().parse("x"),
  marked: (e) => (e.marked ?? e).parse("# hi"),
  yup: (e) => e.string().required().validateSync("x"),
  "image-js": (e) => new e.Image(2, 2).width,
};

async function measure(libraryName, permissions, exercise) {
  const code = libraryName === "__baseline__"
    ? "var __SANDBOXED_LIB__ = {};"
    : fs.readFileSync(path.join(root, "dist", `${libraryName}.bundle.js`), "utf8");
  let sandbox;
  try {
    sandbox = await SandboxManager.createSandbox(libraryName, code, { permissions });
  } catch (error) {
    return { atInit: null, afterCall: null, initError: `${error?.name}: ${String(error?.message ?? error).slice(0, 100)}`, initNames: [], lazyNames: [] };
  }
  const ctx = lastContext;
  const atInit = count(ctx);
  const initNames = [...names(ctx)];
  let afterCall = null;
  let callError = null;
  if (exercise) {
    try {
      exercise(sandbox.exports);
      afterCall = count(ctx);
    } catch (error) {
      callError = String(error?.message ?? error).slice(0, 120);
    }
  }
  const lazyNames = names(ctx).slice(initNames.length);
  sandbox.dispose();
  return { atInit, afterCall, callError, initNames, lazyNames };
}

const summarize = (list) => {
  const counts = {};
  for (const n of list) counts[n] = (counts[n] ?? 0) + 1;
  return counts;
};

const results = { wasmImports: null, baseline: null, libraries: {} };

// Fixed Wasm import section of the QuickJS module (identical for all libraries).
const wasmPath = path.join(root, "node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm");
const imports = WebAssembly.Module.imports(new WebAssembly.Module(fs.readFileSync(wasmPath)));
results.wasmImports = {
  total: imports.length,
  functions: imports.filter((i) => i.kind === "function").length,
  memory: imports.filter((i) => i.kind === "memory").length,
};

const baseline = await measure("__baseline__", [], null);
results.baseline = { atInit: baseline.atInit, names: summarize(baseline.initNames) };

for (const [libraryName, entry] of Object.entries(policy)) {
  const grant = entry.permissions ?? [];
  const empty = await measure(libraryName, [], null);
  const granted = await measure(libraryName, grant, exercises[libraryName]);
  results.libraries[libraryName] = {
    grant,
    emptyGrantAtInit: empty.atInit,
    emptyGrantInitError: empty.initError ?? null,
    grantedAtInit: granted.atInit,
    grantDriven: empty.atInit == null ? null : granted.atInit - empty.atInit,
    afterRepresentativeCall: granted.afterCall,
    callError: granted.callError,
    lazyCreated: summarize(granted.lazyNames),
    initNames: summarize(granted.initNames),
  };
}

fs.writeFileSync(path.join(root, "eval-callbacks", "results.json"), JSON.stringify(results, null, 2));
console.log(JSON.stringify({
  wasmImports: results.wasmImports,
  baseline: results.baseline.atInit,
  libraries: Object.fromEntries(Object.entries(results.libraries).map(([k, v]) => [k, {
    grant: v.grant.join(",") || "∅", empty: v.emptyGrantAtInit ?? v.emptyGrantInitError, granted: v.grantedAtInit,
    grantDriven: v.grantDriven, afterCall: v.afterRepresentativeCall, err: v.callError,
  }])),
}, null, 1));
process.exit(0);
