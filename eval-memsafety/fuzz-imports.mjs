// Import-level attack: a compromised Wasm instance can call any of its own
// imports with arbitrary integer arguments. We do exactly that from the host
// and record which host functions are reached and which host-visible effects
// occur. Two configurations:
//   per-library  each library has its own module instance (createSandbox, the
//                path used by the generated proxies);
//   shared       both libraries share one module instance (createSandboxSync).
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-memsafety/fuzz-imports.mjs
import fs from "node:fs";
import { sandbox, hostCalls, hostErrors, registered, callFunctionImport, countImports, mulberry32, classifyError, findMarker } from "./lib.mjs";

const rnd = mulberry32(20261119);
const INT32_MIN = -2147483648;
const rint = () => (rnd() * 2 ** 32) >>> 0;

// Host-visible effects of Emscripten imports.
const effects = { console: 0, timers: 0 };
for (const k of ["log", "error", "warn", "info", "debug"]) {
  const orig = console[k];
  console[k] = (...a) => { effects.console++; if (process.env.VERBOSE) orig(...a); };
}
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...a) => { effects.timers++; const t = origSetTimeout(...a); t.unref?.(); return t; };

async function setup(shared) {
  const A = await sandbox("A", "strip-ansi", [], { shared });
  const B = await sandbox("B", "date-fns", ["Intl"], { shared });
  // Exercise B so that its Intl host functions are registered and live.
  B.sb.exports.format(new Date(Date.UTC(2026, 10, 19)), "PPPP");
  B.sb.exports.formatDistance(new Date(0), new Date(1e9));
  // Host data passed into B only.
  B.sb.exports.format(new Date(Date.UTC(2026, 10, 19)), "'B-SECRET-778'");
  return { A, B };
}

function fuzzCallFunction(A, ctxCandidates, maxFnId) {
  const callFunction = callFunctionImport(A.imports);
  const start = hostCalls.length;
  const outcomes = {};
  let calls = 0;
  for (const ctx of ctxCandidates) {
    for (let k = 0; k <= maxFnId; k++) {
      const fnId = INT32_MIN + k;
      for (const argc of [0, 1, 3]) {
        calls++;
        try {
          callFunction(ctx, 0, argc, argc ? rint() % A.memory.buffer.byteLength : 0, fnId);
          outcomes.returned = (outcomes.returned ?? 0) + 1;
        } catch (e) {
          const c = classifyError(e);
          outcomes[c] = (outcomes[c] ?? 0) + 1;
        }
      }
    }
  }
  const reached = hostCalls.slice(start);
  const owners = {};
  for (const r of reached) owners[r.owner] = (owners[r.owner] ?? 0) + 1;
  const names = [...new Set(reached.map((r) => `${r.owner}:${r.fname}`))];
  return { calls, outcomes, hostFunctionInvocations: reached.length, owners, names };
}

function fuzzAllImports(A, perImport) {
  const res = {};
  const mem0 = A.memory.buffer.byteLength;
  for (const [key, fn] of Object.entries(A.imports.a)) {
    if (typeof fn !== "function") continue;
    const before = { ...effects, host: hostCalls.length };
    const out = {};
    for (let i = 0; i < perImport; i++) {
      const args = [rint(), rint() % mem0, rint() % 64, rint() % mem0, rint() % 4096];
      try { fn(...args); out.returned = (out.returned ?? 0) + 1; }
      catch (e) { const c = e?.name === "ExitStatus" ? "exit" : classifyError(e); out[c] = (out[c] ?? 0) + 1; }
    }
    res[key] = {
      src: String(fn).replace(/\s+/g, " ").slice(0, 60),
      outcomes: out,
      consoleWrites: effects.console - before.console,
      timersScheduled: effects.timers - before.timers,
      hostFunctionInvocations: hostCalls.length - before.host,
    };
  }
  res.memoryGrowthBytes = A.memory.buffer.byteLength - mem0;
  return res;
}

const results = {};
for (const shared of [false, true]) {
  const { A, B } = await setup(shared);
  const label = shared ? "shared" : "perLibrary";
  const sameModule = A.memory === B.memory;
  const ctxCandidates = [A.ctxPtr, B.ctxPtr, ...Array.from({ length: 6 }, () => rint() % A.memory.buffer.byteLength)];
  const r = {
    sameModule,
    imports: countImports(A.imports),
    ctxA: A.ctxPtr, ctxB: B.ctxPtr,
    registeredHostFunctions: Object.fromEntries(registered),
    bSecretInAttackerMemory: findMarker(A.memory, "B-SECRET-778"),
    callFunctionFuzz: fuzzCallFunction(A, ctxCandidates, 300),
  };
  // freeHostRef attack: free host references using B's runtime pointer.
  const freeHostRef = Object.values(A.imports.a).find((f) => typeof f === "function" && /callbacks\.freeHostRef/.test(String(f)));
  const rtB = B.sb.vm.runtime.rt.value;
  let freeOk = 0, freeErr = 0;
  for (let k = 0; k < 300; k++) { try { freeHostRef(rtB, INT32_MIN + k); freeOk++; } catch { freeErr++; } }
  r.freeHostRefAttack = { rtA: A.sb.vm.runtime.rt.value, rtB, freed: freeOk, rejected: freeErr };
  // B still works after the attack?
  try { r.bAfter = B.sb.exports.format(new Date(Date.UTC(2026, 10, 19)), "yyyy-MM-dd") === "2026-11-19"; }
  catch (e) { r.bAfter = "error: " + classifyError(e); }
  results[label] = r;
  registered.clear();
}

// Fuzz every import of a per-library instance with random arguments.
{
  const { A } = await setup(false);
  results.allImports = fuzzAllImports(A, 500);
  results.hostErrors = hostErrors.length;
}

results.node = process.version;
results.v8 = process.versions.v8;
fs.writeFileSync(new URL("./fuzz-results.json", import.meta.url), JSON.stringify(results, null, 1));
process.stdout.write(JSON.stringify(results, null, 1) + "\n");
process.exit(0);
