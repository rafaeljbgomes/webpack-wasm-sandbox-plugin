// Part B: end-to-end fuzz of the live VM->host membrane.
//
// Where Part A fuzzes the host decoder in isolation, this drives adversarial
// value graphs out of a real sandbox, through the real marshaller registry and
// membrane, into a granted host function. A compromised library is modeled by
// library code that generates and emits the graphs. We assert the invariants
// an escape would break on the host side:
//   I1  The host never receives a function (we emit data-only graphs, so any
//       function arriving host-side would be a leaked callable).
//   I2  No received value is identical to a host global/builtin.
//   I3  Global Object/Array prototypes stay clean across the whole run.
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs \
//        eval-membrane-fuzz/fuzz-boundary.mjs
import fs from "node:fs";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";

const SEED = 0xb0a7d;
const N = 20_000;

const HOST_CANARIES = new Set([
  Object, Object.prototype, Array, Array.prototype, Function, Function.prototype,
  globalThis, process, Reflect, console, Math, JSON, Buffer, Promise, Symbol,
  Error, Map, Set, Map.prototype, Set.prototype,
]);

const report = {
  seed: SEED, requested: N, node: process.version, v8: process.versions.v8,
  received: 0, functionReceived: 0, hostRefReceived: 0, protoStable: null, pass: null,
};

const isRealSet = (v) => { try { Set.prototype.has.call(v, 0); return true; } catch { return false; } };
const isRealMap = (v) => { try { Map.prototype.has.call(v, 0); return true; } catch { return false; } };

function scan(value, acc, seen, budget) {
  if (budget.n++ > 500_000) return;
  if (value === null) return;
  const t = typeof value;
  if (t === "function") { acc.fn = true; return; }
  if (t !== "object") return;
  if (HOST_CANARIES.has(value)) { acc.hostRef = true; return; }
  if (seen.has(value)) return;
  seen.add(value);
  if (isRealSet(value)) Set.prototype.forEach.call(value, (e) => scan(e, acc, seen, budget));
  else if (isRealMap(value)) Map.prototype.forEach.call(value, (v, k) => { scan(k, acc, seen, budget); scan(v, acc, seen, budget); });
  for (const k of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (d && "value" in d) scan(d.value, acc, seen, budget);
  }
}

// The host sink the sandbox is granted. Every value the library emits arrives
// here after crossing the membrane.
globalThis.Sink = {
  record(value) {
    report.received++;
    const acc = { fn: false, hostRef: false };
    scan(value, acc, new WeakSet(), { n: 0 });
    if (acc.fn) report.functionReceived++;
    if (acc.hostRef) report.hostRefReceived++;
    return 0;
  },
};

// A "compromised" library: it builds adversarial, data-only graphs (nested
// objects and arrays with dangerous keys, Set, Map, deep nesting) and pushes
// each to the granted host sink.
const LIBRARY_BODY = `
  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  var DANGER = ["__proto__", "constructor", "prototype", "polluted", "then", "a", ""];
  function gen(r, depth) {
    var k = r();
    if (depth > 5 || k < 0.45) {
      var p = r();
      if (p < 0.25) return null;
      if (p < 0.5) return (r() * 1e6 - 5e5) | 0;
      if (p < 0.75) return r() < 0.5;
      return DANGER[(r() * DANGER.length) | 0];
    }
    if (k < 0.6) {
      var n = (r() * 4) | 0, arr = [];
      for (var i = 0; i < n; i++) arr.push(gen(r, depth + 1));
      if (r() < 0.4) arr[DANGER[(r() * DANGER.length) | 0]] = gen(r, depth + 1);
      return arr;
    }
    if (k < 0.75) {
      var s = new Set(), m = (r() * 4) | 0;
      for (var j = 0; j < m; j++) s.add(gen(r, depth + 1));
      return s;
    }
    if (k < 0.85) {
      var mp = new Map(), q = (r() * 4) | 0;
      for (var x = 0; x < q; x++) mp.set(gen(r, depth + 1), gen(r, depth + 1));
      return mp;
    }
    var o = {}, c = (r() * 5) | 0;
    for (var y = 0; y < c; y++) o[DANGER[(r() * DANGER.length) | 0]] = gen(r, depth + 1);
    return o;
  }
  return {
    blast: function (n, seed) {
      var r = rng(seed), sent = 0;
      for (var i = 0; i < n; i++) {
        try { Sink.record(gen(r, 0)); sent++; } catch (e) {}
      }
      return sent;
    },
  };
`;

async function run() {
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).length;
  const arrBefore = Object.getOwnPropertyNames(Array.prototype).length;

  const sandbox = await SandboxManager.createSandbox(
    "membrane-fuzz",
    `var __SANDBOXED_LIB__ = (() => { ${LIBRARY_BODY} })();`,
    { permissions: ["Sink"] },
  );
  sandbox.unrefPump?.();

  report.sent = sandbox.exports.blast(N, SEED);
  report.protoStable =
    Object.getOwnPropertyNames(Object.prototype).length === protoBefore &&
    Object.getOwnPropertyNames(Array.prototype).length === arrBefore &&
    {}.polluted === undefined && [].polluted === undefined &&
    Object.prototype.polluted === undefined && Array.prototype.polluted === undefined;

  report.pass =
    report.received > 0 && report.functionReceived === 0 &&
    report.hostRefReceived === 0 && report.protoStable === true;

  sandbox.dispose?.();
  fs.writeFileSync(new URL("./fuzz-boundary-results.json", import.meta.url), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.pass ? 0 : 1);
}

run();
