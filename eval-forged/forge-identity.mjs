// The membrane against a corrupted engine: forged identity references.
//
// Parts A-C of the membrane fuzzing (Section 4.4) give the host WELL-FORMED
// QuickJS values. Under a QuickJS memory-safety bug the attacker instead
// controls the library's linear memory, so the values the host reads can be
// forged. This test targets the one place a forgery could make the host hand
// out another sandbox's or the host's own object: the identity map that the
// Arena keeps so that a QuickJS value maps back to the same host object each
// time it crosses.
//
// WHERE THE IDENTITY MAPS LIVE (quickjs-emscripten-sync 1.8.1 Arena):
//   * HOST HALF, in the host heap, out of the library's reach: `_map`
//     (unregistered objects) and `_registeredMap` (intrinsics seeded from
//     defaultRegisteredObjects). Each holds `_counterMap`, a plain Map from an
//     integer counter to the host object, and `_map3`, counter -> QuickJS
//     handle. Every Arena has its OWN pair; counters in different Arenas are
//     independent even though they share the numeric range.
//   * VM HALF, inside the library's linear memory, which the attacker
//     controls: a QuickJS closure holding two WeakMaps (object -> counter),
//     plus the compiled `findBoth` and `bulkDescribe` closures the Arena calls
//     to turn a crossing value into its counter(s). When a value crosses out,
//     the host calls the VM half to get the counter, then looks the counter up
//     in its own host half.
//
// THE FORGERY. An attacker who controls the VM half chooses the counter the
// host receives. We emulate the strongest version: we intercept every call the
// host makes into the VM half (`_map._mapGet`, `_registeredMap._mapGet`,
// `findBoth`) and replace the returned counter with one the attacker picks:
//   own       a counter of another of the victim's own objects
//   intrinsic a counter in the victim's registered-intrinsic map
//   bystander a counter drawn from the BYSTANDER's map (same numeric range)
//   oob       a counter in no map
// and we rewrite the `bulkDescribe` JSON so each encoded reference ({m:n}/{g:n})
// uses a forged counter too. The forgery is driven while the victim hands an
// object to the host through each VM->host channel:
//   return value, nested return value, argument to a granted host function,
//   and argument to a host callback.
//
// ORACLE. For every value the host receives, it must be one of: a primitive,
// one of the victim's OWN registered objects (its own intrinsics/handles), or
// a fresh object built by the membrane. It must NEVER be an object from the
// bystander's maps, a host global/builtin, or a host secret. The bystander
// must keep working.
//
// CONFIGURATIONS. real: each sandbox has its own host half (the shipped
// design). control: the victim's host half resolves a missing counter in the
// bystander's host half -- a single shared identity space, the design a
// per-Arena map avoids. The control must let the forgery through; the real
// configuration must not.
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-forged/forge-identity.mjs
import fs from "node:fs";
import { sandbox } from "../eval-memsafety/lib.mjs";
import { defaultRegisteredObjects } from "quickjs-emscripten-sync";
import { mulberry32 } from "../eval-memsafety/lib.mjs";
const SEED = 0xf0d9e;
const rnd = mulberry32(SEED);
const pickN = (a) => a[(rnd() * a.length) | 0];
const REG = new Map(defaultRegisteredObjects);

const HOST_SECRET = "host-secret-" + "9c41e7d2b8";
const BYSTANDER_SECRET = "bystander-secret-" + "5f0a3c";
globalThis.__hostSecret = HOST_SECRET;
// Non-registered host globals only. The Arena seeds _registeredMap with the
// host's own intrinsics (Object, Array, Function and their prototypes, the
// Error classes, Symbol and its well-known symbols) from defaultRegisteredObjects;
// those cross by identity by design, in normal operation, with or without a
// forgery, so receiving one is not an escape. These globals are never
// registered, so the host must never receive one.
const HOST_GLOBALS = new Set([globalThis, process, eval, Reflect, console, JSON, Math, Buffer, setTimeout, Promise, WebAssembly, fs].filter((g) => !REG.has(g)));

// The objects the victim will try to pass out, one per crossing.
const OBJECT_KINDS = [
  "({a:1,b:2})", "[1,2,3]", "function f(){return 1;}", "new Map([[1,2]])",
  "new Set([1,2])", "new Error('e')", "Object.prototype", "Array.prototype",
  "Function", "Object", "Function.prototype", "new Uint8Array([1,2,3,4])",
  "/re/g", "Object.create(null)", "{get x(){return 1;}}", "new Date(0)",
  "Symbol.iterator", "(class K{m(){return 2;}})", "new (class K2{constructor(){this.v=9;}})()",
];
const CHANNELS = ["return", "nested", "grantedArg", "callbackArg"];

