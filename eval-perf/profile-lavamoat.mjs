// CPU profile of a workload under LavaMoat and natively, to explain where the
// extra time goes (used for TweetNaCl's 7.8x). Records 20 calls after 5
// warm-up calls with the Chrome DevTools Protocol profiler and aggregates
// self time by function.
//
// Usage: node eval-perf/profile-lavamoat.mjs [workloadId]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2] ?? "tweetnacl";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html; charset=utf-8", "": "text/javascript" };
function serve(dir) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x").pathname;
    const file = path.join(dir, url === "/" ? "index.html" : url);
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const report = {};
for (const mode of ["native", "lavamoat"]) {
  const server = await serve(path.join(here, "out", `${id}--${mode}`));
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => document.title === "ready");
  await page.evaluate(async () => { for (let i = 0; i < 5; i++) await document.__PERF__.run(); });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
  await cdp.send("Profiler.start");
  const ms = await page.evaluate(async () => { const s = performance.now(); for (let i = 0; i < 20; i++) await document.__PERF__.run(); return (performance.now() - s) / 20; });
  const { profile } = await cdp.send("Profiler.stop");
  const byNode = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byNode.get(profile.samples[i]);
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} @ ${path.basename(f.url || "") || f.url}:${f.lineNumber}:${f.columnNumber}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  }
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => ({ fn: k, selfMs: +v.toFixed(1), share: +(v / total).toFixed(3) }));
  report[mode] = { msPerCall: ms, totalSampledMs: +total.toFixed(1), top };
  console.log(mode, ms.toFixed(2), "ms/call");
  for (const t of top.slice(0, 15)) console.log("  ", t.share, t.selfMs, t.fn);
  await context.close();
  server.close();
}
fs.writeFileSync(path.join(here, `profile-${id}.json`), JSON.stringify(report, null, 1));
await browser.close();
