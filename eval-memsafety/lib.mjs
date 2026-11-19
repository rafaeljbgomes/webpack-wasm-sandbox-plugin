// Shared helpers for the memory-safety containment experiment.
//
// Threat emulation: a memory-safety bug in QuickJS gives the attacker, at
// most, arbitrary read/write of the Wasm linear memory of the module instance
// that runs the vulnerable library, plus the ability to make that instance
// call its own Wasm imports with arbitrary arguments. We grant the attacker
// both primitives directly from the host side (a strict superset of what a
// real exploit obtains) and observe what else is reachable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QuickJSContext } from "quickjs-emscripten";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- capture every Wasm instantiation (instance + import object) ----------
export const instances = [];
const origInstantiate = WebAssembly.instantiate;
WebAssembly.instantiate = async function (source, imports, ...rest) {
  const result = await origInstantiate.call(this, source, imports, ...rest);
  const instance = result instanceof WebAssembly.Instance ? result : result.instance;
  let memory;
  for (const ns of Object.values(imports ?? {})) for (const v of Object.values(ns)) if (v instanceof WebAssembly.Memory) memory = v;
  for (const v of Object.values(instance.exports)) if (v instanceof WebAssembly.Memory) memory ??= v;
  instances.push({ instance, imports, memory });
  return result;
};

// --- tag every host function registered in a QuickJS context --------------
// hostCalls records (owner label, function name) for each host function the
// QuickJS side invokes. `currentLabel` names the sandbox being built/used.
export let currentLabel = "?";
export const setLabel = (l) => { currentLabel = l; };
export const hostCalls = [];
export const hostErrors = [];
export const registered = new Map(); // label -> count of host functions registered
const ctxOwner = new WeakMap();
const origNewFunction = QuickJSContext.prototype.newFunction;
QuickJSContext.prototype.newFunction = function (name, fn) {
  if (!ctxOwner.has(this)) ctxOwner.set(this, currentLabel);
  const owner = ctxOwner.get(this);
  registered.set(owner, (registered.get(owner) ?? 0) + 1);
  const fname = String(name || "<anon>");
  return origNewFunction.call(this, name, function (...args) {
    hostCalls.push({ owner, fname });
    try {
      return fn.apply(this, args);
    } catch (e) {
      hostErrors.push({ owner, fname, error: e?.name ?? typeof e });
      throw e;
    }
  });
};

export const bundle = (lib) => fs.readFileSync(path.join(root, "dist", `${lib}.bundle.js`), "utf8");

let sharedInst;
/** Creates a sandbox and returns it with its own module's memory/imports. */
export async function sandbox(label, lib, permissions = [], { shared = false, code = null } = {}) {
  setLabel(label);
  const before = instances.length;
  let sb;
  if (shared) {
    const n = instances.length;
    await SandboxManager.ready();
    if (instances.length > n) sharedInst = instances[instances.length - 1];
    sb = SandboxManager.createSandboxSync(lib, code ?? bundle(lib), { permissions });
  } else {
    sb = await SandboxManager.createSandbox(lib, code ?? bundle(lib), { permissions });
  }
  const inst = shared ? sharedInst : instances[instances.length - 1];
  if (!shared && instances.length === before) throw new Error("no new module instance");
  return { label, lib, sb, ...inst, ctxPtr: sb.vm.ctx.value };
}

/** Finds the import callback that dispatches QuickJS -> host function calls. */
export function callFunctionImport(imports) {
  for (const ns of Object.values(imports)) {
    for (const v of Object.values(ns)) {
      if (typeof v === "function" && /callbacks\.callFunction/.test(String(v))) return v;
    }
  }
  throw new Error("callFunction import not found");
}

export function countImports(imports) {
  let fns = 0, mem = 0, other = 0;
  for (const ns of Object.values(imports)) for (const v of Object.values(ns)) {
    if (typeof v === "function") fns++; else if (v instanceof WebAssembly.Memory) mem++; else other++;
  }
  return { functions: fns, memories: mem, other };
}

/** Byte-level search for an ASCII marker in a linear memory (UTF-8/Latin-1 and UTF-16LE). */
export function findMarker(memory, marker) {
  const hay = Buffer.from(memory.buffer);
  const utf8 = hay.indexOf(Buffer.from(marker, "latin1"));
  const utf16 = hay.indexOf(Buffer.from(marker, "utf16le"));
  return utf8 >= 0 || utf16 >= 0;
}

export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function classifyError(e) {
  if (e instanceof WebAssembly.RuntimeError) return "wasm-trap";
  if (e && e.name === "RangeError" && /call stack/i.test(e.message)) return "stack-overflow";
  return "js-exception";
}
