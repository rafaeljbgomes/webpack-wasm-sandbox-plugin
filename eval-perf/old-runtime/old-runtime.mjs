// Old (thesis) runtime on this machine: sandbox mode, metrics on vs off.
import path from "node:path"; import fs from "node:fs"; import http from "node:http"; import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const require = createRequire(import.meta.url);
require("tsx/cjs");
const webpack = require("webpack");
const { createBrowserWebpackConfig } = require("./performance-harness/browser/webpack.browser.config.cjs");
const repoRoot = process.cwd();
const SC = { luxon: "luxon/scheduling", lodash: "lodash/collection", zod: "zod/validation", marked: "marked/parser", "strip-ansi": "strip-ansi/clean", tweetnacl: "tweetnacl/signature", yup: "yup/validation", "date-fns": "date-fns/calendar", "image-js": "image-js/transform", mime: "mime/lookup" };
const MODES = (process.env.MODES ?? "true,false").split(",").map((x) => x === "true");
const ITER = Number(process.env.ITER ?? 5), WARM = 1, REPS = 10;
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const out = {};
for (const [lib, sc] of Object.entries(SC)) for (const metrics of MODES) {
  const tempRoot = path.join(repoRoot, "old-out", `${lib}-${metrics}`);
  const c = createBrowserWebpackConfig({ repoRoot, buildMode: "sandbox", repetitions: REPS, scenarioPath: path.resolve(repoRoot, `performance-harness/browser/scenarios/${sc}.scenario.js`), tempRoot });
  c.entry = path.resolve(repoRoot, "performance-harness/browser/bootstrap-toggle.js");
  c.mode = "production";
  c.plugins.push(new webpack.DefinePlugin({ __METRICS_ON__: JSON.stringify(metrics) }));
  c.resolve.alias.__SANDBOX_PERF_SCENARIO__ = path.resolve(repoRoot, `performance-harness/browser/scenarios/${sc}.scenario.js`);
  const st = await new Promise((ok, ko) => webpack(c, (e, s) => (e ? ko(e) : ok(s))));
  if (st.hasErrors()) { console.log(lib, "build error", st.toString({ all: false, errors: true }).slice(0, 500)); continue; }
  const dist = path.join(tempRoot, "dist");
  fs.writeFileSync(path.join(tempRoot, "index.html"), '<!doctype html><html><body><script src="/dist/browser-scenario.js"></script></body></html>');
  const server = http.createServer((req, res) => { const u = new URL(req.url, "http://x").pathname; const f = path.join(tempRoot, u === "/" ? "index.html" : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": f.endsWith(".wasm") ? "application/wasm" : f.endsWith(".html") ? "text/html" : "text/javascript" }); res.end(fs.readFileSync(f)); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const vals = []; let crossings = null;
  for (let i = 0; i < WARM + ITER; i++) {
    const ctx = await b.newContext(); const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${server.address().port}/`);
    await p.waitForFunction(() => globalThis.__SANDBOX_PERF_RESULT__?.status === "finished", null, { timeout: 600000 });
    const r = await p.evaluate(() => globalThis.__SANDBOX_PERF_RESULT__);
    if (r.error) console.log(lib, metrics, "error", r.error.message);
    if (i >= WARM) { vals.push(r.scenario_ms); crossings = r.phase_metrics?.scenario?.crossings ?? r.crossings; }
    await ctx.close();
  }
  server.close();
  vals.sort((a, c) => a - c);
  out[`${lib}|metrics=${metrics}`] = { median: vals[(vals.length / 2) | 0], vals, crossings };
  console.log(lib, "metrics", metrics, "median ms", vals[(vals.length / 2) | 0].toFixed(2));
  fs.writeFileSync(path.join(repoRoot, process.env.OUTFILE ?? "old-runtime-results.json"), JSON.stringify({ chrome: b.version(), iterations: ITER, reps: REPS, out }, null, 1));
}
await b.close();
