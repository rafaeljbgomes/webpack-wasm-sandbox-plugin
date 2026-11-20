// Steady-state run: the same built pages as run.mjs, but each iteration warms
// the workload up with W calls and then times M consecutive calls in one page,
// so that V8's JIT (native, LavaMoat) and the Wasm tiers that run QuickJS
// (sandbox) have reached their steady state.
//
// W = 100 warm-up calls, then M = 1,000 measured calls; three iterations per
// (workload, mode), each in a fresh browser context.
//
// Usage: node eval-perf/run-steady.mjs [workloadId ...]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "out");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ITER = 3;
const MODES = ["native", "sandbox", "lavamoat"];
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["lodash", "zod", "tweetnacl", "lodash-adapter", "zod-adapter"];

const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8", "": "text/javascript" };
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const rows = [];
const outFile = path.join(here, "results-steady.json");
for (const id of ids) {
  const M = 1000;
  const W = 100;
  for (const mode of MODES) {
    const dir = path.join(OUT, `${id}--${mode}`);
    const server = await serve(dir);
    const { port } = server.address();
    for (let i = 0; i < ITER; i++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForFunction(() => document.title === "ready", null, { timeout: 120000 });
      const r = await page.evaluate(async ({ W, M }) => {
        const p = document.__PERF__;
        const firstStart = performance.now();
        await p.run();
        const first = performance.now() - firstStart;
        for (let k = 1; k < W; k++) await p.run();
        const s = performance.now();
        for (let k = 0; k < M; k++) await p.run();
        return { firstCallMs: first, steadyMs: (performance.now() - s) / M };
      }, { W, M });
      rows.push({ id, mode, iteration: i, warmupCalls: W, measuredCalls: M, ...r });
      await context.close();
    }
    server.close();
    const v = rows.filter((x) => x.id === id && x.mode === mode).map((x) => x.steadyMs).sort((a, b) => a - b);
    console.log(id, mode, "M", M, "steady median ms", v[(v.length / 2) | 0].toFixed(4));
    fs.writeFileSync(outFile, JSON.stringify({ chrome: browser.version(), iterations: ITER, rows }, null, 1));
  }
}
await browser.close();
console.log("done");
