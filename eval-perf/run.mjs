// Runs the built pages in headless Chrome.
//
// Method (as in the original evaluation): per (scenario, mode), 2 warm-up and
// 10 measured iterations; each iteration opens a fresh browser context and
// page, waits for the scenario module to be ready, then calls the scenario
// function `reps` times. scenario_ms = total / reps. Scenario order is a
// seeded permutation; the three modes of a scenario run adjacently in a
// rotated order.
//
// Usage: node eval-perf/run.mjs [--iterations 10] [--warmup 2] [--reps 10] [scenarioId ...]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return Number(v); };
const ITER = opt("iterations", 10), WARM = opt("warmup", 2), REPS = opt("reps", 10);
const MODES = ["native", "sandbox", "lavamoat"];
const ids = args.length ? args : JSON.parse(fs.readFileSync(path.join(OUT, "build-report.json"), "utf8"))
  .filter((r) => !r.error).map((r) => r.id).filter((v, i, a) => a.indexOf(v) === i);

function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const r = rng(42);
const order = [...ids].sort(() => r() - 0.5);

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8", "": "text/javascript" };
function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, url === "/" ? "index.html" : url);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] });
const version = browser.version();
const rows = [];
const resultsFile = path.join(here, process.env.RESULTS_FILE ?? "results-raw.json");

async function iteration(port, id, mode, i, warmup) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.addInitScript(() => { globalThis.__SANDBOX_TIMINGS__ = []; });
  const t0 = Date.now();
  await page.goto(`http://127.0.0.1:${port}/`);
  try {
    await page.waitForFunction(() => document.title === "ready", null, { timeout: 120000 });
  } catch {
    await context.close();
    return { id, mode, iteration: i, warmup, error: "not ready: " + errors.join(" | ") };
  }
  const cdp = await context.newCDPSession(page);
  const heap = async () => { await page.evaluate(() => globalThis.gc?.()); const m = await cdp.send("Performance.getMetrics").catch(() => null); if (!m) await cdp.send("Performance.enable"); const mm = (await cdp.send("Performance.getMetrics")).metrics; return mm.find((x) => x.name === "JSHeapUsedSize")?.value; };
  await cdp.send("Performance.enable");
  const heapReady = await heap();
  const res = await page.evaluate(async (reps) => {
    const p = document.__PERF__;
    let total = 0, done = 0, err = null;
    for (let k = 0; k < reps; k++) {
      const s = performance.now();
      try { await p.run(); done++; } catch (e) { err = String(e && e.message).slice(0, 200); break; } finally { total += performance.now() - s; }
    }
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      scenarioTotalMs: total, completed: done, error: err,
      importMs: p.importMs, readyAtMs: p.readyAt,
      domContentLoadedMs: nav ? nav.domContentLoadedEventEnd : null,
      sandboxTimings: globalThis.__SANDBOX_TIMINGS__,
      wasmMemoryBytes: (globalThis.__SANDBOX_TIMINGS__ || []).reduce((n, t) => n + t.wasmMemoryBytes, 0),
    };
  }, REPS);
  const heapAfter = await heap();
  await context.close();
  return { id, mode, iteration: i, warmup, ...res, scenarioMs: res.scenarioTotalMs / REPS, jsHeapReadyBytes: heapReady, jsHeapAfterBytes: heapAfter, wallMs: Date.now() - t0, pageErrors: errors };
}

for (const [n, id] of order.entries()) {
  const modes = MODES.map((_, k) => MODES[(k + n) % MODES.length]);
  for (const mode of modes) {
    const dir = path.join(OUT, `${id}--${mode}`);
    if (!fs.existsSync(path.join(dir, "index.html"))) { rows.push({ id, mode, error: "not built" }); continue; }
    const server = await serve(dir);
    const { port } = server.address();
    for (let i = 0; i < WARM + ITER; i++) {
      const row = await iteration(port, id, mode, i, i < WARM);
      rows.push(row);
      if (row.error) { console.log(id, mode, "ERROR", row.error); break; }
    }
    server.close();
    const m = rows.filter((x) => x.id === id && x.mode === mode && !x.warmup && !x.error).map((x) => x.scenarioMs).sort((a, b) => a - b);
    console.log(id, mode, "median scenario ms", m.length ? m[(m.length / 2) | 0].toFixed(3) : "n/a");
    fs.writeFileSync(resultsFile, JSON.stringify({ chrome: version, iterations: ITER, warmup: WARM, reps: REPS, rows }, null, 1));
  }
}
await browser.close();
console.log("done", rows.length);