async function makeVictim() {
  const V = await sandbox("victim", "victim", ["Api"], {
    code: `var kinds = [${OBJECT_KINDS.join(",")}];
      var __SANDBOXED_LIB__ = {
        ret: (i) => kinds[i],
        nest: (i) => ({ wrapped: kinds[i], list: [kinds[i]] }),
        toApi: (i) => Api.sink(kinds[i]),
        toCb: (i, f) => f(kinds[i]),
        ping: () => 1,
      };`,
  });
  V.sb.unrefPump?.();
  return V;
}

function installForgery(V, numbers) {
  // numbers() returns the attacker-chosen counter for the current mode, or
  // null to pass the true answer through unchanged.
  const vm = V.sb.vm, arena = V.sb.arena, st = arena._qesState;
  const idFn = vm.unwrapResult(vm.evalCode("(x) => x"));
  const numberFns = new Set([arena._map._mapGet, arena._registeredMap._mapGet, st?.findBoth].filter(Boolean));
  const orig = vm.callFunction;
  let on = false;
  vm.callFunction = function (fn, thisArg, ...args) {
    const res = orig.call(this, fn, thisArg, ...args);
    if (!on || res.error) return res;
    const n = numbers();
    if (n === null) return res;
    try {
      if (numberFns.has(fn)) {
        res.value.dispose();
        const code = fn === st?.findBoth ? n.findBothCode : n.plain;
        return vm.newNumber(code).consume((h) => orig.call(this, idFn, vm.undefined, h));
      }
      if (st && fn === st.bulkDescribe) {
        const isStr = vm.typeof(res.value) === "string";
        const jsonH = isStr ? res.value : vm.getProp(res.value, 0);
        const out = JSON.parse(vm.getString(jsonH));
        if (!isStr) jsonH.dispose();
        const fe = (enc) => (enc && typeof enc === "object" && (enc.m !== undefined || enc.g !== undefined)) ? { [rnd() < 0.5 ? "m" : "g"]: n.plain } : enc;
        if (out.p !== undefined) out.p = fe(out.p);
        for (const e of out.e ?? []) { if ((e[1] & 16) || (e[1] & 32)) e[2] = fe(e[2]); if (e[1] & 64) e[3] = fe(e[3]); }
        const s = vm.newString(JSON.stringify(out));
        if (isStr) { res.value.dispose(); return s.consume((h) => orig.call(this, idFn, vm.undefined, h)); }
        vm.setProp(res.value, 0, s); s.dispose();
        return res;
      }
    } catch { return res; }
    return res;
  };
  return { set: (v) => { on = v; } };
}

function scan(v, arena, seen = new Set(), depth = 0) {
  // Returns the first oracle violation found, or null.
  if (v === null || (typeof v !== "object" && typeof v !== "function")) {
    if (v === HOST_SECRET) return "host-secret-string";
    if (v === BYSTANDER_SECRET) return "bystander-secret-string";
    return null;
  }
  if (seen.has(v) || depth > 4) return null;
  seen.add(v);
  if (HOST_GLOBALS.has(v)) return "host-global";
  if (bystanderObjs.has(v) && !arena._registeredMap._map1.has(v)) return "bystander-object";
  // A victim's own registered intrinsic is allowed; do not recurse into host intrinsics.
  if (arena._registeredMap._map1.has(v)) return null;
  let keys = [];
  try { keys = Reflect.ownKeys(v).slice(0, 12); } catch {}
  for (const k of keys) { let x; try { x = v[k]; } catch { continue; } const r = scan(x, arena, seen, depth + 1); if (r) return r; }
  return null;
}

// ---- bystander: date-fns with an Intl grant, holding a host secret ----
let bystanderObjs = new Set();
const B = await sandbox("bystander", "date-fns", ["Intl"]);
B.sb.unrefPump?.();
const BYSTANDER_HOST_OBJ = { secret: BYSTANDER_SECRET, tag: "bystander" };
try { B.sb.exports.format(new Date(0), "yyyy", { locale: { code: "x", data: BYSTANDER_HOST_OBJ } }); } catch {}
const refreshBystander = () => {
  bystanderObjs = new Set([BYSTANDER_HOST_OBJ]);
  for (const v of B.sb.arena._map._counterMap.values()) if (v && (typeof v === "object" || typeof v === "function")) bystanderObjs.add(v);
  for (const v of B.sb.arena._registeredMap._counterMap.values()) if (v && (typeof v === "object" || typeof v === "function") && !REG.has(v)) bystanderObjs.add(v);
};
refreshBystander();
const bystanderExpected = B.sb.exports.format(new Date(0), "yyyy-MM-dd'T'HH:mm");

