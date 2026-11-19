// One corruption trial, run in its own worker so a hang can be detected and
// a trap cannot leak state into the next trial.
//
// Setup: victim library A (the one with the "bug") and bystander library B
// each run in their own Wasm module instance; the host holds canary data.
// Attack: overwrite `bytes` bytes of A's linear memory with random values
// (offsets drawn from non-zero bytes, i.e. likely live data), or the whole
// memory when bytes === "all". Then call A, call B, and check the host.
import { parentPort, workerData } from "node:worker_threads";
import crypto from "node:crypto";
import { sandbox, hostCalls, hostErrors, mulberry32, classifyError } from "./lib.mjs";

const { seed, bytes, victim } = workerData;
const rnd = mulberry32(seed);

const VICTIMS = {
  "strip-ansi": {
    permissions: [],
    call: (e) => (e.default ?? e)("\u001b[31mhello\u001b[0m"),
    expect: (r) => r === "hello",
  },
  lodash: {
    permissions: [],
    call: (e) => JSON.stringify((e.default ?? e).groupBy([1.1, 2.3, 2.4], Math.floor)),
    expect: (r) => r === '{"1":[1.1],"2":[2.3,2.4]}',
  },
  marked: {
    permissions: [],
    call: (e) => (e.marked ?? e).parse("# t"),
    expect: (r) => typeof r === "string" && r.trim() === "<h1>t</h1>",
  },
};
const v = VICTIMS[victim];

// Host canaries: data and intrinsics the attacker would want to read or change.
const hostSecret = { token: "HOST-SECRET-" + seed };
const hostBytes = new Uint8Array(64).fill(0x5a);
const intrinsics = [Array.prototype.push, Object.prototype.toString, Function.prototype.call, JSON.parse];
const globalsBefore = Object.getOwnPropertyNames(globalThis).length;

const A = await sandbox("A", victim, v.permissions);
const B = await sandbox("B", "date-fns", ["Intl"]);
const callB = () => B.sb.exports.format(new Date(Date.UTC(2026, 10, 19)), "yyyy-MM-dd");

// Warm both, so A's heap holds live objects.
const warmA = v.expect(v.call(A.sb.exports));
const warmB = callB() === "2026-11-19";
const callsBefore = hostCalls.length;

const hashB0 = crypto.createHash("sha256").update(new Uint8Array(B.memory.buffer)).digest("hex");

// --- corrupt A's linear memory ---------------------------------------------
const mem = new Uint8Array(A.memory.buffer);
let written = 0;
if (bytes === "all") {
  for (let i = 0; i < mem.length; i++) mem[i] = (rnd() * 256) | 0;
  written = mem.length;
} else {
  const live = [];
  for (let i = 0; i < mem.length; i += 1) if (mem[i] !== 0) live.push(i);
  for (let n = 0; n < bytes; n++) {
    const off = live[(rnd() * live.length) | 0];
    mem[off] = (rnd() * 256) | 0;
  }
  written = bytes;
}

const hashB1 = crypto.createHash("sha256").update(new Uint8Array(B.memory.buffer)).digest("hex");

// --- call A after corruption -------------------------------------------------
const aOutcomes = [];
for (let i = 0; i < 3; i++) {
  try {
    const r = v.call(A.sb.exports);
    aOutcomes.push(v.expect(r) ? "correct" : "wrong-result");
  } catch (e) {
    aOutcomes.push(classifyError(e));
  }
}

const duringA = hostCalls.slice(callsBefore);

// --- bystander library and host after A's corruption --------------------------
let bOk;
try { bOk = callB() === "2026-11-19"; } catch { bOk = false; }
const hostOk =
  hostSecret.token === "HOST-SECRET-" + seed &&
  hostBytes.every((x) => x === 0x5a) &&
  intrinsics[0] === Array.prototype.push &&
  intrinsics[1] === Object.prototype.toString &&
  intrinsics[2] === Function.prototype.call &&
  intrinsics[3] === JSON.parse &&
  Object.getOwnPropertyNames(globalThis).length === globalsBefore;

parentPort.postMessage({
  seed, bytes, victim, written, warmA, warmB,
  aOutcomes,
  aWorst: aOutcomes.includes("wasm-trap") ? "wasm-trap" : aOutcomes.includes("js-exception") ? "js-exception"
    : aOutcomes.includes("stack-overflow") ? "stack-overflow" : aOutcomes.includes("wrong-result") ? "wrong-result" : "correct",
  bMemoryUnchanged: hashB0 === hashB1,
  bOk, hostOk,
  hostCallsFromA: duringA.filter((c) => c.owner === "A").length,
  hostCallsOutsideA: duringA.filter((c) => c.owner !== "A").length,
  hostErrors: hostErrors.filter((e) => e.owner === "A").length,
});
