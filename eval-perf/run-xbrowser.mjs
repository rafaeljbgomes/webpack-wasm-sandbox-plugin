// Cross-browser run: the same built pages as run.mjs and run-steady.mjs, in
// Chrome, Firefox (Playwright build), or WebKit (Playwright build, Safari's
// engine).
//
// Phase "cold" (as run.mjs): per (workload, mode), 2 warm-up and 10 measured
// iterations, each in a fresh browser context; time from navigation start
// until ready, and the mean of 10 consecutive calls.
//
// Phase "steady" (as run-steady.mjs, extended): per (workload, mode), 10
// iterations in fresh contexts; W = 100 warm-up calls, then M measured calls,
// each timed individually (for p50/p95/p99). M = 1,000, reduced for slow
// workloads so that the measured calls of one iteration take about 10 s
// (estimated from the last 10 warm-up calls; at least 50).
//
// Pages are served with COOP/COEP so that performance.now() has its finest
// resolution in every browser (cross-origin isolated).
//
// Usage: node eval-perf/run-xbrowser.mjs <chrome|firefox|webkit> <cold|steady> [workloadId ...]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out");
const [which, phase, ...rest] = process.argv.slice(2);
const DEFAULT_IDS = ["strip-ansi", "mime", "tweetnacl", "marked", "yup", "luxon", "lodash", "date-fns", "image-js", "zod",
  "lodash-adapter", "zod-adapter", "luxon-adapter", "image-js-adapter"];
const ids = rest.length ? rest : DEFAULT_IDS;
const MODES = ["native", "sandbox", "lavamoat"];
const BUDGET_MS = 10000;

const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8", "": "text/javascript" };
function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, url === "/" ? "index.html" : url);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const launchers = {
  chrome: () => chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }),
  firefox: () => firefox.launch({ headless: true }),
  webkit: () => webkit.launch({ headless: true }),
};
const browser = await launchers[which]();
const version = browser.version();
const outFile = path.join(here, `results-xbrowser-${which}-${phase}${process.env.RESULTS_SUFFIX ?? ""}.json`);
const rows = [];
const save = () => fs.writeFileSync(outFile, JSON.stringify({ browser: which, version, phase, rows }, null, 1));

async function openPage(port) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => document.title === "ready", null, { timeout: 180000 });
  const iso = await page.evaluate(() => globalThis.crossOriginIsolated);
  return { context, page, errors, iso };
}

console.log(which, version, phase);
for (const id of ids) {
  for (const mode of MODES) {
    const dir = path.join(OUT, `${id}--${mode}`);
    if (!fs.existsSync(path.join(dir, "index.html"))) { rows.push({ id, mode, error: "not built" }); continue; }
    const server = await serve(dir);
    const { port } = server.address();
    const n = phase === "cold" ? 12 : 10;
    for (let i = 0; i < n; i++) {
      let ctx;
      try {
        ctx = await openPage(port);
        if (phase === "cold") {
          const r = await ctx.page.evaluate(async () => {
            const p = document.__PERF__;
            const s = performance.now();
            for (let k = 0; k < 10; k++) await p.run();
            return { scenarioMs: (performance.now() - s) / 10, readyAtMs: p.readyAt };
          });
          rows.push({ id, mode, iteration: i, warmup: i < 2, crossOriginIsolated: ctx.iso, ...r });
        } else {
          const r = await ctx.page.evaluate(async ({ W, BUDGET }) => {
            const p = document.__PERF__;
            let s = performance.now();
            await p.run();
            const firstCallMs = performance.now() - s;
            for (let k = 1; k < W - 10; k++) await p.run();
            s = performance.now();
            for (let k = 0; k < 10; k++) await p.run();
            const est = (performance.now() - s) / 10;
            const M = Math.max(50, Math.min(1000, Math.floor(BUDGET / Math.max(est, 1e-3))));
            const times = new Array(M);
            const t0 = performance.now();
            for (let k = 0; k < M; k++) { const a = performance.now(); await p.run(); times[k] = performance.now() - a; }
            const total = performance.now() - t0;
            return { firstCallMs, measuredCalls: M, steadyMs: total / M, times };
          }, { W: 100, BUDGET: BUDGET_MS });
          const t = [...r.times].sort((a, b) => a - b);
          const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
          rows.push({ id, mode, iteration: i, crossOriginIsolated: ctx.iso, firstCallMs: r.firstCallMs, measuredCalls: r.measuredCalls,
            steadyMs: r.steadyMs, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: t[t.length - 1] });
        }
        if (ctx.errors.length) rows[rows.length - 1].pageErrors = ctx.errors;
      } catch (e) {
        rows.push({ id, mode, iteration: i, error: String(e.message).slice(0, 300), pageErrors: ctx?.errors });
        console.log(id, mode, "ERROR", String(e.message).slice(0, 200));
        await ctx?.context.close().catch(() => {});
        break;
      }
      await ctx.context.close();
    }
    server.close();
    const key = phase === "cold" ? "scenarioMs" : "steadyMs";
    const v = rows.filter((x) => x.id === id && x.mode === mode && !x.warmup && !x.error).map((x) => x[key]).sort((a, b) => a - b);
    console.log(id, mode, key, v.length ? v[(v.length / 2) | 0].toFixed(4) : "n/a");
    save();
  }
}
await browser.close();
console.log("done");