const report = { node: process.version, seed: SEED, objectKinds: OBJECT_KINDS.length, channels: CHANNELS, forgedCounterModes: ["own","intrinsic","bystander","bystanderReg","oob"], repetitions: 20, bystanderHostObjects: bystanderObjs.size, bystanderSecretInOwnMemory: Buffer.from(B.memory.buffer).includes(Buffer.from(BYSTANDER_SECRET)), configs: {} };

for (const config of ["real", "control"]) {
  const V = await makeVictim();
  const arena = V.sb.arena, L = V.sb.exports;
  // Bind every export once, before any forgery, so the host caches bindings.
  for (const k of ["ret", "nest", "toApi", "toCb", "ping"]) { try { k === "toCb" ? L[k](0, () => 0) : L[k](0); } catch {} }
  if (config === "control") {
    // One shared identity space: a counter the victim lacks resolves in the
    // bystander's host half. This is the design the per-Arena maps avoid.
    for (const half of ["_map", "_registeredMap"]) {
      const victimHalf = arena[half], bystHalf = B.sb.arena[half];
      const base = victimHalf._counterMap;
      class Shared extends Map { get(k) { const v = super.get(k); return v !== undefined ? v : bystHalf._counterMap.get(k); } }
      victimHalf._counterMap = new Shared(base);
    }
  }
  refreshBystander();
  const bystNums = [...B.sb.arena._map._counterMap.keys()];
  const bystRegNums = [...B.sb.arena._registeredMap._counterMap.keys()];
  const ownNums = [...arena._map._counterMap.keys()];
  const regNums = [...arena._registeredMap._counterMap.keys()];
  let cur = null;
  const forgery = installForgery(V, () => cur);
  let hostArg; globalThis.Api = { sink: (x) => { hostArg = x; return 0; } };

  const trials = [];
  const res = { trials: 0, crossingsAttempted: 0, deliveredForeignObject: 0, deliveredHostGlobalOrSecret: 0, oracleViolations: 0, bystanderBroken: 0, violationsSample: [] };
  const MODES = {
    own: () => ({ plain: pickN(ownNums) ?? 0, findBothCode: -(pickN(ownNums) ?? 0) }),
    intrinsic: () => ({ plain: pickN(regNums) ?? 0, findBothCode: pickN(regNums) ?? 0 }),
    bystander: () => ({ plain: pickN(bystNums) ?? 0, findBothCode: -(pickN(bystNums) ?? 0) }),
    bystanderReg: () => ({ plain: pickN(bystRegNums) ?? 0, findBothCode: pickN(bystRegNums) ?? 0 }),
    oob: () => ({ plain: 1234567 + ((rnd() * 1000) | 0), findBothCode: 1234567 }),
  };
  for (let rep = 0; rep < 20; rep++) {
    for (let i = 0; i < OBJECT_KINDS.length; i++) {
      for (const ch of CHANNELS) {
        for (const mode of Object.keys(MODES)) {
          res.trials++;
          cur = MODES[mode]();
          hostArg = undefined;
          forgery.set(true);
          let out, threw = false;
          try {
            if (ch === "return") out = L.ret(i);
            else if (ch === "nested") out = L.nest(i);
            else if (ch === "grantedArg") { L.toApi(i); out = hostArg; }
            else { L.toCb(i, (x) => { out = x; }); }
          } catch { threw = true; }
          forgery.set(false);
          if (threw) continue;
          res.crossingsAttempted++;
          const v = scan(out, arena);
          if (v) {
            res.oracleViolations++;
            if (v === "bystander-object" || v === "bystander-secret-string") res.deliveredForeignObject++;
            if (v === "host-global" || v === "host-secret-string") res.deliveredHostGlobalOrSecret++;
            if (res.violationsSample.length < 8) res.violationsSample.push({ kind: OBJECT_KINDS[i], channel: ch, mode, violation: v });
          }
        }
      }
    }
    // The bystander must still work.
    let got; try { got = B.sb.exports.format(new Date(0), "yyyy-MM-dd'T'HH:mm"); } catch { got = "threw"; }
    if (got !== bystanderExpected) res.bystanderBroken++;
  }
  report.configs[config] = res;
  console.log(config, JSON.stringify(res));
}
report.pass = report.configs.real.oracleViolations === 0 && report.configs.real.bystanderBroken === 0 && report.configs.control.deliveredForeignObject > 0;
fs.writeFileSync(new URL("./forge-identity-results.json", import.meta.url), JSON.stringify(report, null, 1));
console.log("PASS", report.pass, "| real violations", report.configs.real.oracleViolations, "| control delivered foreign", report.configs.control.deliveredForeignObject);
process.exit(0);
