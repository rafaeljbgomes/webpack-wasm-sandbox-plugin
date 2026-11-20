// Part A: adversarial fuzz of the host-side by-value decoder.
//
// Threat model. A memory-safety bug in a library's QuickJS engine lets the
// attacker choose the bytes the VM-side serializer emits. The host then runs
// `decode(JSON.parse(bytes))` on that attacker-chosen tree. `decode` is the
// membrane code that a "second bug in the membrane" would ride, so we fuzz it
// directly with arbitrary and malicious trees and assert the invariants an
// escape would have to break:
//   I1  No global prototype pollution (Object/Array .prototype stay clean).
//   I2  The decoded graph contains no function and no reference to any host
//       object (decode must construct everything fresh, never hand back a
//       host gadget).
//   I3  Malformed input fails closed (throws or returns undefined); it never
//       executes attacker code or yields a host reference.
// We also measure the recursion depth at which decode stack-overflows, a
// host-side denial-of-service bound.
//
// Run: node eval-membrane-fuzz/fuzz-decode.mjs
import fs from "node:fs";
import { decode } from "../.sandbox/marshallers/value-transfer.js";

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed1;
const N = 500_000;

// Host objects that must never appear in a decoded graph. If decode ever
// returns a reference identical to one of these, the boundary leaked a host
// gadget into attacker-reachable data.
const HOST_CANARIES = new Set([
  Object, Object.prototype, Array, Array.prototype, Function, Function.prototype,
  globalThis, process, Reflect, console, Math, JSON, Buffer, Promise, Symbol,
  decode, Error, Map, Set, Map.prototype, Set.prototype,
]);

const DANGER_KEYS = ["__proto__", "constructor", "prototype", "polluted", "then"];
const STRINGS = ["a", "", "polluted", "__proto__", "x".repeat(40), "\u0000", "toString"];

// --- a seeded generator of adversarial trees -------------------------------
function genTaggedish(r, depth) {
  if (depth > 6 || r() < 0.25) {
    const k = r();
    if (k < 0.2) return [0, null];
    if (k < 0.4) return [0, (r() * 1e6 - 5e5) | 0];
    if (k < 0.6) return [0, r() < 0.5];
    return [0, STRINGS[(r() * STRINGS.length) | 0]];
  }
  const tag = (r() * 7) | 0; // 0..6; 5+ exercises the default/garbage path
  const n = (r() * 4) | 0;
  const kids = () => Array.from({ length: n }, () => genTaggedish(r, depth + 1));
  const keyedKids = () =>
    Array.from({ length: n }, () => {
      const useDanger = r() < 0.5;
      const key = useDanger ? DANGER_KEYS[(r() * DANGER_KEYS.length) | 0]
                            : STRINGS[(r() * STRINGS.length) | 0];
      return [key, genTaggedish(r, depth + 1)];
    });
  switch (tag) {
    case 0: return [0, r() < 0.5 ? null : "p"];
    case 1: return [1, keyedKids(), r() < 0.5 ? 1 : 0];
    case 2: return [2, kids(), keyedKids()];
    case 3: return [3, kids()];
    case 4: return [4, kids().map((k) => [k, genTaggedish(r, depth + 1)])];
    default: {
      // Malformed: wrong arity, non-array node, bad tag, missing fields.
      const g = r();
      if (g < 0.25) return [tag]; // tag with no payload
      if (g < 0.5) return { 0: tag }; // object, not array
      if (g < 0.75) return [99, kids()]; // out-of-range tag
      return [1, "not-an-entry-list", 1]; // wrong field type
    }
  }
}

// Pure-random JSON values, to cover inputs that are not tagged-tree shaped at
// all (JSON.parse of arbitrary attacker bytes can yield any JSON value).
function genJSON(r, depth) {
  const k = r();
  if (depth > 5 || k < 0.4) {
    const p = r();
    if (p < 0.25) return null;
    if (p < 0.5) return (r() * 1e6) | 0;
    if (p < 0.75) return r() < 0.5;
    return STRINGS[(r() * STRINGS.length) | 0];
  }
  if (k < 0.7) return Array.from({ length: (r() * 5) | 0 }, () => genJSON(r, depth + 1));
  const o = {};
  const n = (r() * 5) | 0;
  for (let i = 0; i < n; i++) {
    const key = r() < 0.5 ? DANGER_KEYS[(r() * DANGER_KEYS.length) | 0]
                          : STRINGS[(r() * STRINGS.length) | 0];
    o[key] = genJSON(r, depth + 1);
  }
  return o;
}

