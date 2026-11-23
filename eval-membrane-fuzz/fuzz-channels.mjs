// Part C: end-to-end fuzz of the channels Part B does not reach.
//
// Part B sends data-only graphs from the VM to a granted host sink. Part C
// drives a live sandbox through the other four channels of Section 3.6, with
// seeded random host values (plain data, Date, Map, Set, RegExp, typed arrays,
// errors, class instances with getters and setters, Proxy objects, objects
// with a null prototype or symbol keys, boxed primitives, cycles, and host
// callbacks that return or throw such values):
//
//   C1 host -> VM arguments: the host calls a library export with a random
//      host graph; the library probes everything it can reach from it.
//   C2 callbacks: the arguments include host callbacks; the library calls
//      them with random VM graphs (VM -> host) and probes what they return or
//      throw (host -> VM).
//   C3 granted APIs: the library calls methods of a granted host object that
//      return random host graphs, probes the results, and tries to write
//      functions, objects and primitives into them.
//   C4 returned library objects: the library returns class instances; the
//      host keeps them, calls their methods with random host graphs, reads and
//      writes their properties (reverse membrane: tempCall/tempGet/set).
//
// Oracles (an escape or a membrane violation breaks at least one):
//   V1 (VM side) No function reachable by the library evaluates code in the
//      host realm: for every reachable function f (values, getters, setters,
//      prototypes, constructors, bound/called results, thrown errors),
//      neither f("return typeof process") (called, if it returns a function)
//      nor f.constructor("return typeof process")() may return "object".
//   H1 (host side) No value the host receives is a host built-in or global.
//   H2 Host Object/Array/Function prototypes stay unpolluted.
//   H3 Host argument graphs are unchanged after each call (arguments cross by
//      value), compared by a canonical description taken before the call.
//   H4 The granted object keeps its state, apart from the one property the
//      policy lists as writable, and nothing but primitives is written there.
//
// Run (positive control: FUZZ_CONTROL=leak): node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs \
//        eval-membrane-fuzz/fuzz-channels.mjs [iterations]
import fs from "node:fs";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";

const SEED = 0xc4a11;
const N = Number(process.argv[2] ?? 4000);

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r = rng(SEED);
const pick = (a) => a[(r() * a.length) | 0];
const DANGER = ["__proto__", "constructor", "prototype", "polluted", "then", "toString", "valueOf", "a", ""];
const SYM = Symbol("hostSym");

const HOST_CANARIES = new Set([
  Object, Object.prototype, Array, Array.prototype, Function, Function.prototype,
  globalThis, process, Reflect, console, Math, JSON, Buffer, Promise, Symbol,
  Error, Map, Set, Map.prototype, Set.prototype, eval, setTimeout,
]);

const stats = {
  seed: SEED, iterations: N, node: process.version,
  c1Calls: 0, c2CallbackCalls: 0, c3ApiCalls: 0, c4HostOps: 0,
  vmProbedValues: 0, vmProbedFunctions: 0,
  V1_hostEval: 0, H1_hostRef: 0, H2_pollution: null, H3_argMutated: 0, H4_grantChanged: 0, H4_nonPrimitiveWritten: 0,
  errors: 0, violations: [],
};
const violation = (k, detail) => { if (stats.violations.length < 50) stats.violations.push({ k, detail: String(detail).slice(0, 200) }); };

