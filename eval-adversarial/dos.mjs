// Denial of service by a compromised library, each case in a worker.
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-adversarial/dos.mjs
import { Worker } from "node:worker_threads";
import fs from "node:fs";
const TIMEOUT = 30000;
const LIMITS = { callTimeMs: 500, memoryBytes: 256 * 2 ** 20 };
const run = (attack, limits) => new Promise((resolve) => {
  const w = new Worker(new URL("./dos-worker.mjs", import.meta.url), { workerData: { attack, limits }, execArgv: ["--import", "./.sandbox/test/helpers/register-runtime-aliases.mjs"], resourceLimits: { maxOldGenerationSizeMb: 4096 } });
  const t0 = Date.now();
  const timer = setTimeout(() => { w.terminate(); resolve({ attack, limits, outcome: `no return within ${TIMEOUT / 1000} s (thread blocked)`, elapsedMs: Date.now() - t0 }); }, TIMEOUT);
  w.once("message", (m) => { clearTimeout(timer); w.terminate(); resolve(m); });
  w.once("error", (e) => { clearTimeout(timer); resolve({ attack, limits, outcome: "worker died: " + e?.name + " " + String(e?.message).slice(0, 80), elapsedMs: Date.now() - t0 }); });
});
const out = [];
for (const attack of ["spin", "catchSpin", "alloc", "string", "recurse"])
  for (const limits of [null, LIMITS]) { const r = await run(attack, limits); console.log(JSON.stringify(r)); out.push(r); }
fs.writeFileSync(new URL("./dos-results.json", import.meta.url), JSON.stringify({ node: process.version, limits: LIMITS, results: out }, null, 1));
process.exit(0);
