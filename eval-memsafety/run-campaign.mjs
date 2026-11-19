// Corruption campaign: N trials per (victim, bytes) configuration, each in a
// fresh worker with a timeout. Run:
//   node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-memsafety/run-campaign.mjs [trialsPerConfig]
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
const N = Number(process.argv[2] ?? 50);
const TIMEOUT_MS = 15000;
const configs = [];
for (const victim of ["strip-ansi", "lodash", "marked"])
  for (const bytes of [1, 16, 256, 4096, "all"])
    for (let i = 0; i < (bytes === "all" ? Math.max(5, N / 5) : N); i++) configs.push({ victim, bytes, seed: 1000 * configs.length + 7 });

function runOne(cfg) {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./trial-worker.mjs", import.meta.url), {
      workerData: cfg, execArgv: ["--import", "./.sandbox/test/helpers/register-runtime-aliases.mjs"],
    });
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; w.terminate(); resolve({ ...cfg, aWorst: "hang", bOk: null, hostOk: null }); } }, TIMEOUT_MS);
    w.once("message", (m) => { if (!done) { done = true; clearTimeout(t); w.terminate(); resolve(m); } });
    w.once("error", (e) => { if (!done) { done = true; clearTimeout(t); resolve({ ...cfg, aWorst: "worker-error:" + (e?.name ?? e), error: String(e?.message ?? e).slice(0, 200) }); } });
  });
}

const results = [];
const conc = Math.max(2, Math.min(8, os.cpus().length - 2));
let next = 0;
await Promise.all(Array.from({ length: conc }, async () => {
  while (next < configs.length) { const c = configs[next++]; results.push(await runOne(c)); }
}));

const summary = {};
for (const r of results) {
  const k = `${r.victim}|${r.bytes}`;
  const s = (summary[k] ??= { trials: 0, A: {}, bOk: 0, hostOk: 0, bMemUnchanged: 0, callsOutsideA: 0, hostErrorsInA: 0, warmFail: 0 });
  s.trials++;
  s.A[r.aWorst] = (s.A[r.aWorst] ?? 0) + 1;
  if (r.bOk) s.bOk++;
  if (r.hostOk) s.hostOk++;
  if (r.bMemoryUnchanged) s.bMemUnchanged++;
  s.callsOutsideA += r.hostCallsOutsideA ?? 0;
  s.hostErrorsInA += r.hostErrors ?? 0;
  if (r.warmA === false || r.warmB === false) s.warmFail++;
}
const out = { node: process.version, v8: process.versions.v8, trialsPerConfig: N, timeoutMs: TIMEOUT_MS, summary, results };
fs.writeFileSync(new URL("./campaign-results.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ node: out.node, v8: out.v8, summary }, null, 1));
process.exit(0);