// ---------- host-side value generator ----------
class HostThing {
  #secret = 42;
  constructor(x) { this.x = x; this.list = [x]; }
  get secret() { return this.#secret; }
  set secret(v) { this.#secret = v; }
  method(y) { return { y, self: this.x }; }
}
let callbackSink = []; // what host callbacks received (scanned with H1)
function hostCallback(depth) {
  const kind = r();
  const ret = kind < 0.7 ? genHost(depth + 1) : null;
  const f = function appCallback(...args) {
    stats.c2CallbackCalls++;
    callbackSink.push(args);
    if (kind > 0.85) throw pick([new TypeError("host type error"), new RangeError("r"), Object.assign(new Error("e"), { payload: ret })]);
    return ret;
  };
  if (r() < 0.3) f.extra = genHost(depth + 1);
  return f;
}
function genHost(depth = 0) {
  const k = r();
  if (depth > 4 || k < 0.3) {
    const p = r();
    if (p < 0.15) return null;
    if (p < 0.25) return undefined;
    if (p < 0.45) return (r() * 1e6 - 5e5) | 0;
    if (p < 0.55) return r() < 0.5;
    if (p < 0.65) return pick([NaN, -0, Infinity, 1e300]);
    return pick(DANGER);
  }
  if (k < 0.4) { const a = []; const n = (r() * 4) | 0; for (let i = 0; i < n; i++) a.push(genHost(depth + 1)); if (r() < 0.3) a[pick(DANGER)] = genHost(depth + 1); return a; }
  if (k < 0.5) { const o = {}; const n = (r() * 4) | 0; for (let i = 0; i < n; i++) Object.defineProperty(o, pick(DANGER), { value: genHost(depth + 1), enumerable: true, writable: true, configurable: true }); if (r() < 0.2) o[SYM] = 1; return o; }
  if (k < 0.55) { const o = Object.create(null); o.a = genHost(depth + 1); return o; }
  if (k < 0.6) { const s = new Set(); const n = (r() * 3) | 0; for (let i = 0; i < n; i++) s.add(genHost(depth + 1)); return s; }
  if (k < 0.65) { const m = new Map(); const n = (r() * 3) | 0; for (let i = 0; i < n; i++) m.set(genHost(depth + 1), genHost(depth + 1)); return m; }
  if (k < 0.68) return new Date(1_700_000_000_000 + ((r() * 1e9) | 0));
  if (k < 0.71) return pick([/a+b/g, new RegExp("x", "i")]);
  if (k < 0.75) return pick([new Uint8Array([1, 2, 3]), new Float64Array(2), new ArrayBuffer(8), new DataView(new ArrayBuffer(4))]);
  if (k < 0.78) return pick([new TypeError("t"), new Error("e"), Object.assign(new RangeError("r"), { extra: genHost(depth + 1) })]);
  if (k < 0.83) return new HostThing(genHost(depth + 1));
  if (k < 0.86) { const t = { a: 1 }; return new Proxy(t, { get: (o, key) => (key === "a" ? hostCallback(depth) : Reflect.get(o, key)) }); }
  if (k < 0.88) return Object.freeze({ frozen: genHost(depth + 1) });
  if (k < 0.9) return pick([Object("s"), Object(1), Object(false)]);
  if (k < 0.92) { const o = { v: 1 }; Object.defineProperty(o, "g", { get: () => hostCallback(depth), enumerable: true }); return o; }
  if (k < 0.94) { const o = { a: 1 }; o.self = o; o.arr = [o]; return o; }
  return hostCallback(depth);
}

// Canonical description of a host graph (H3): own keys incl. symbols and
// accessors (not invoked), primitive values, Date time, Map/Set entries,
// typed-array bytes, private-field state through the class's own getter.
function describe(v, seen = new Map(), depth = 0) {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return typeof v === "number" && Object.is(v, -0) ? "-0" : typeof v + ":" + String(v);
  if (seen.has(v)) return "#" + seen.get(v);
  seen.set(v, seen.size);
  if (depth > 8) return "deep";
  let s = typeof v === "function" ? "fn(" + v.name + ")" : Object.prototype.toString.call(v);
  if (v instanceof Date) s += Date.prototype.getTime.call(v);
  if (v instanceof Map) s += "{" + [...Map.prototype.entries.call(v)].map(([a, b]) => describe(a, seen, depth + 1) + "=>" + describe(b, seen, depth + 1)).join(",") + "}";
  if (v instanceof Set) s += "{" + [...Set.prototype.values.call(v)].map((a) => describe(a, seen, depth + 1)).join(",") + "}";
  if (ArrayBuffer.isView(v)) s += "[" + new Uint8Array(v.buffer, v.byteOffset, v.byteLength).join(",") + "]";
  if (v instanceof ArrayBuffer) s += "[" + new Uint8Array(v).join(",") + "]";
  if (v instanceof HostThing) s += "secret=" + v.secret;
  s += "<" + (Object.getPrototypeOf(v)?.constructor?.name ?? "null") + ">";
  for (const k of Reflect.ownKeys(v)) {
    const d = Reflect.getOwnPropertyDescriptor(v, k);
    s += String(k) + ":" + (d.get || d.set ? "accessor" : describe(d.value, seen, depth + 1)) + (d.writable === false ? "!" : "") + ";";
  }
  return s;
}

// H1 scan of anything the host receives.
function scanHost(value, seen = new WeakSet(), budget = { n: 0 }) {
  if (budget.n++ > 20000 || value === null) return;
  const t = typeof value;
  if (t !== "object" && t !== "function") return;
  if (HOST_CANARIES.has(value)) { stats.H1_hostRef++; violation("H1", "host builtin received"); return; }
  if (seen.has(value)) return;
  seen.add(value);
  let keys = [];
  try { keys = Reflect.ownKeys(value); } catch { return; }
  for (const k of keys) {
    let d; try { d = Object.getOwnPropertyDescriptor(value, k); } catch { continue; }
    if (d && "value" in d) scanHost(d.value, seen, budget);
  }
}

// ---------- the granted host API (C3) ----------
const apiState = { counter: 0, label: "api", nested: { level: 1 } };
globalThis.Api = {
  state: apiState,
  make() { stats.c3ApiCalls++; return genHost(0); },
  thing() { stats.c3ApiCalls++; return new HostThing(genHost(1)); },
  callback() { stats.c3ApiCalls++; return hostCallback(0); },
  echo(v) { stats.c3ApiCalls++; scanHost(v); return v; },
};
// Positive control (FUZZ_CONTROL=leak): the grant hands the library the host's
// Function constructor (as a granted value) and its eval (as a call result),
// which V1 must detect.
if (process.env.FUZZ_CONTROL === "leak") { globalThis.Api.leak = () => eval; globalThis.Api.evaluator = Function; }
stats.control = process.env.FUZZ_CONTROL ?? null;
const apiSnapshot = () => describe(globalThis.Api.state.nested) + "|" + globalThis.Api.state.label + "|" + Object.keys(globalThis.Api).join(",") + "|" + Object.keys(apiState).join(",");
const apiBefore = apiSnapshot();

// ---------- the compromised library ----------
const LIBRARY_BODY = `
  function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; var t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  var r = rng(${SEED ^ 0x5a5a});
  var DANGER = ["__proto__", "constructor", "prototype", "polluted", "then", "a", ""];
  var stats = { probed: 0, functions: 0, escapes: 0, where: {} };
  function gen(d) {
    var k = r();
    if (d > 4 || k < 0.45) { var p = r(); return p < 0.3 ? null : p < 0.6 ? ((r() * 1e6) | 0) : DANGER[(r() * DANGER.length) | 0]; }
    if (k < 0.65) { var a = [], n = (r() * 3) | 0; for (var i = 0; i < n; i++) a.push(gen(d + 1)); return a; }
    if (k < 0.75) { var s = new Set(); s.add(gen(d + 1)); return s; }
    if (k < 0.8) { var m = new Map(); m.set(gen(d + 1), gen(d + 1)); return m; }
    var o = {}, c = (r() * 4) | 0; for (var y = 0; y < c; y++) o[DANGER[(r() * DANGER.length) | 0]] = gen(d + 1); return o;
  }
  function hostEval(f, where) {
    stats.functions++;
    var probes = [
      function () { return f.constructor("return typeof process")(); },
      function () { return Object.getPrototypeOf(f).constructor("return typeof process")(); },
      function () { return f.call.constructor("return typeof process")(); },
      function () { return f.bind(null).constructor("return typeof process")(); },
      function () { return new f.constructor.constructor("return typeof process")(); },
      // The function itself may be a host code evaluator (Function, eval).
      function () { var g = f("return typeof process"); return typeof g === "function" ? g() : g; },
      function () { return f("typeof process"); },
    ];
    for (var i = 0; i < probes.length; i++) {
      try { if (probes[i]() === "object") { stats.escapes++; var w = where.split(".").slice(0, 2).join(".") + "#" + i; stats.where[w] = (stats.where[w] || 0) + 1; } } catch (e) {}
    }
  }
  // Probes everything reachable from v, breadth-first (so that shallow values
  // are always reached before the budget runs out): values, getters and
  // setters, constructors, prototypes; calls functions it finds (host
  // callbacks) with random VM graphs and probes what they return or throw;
  // tries to write through every object it reaches.
  function probe(root, rootWhere, seen, budget, rootDepth) {
    var queue = [[root, rootWhere, rootDepth]];
    while (queue.length && budget.n < 1500) {
      var item = queue.shift(), v = item[0], where = item[1], callDepth = item[2];
      if (v === null || v === undefined) continue;
      var t = typeof v;
      if (t !== "object" && t !== "function") continue;
      if (seen.indexOf(v) >= 0) continue;
      seen.push(v); budget.n++;
      stats.probed++;
      if (t === "function") {
        hostEval(v, where);
        if (callDepth < 2) {
          try { queue.push([v(gen(0), gen(0)), where + "()", callDepth + 1]); }
          catch (e) { queue.push([e, where + "!throw", callDepth + 1]); }
        }
      }
      var keys = []; try { keys = Reflect.ownKeys(v); } catch (e) {}
      for (var i = 0; i < keys.length && i < 16; i++) {
        var d; try { d = Object.getOwnPropertyDescriptor(v, keys[i]); } catch (e) { continue; }
        if (!d) continue;
        if (d.get) queue.push([d.get, where + ".get", callDepth]);
        if (d.set) queue.push([d.set, where + ".set", callDepth]);
        if ("value" in d) queue.push([d.value, where + "." + String(keys[i]), callDepth]);
      }
      try { queue.push([v.constructor, where + ".constructor", callDepth]); } catch (e) {}
      try { queue.push([Object.getPrototypeOf(v), where + ".__proto__", callDepth]); } catch (e) {}
      if (t === "object") {
        try { v.polluted = gen(0); } catch (e) {}
        try { v[DANGER[(r() * DANGER.length) | 0]] = function () { return 1; }; } catch (e) {}
        try { delete v.a; } catch (e) {}
        try { Object.setPrototypeOf(v, null); } catch (e) {}
        try { if (typeof v.setTime === "function") v.setTime(0); } catch (e) {}
        try { if (typeof v.clear === "function") v.clear(); } catch (e) {}
        try { if (typeof v.set === "function" && v.length !== undefined) v.set([9]); } catch (e) {}
        try { v.secret = 7; } catch (e) {}
      }
    }
  }
  function LibThing(x) { this.x = x; this.n = 0; }
  LibThing.prototype.run = function (arg) { this.n++; probe(arg, "c4.arg", [], { n: 0 }, 0); return gen(0); };
  Object.defineProperty(LibThing.prototype, "count", { get: function () { return this.n; } });
  return {
    take: function (a, b) { probe(a, "c1.a", [], { n: 0 }, 0); probe(b, "c1.b", [], { n: 0 }, 0); return gen(0); },
    useApi: function () {
      var B = function () { return { n: 0 }; };
      try { probe(Api.make(), "c3.make", [], B(), 0); } catch (e) { probe(e, "c3.make!", [], B(), 0); }
      try { probe(Api.thing(), "c3.thing", [], B(), 0); } catch (e) {}
      try { probe(Api.callback(), "c3.callback", [], B(), 0); } catch (e) {}
      try { probe(Api.echo(gen(0)), "c3.echo", [], B(), 0); } catch (e) {}
      try { probe(Api, "c3.Api", [], B(), 0); } catch (e) {}
      try { if (Api.leak) probe(Api.leak(), "c3.leak", [], B(), 0); } catch (e) {}
      try { Api.state.counter = r(); } catch (e) {}
      try { Api.state.counter = function () {}; } catch (e) {}
      try { Api.state.counter = { x: 1 }; } catch (e) {}
      try { Api.state.label = "x"; } catch (e) {}
      try { Api.state.nested.level = 99; } catch (e) {}
      try { Api.make = function () { return 0; }; } catch (e) {}
      try { Api.added = 1; } catch (e) {}
      return 0;
    },
    makeThing: function (x) { return new LibThing(x); },
    report: function () { return JSON.stringify(stats); },
  };
`;

async function run() {
  const protoBefore = [Object.prototype, Array.prototype, Function.prototype].map((p) => Object.getOwnPropertyNames(p).join(","));
  const sandbox = await SandboxManager.createSandbox(
    "membrane-fuzz-channels",
    `var __SANDBOXED_LIB__ = (() => { ${LIBRARY_BODY} })();`,
    { permissions: ["Api"], writable: { Api: ["state.counter"] } },
  );
  sandbox.unrefPump?.();
  const lib = sandbox.exports;
  const things = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    callbackSink = [];
    try {
      const mode = i % 3;
      if (mode === 0) {
        // C1 + C2: host graph (with callbacks) into the library.
        const a = genHost(0), b = hostCallback(0);
        const before = describe(a) + describe(b);
        stats.c1Calls++;
        const out = lib.take(a, b);
        scanHost(out);
        if (describe(a) + describe(b) !== before) { stats.H3_argMutated++; violation("H3", "argument changed at iteration " + i); }
      } else if (mode === 1) {
        // C3: granted API.
        lib.useApi();
        const c = globalThis.Api.state.counter;
        if (c !== null && (typeof c === "object" || typeof c === "function")) { stats.H4_nonPrimitiveWritten++; violation("H4", "non-primitive written"); }
        if (apiSnapshot() !== apiBefore) { stats.H4_grantChanged++; violation("H4", apiSnapshot()); }
      } else {
        // C4: library object kept by the host.
        if (things.length < 50 || r() < 0.1) things.push(lib.makeThing(genHost(0)));
        const th = pick(things);
        const arg = genHost(0);
        const before = describe(arg);
        stats.c4HostOps++;
        scanHost(th.run(arg));
        void th.count; void th.x;
        if (r() < 0.3) { try { th.x = genHost(0); } catch {} }
        if (describe(arg) !== before) { stats.H3_argMutated++; violation("H3", "c4 argument changed at iteration " + i); }
      }
      for (const args of callbackSink) scanHost(args);
    } catch (e) {
      stats.errors++;
    }
  }
  stats.seconds = (Date.now() - t0) / 1000;
  const vm = JSON.parse(lib.report());
  stats.vmProbedValues = vm.probed; stats.vmProbedFunctions = vm.functions; stats.V1_hostEval = vm.escapes;
  stats.V1_byPath = vm.where;
  const protoAfter = [Object.prototype, Array.prototype, Function.prototype].map((p) => Object.getOwnPropertyNames(p).join(","));
  stats.H2_pollution = protoAfter.some((p, i) => p !== protoBefore[i]) || {}.polluted !== undefined || [].polluted !== undefined;
  stats.pass = stats.V1_hostEval === 0 && stats.H1_hostRef === 0 && !stats.H2_pollution && stats.H3_argMutated === 0 && stats.H4_grantChanged === 0 && stats.H4_nonPrimitiveWritten === 0;
  // Not disposed: the host still holds library objects from C4, and freeing
  // the runtime with live handles aborts in QuickJS's leak assertion.
  fs.writeFileSync(new URL("./fuzz-channels-results.json", import.meta.url), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats, null, 1));
  process.exit(stats.pass ? 0 : 1);
}
run();