// Robust brand checks that do not call methods on a possibly-reparented
// receiver. `decode` can build an array whose `__proto__` key reparents it, so
// `instanceof` and `for..of` are unsafe here; we use the real prototype
// methods with an explicit receiver and treat a throw as "not that type".
const isRealSet = (v) => { try { Set.prototype.has.call(v, 0); return true; } catch { return false; } };
const isRealMap = (v) => { try { Map.prototype.has.call(v, 0); return true; } catch { return false; } };

// Recursively check a decoded value for the forbidden shapes: any function, or
// any reference identical to a host canary. Walks only own data slots (decode
// never creates getters), plus genuine Set/Map contents.
function scan(value, acc, seen, budget) {
  if (budget.n++ > 500_000) return;
  if (value === null) return;
  const t = typeof value;
  if (t === "function") { acc.functionLeaked = true; return; }
  if (t !== "object") return;
  if (HOST_CANARIES.has(value)) { acc.hostRefLeaked = true; return; }
  if (seen.has(value)) return;
  seen.add(value);
  if (isRealSet(value)) { Set.prototype.forEach.call(value, (e) => scan(e, acc, seen, budget)); }
  else if (isRealMap(value)) { Map.prototype.forEach.call(value, (v, k) => { scan(k, acc, seen, budget); scan(v, acc, seen, budget); }); }
  for (const k of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (d && "value" in d) scan(d.value, acc, seen, budget);
  }
}

function run() {
  const r = mulberry32(SEED);
  const protoKeysBefore = Object.getOwnPropertyNames(Object.prototype).length;
  const arrKeysBefore = Object.getOwnPropertyNames(Array.prototype).length;

  const report = {
    seed: SEED, iterations: N, node: process.version, v8: process.versions.v8,
    decoded: 0, threw: 0, functionLeaked: 0, hostRefLeaked: 0,
    globalPollution: 0, errorKinds: {},
  };

  for (let i = 0; i < N; i++) {
    const tree = r() < 0.7 ? genTaggedish(r, 0) : genJSON(r, 0);
    let out, threw = false;
    try {
      // Faithful to the real path: the attacker-chosen bytes are parsed, then
      // decoded. Round-trip through JSON to mirror `decode(JSON.parse(bytes))`.
      out = decode(JSON.parse(JSON.stringify(tree)));
    } catch (e) {
      threw = true;
      const kind = e?.name ?? typeof e;
      report.errorKinds[kind] = (report.errorKinds[kind] ?? 0) + 1;
    }
    if (threw) { report.threw++; }
    else {
      report.decoded++;
      const acc = { functionLeaked: false, hostRefLeaked: false };
      scan(out, acc, new WeakSet(), { n: 0 });
      if (acc.functionLeaked) report.functionLeaked++;
      if (acc.hostRefLeaked) report.hostRefLeaked++;
    }
    // Global pollution check: a successful attack would leave a property on a
    // shared prototype reachable from an ordinary object.
    if ({}.polluted !== undefined || [].polluted !== undefined ||
        {}.__injected !== undefined || "".toUpperCaseX !== undefined) {
      report.globalPollution++;
    }
  }

  report.protoKeysStable =
    Object.getOwnPropertyNames(Object.prototype).length === protoKeysBefore &&
    Object.getOwnPropertyNames(Array.prototype).length === arrKeysBefore;

  // --- explicit prototype-pollution payloads (not left to chance) ----------
  const pollutionPayloads = [
    [1, [["__proto__", [1, [["polluted", [0, "yes"]]], 0]]], 0],
    [2, [], [["__proto__", [0, "yes"]], ["polluted", [0, "yes"]]]],
    [1, [["constructor", [1, [["prototype", [1, [["polluted", [0, 1]]], 0]]], 0]]], 0],
    [1, [["__proto__", [1, [["polluted", [0, 1]]], 1]]], 1],
  ];
  report.pollutionPayloadsTried = pollutionPayloads.length;
  report.pollutionAfterTargeted = (() => {
    for (const p of pollutionPayloads) { try { decode(p); } catch {} }
    return {}.polluted !== undefined || [].polluted !== undefined ||
           Object.prototype.polluted !== undefined || Array.prototype.polluted !== undefined;
  })();

  // --- stack-overflow (host-side DoS) depth bound --------------------------
  report.decodeStackOverflowDepth = (() => {
    for (const depth of [1e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5]) {
      let t = [0, 1];
      for (let d = 0; d < depth; d++) t = [1, [["k", t]], 0];
      try { decode(t); } catch (e) {
        if (e instanceof RangeError) return depth;
      }
    }
    return null; // survived the largest depth tried
  })();

  report.pass =
    report.functionLeaked === 0 && report.hostRefLeaked === 0 &&
    report.globalPollution === 0 && report.protoKeysStable &&
    report.pollutionAfterTargeted === false;

  fs.writeFileSync(new URL("./fuzz-decode-results.json", import.meta.url), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.pass ? 0 : 1);
}

run();
