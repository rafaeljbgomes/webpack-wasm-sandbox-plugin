// Measures the case study in headless Chrome, per mode, in ten fresh pages:
//  - readyMs: navigation start until the preview first holds rendered HTML;
//  - typing: 60 characters typed into the editor (50 ms apart) at the end of
//    the default document and of a document ten times as long; each keystroke
//    is an interaction whose latency comes from the Event Timing API
//    (PerformanceEventTiming, durationThreshold 16 ms, plus every keyboard
//    entry's duration); INP is approximated as the 98th percentile of the
//    per-interaction maximum duration;
//  - the preview HTML after loading (compared across modes);
//  - JS heap (CDP) and the sandbox's linear memory.
// Usage: node eval-case-mlp/measure.mjs [mode ...]
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { chromium } from "playwright-core";
const here = path.dirname(fileURLToPath(import.meta.url));
const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["native", "sandbox"];
const ITER = Number(process.env.ITER ?? 10);
// The app's default document, read from its source (APP = the checkout).
const mainSrc = fs.readFileSync(path.join(process.env.APP, "src/main.js"), "utf8");
const DEFAULT_MD = new Function("return " + mainSrc.match(/const defaultInput = (`[\s\S]*?`);/)[1])();
const T = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".webp": "image/webp", "": "text/javascript" };
function serve(dir) {
  const srv = http.createServer((q, s) => { const u = decodeURIComponent(new URL(q.url, "http://x").pathname); const f = path.join(dir, u === "/" ? "index.html" : u); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); } s.writeHead(200, { "Content-Type": T[path.extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" }); s.end(fs.readFileSync(f)); });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const rows = [];
const q = (v, p) => { const s = [...v].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (let i = 0; i < ITER; i++) {
  for (const mode of (i % 2 ? [...modes].reverse() : modes)) {
    const srv = await serve(path.join(here, "out", mode));
    for (const doc of ["default", "x10"]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
      await page.addInitScript((doc) => {
        localStorage.clear();
        window.__EVENTS__ = [];
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__EVENTS__.push({ name: e.name, id: e.interactionId, d: e.duration }); })
          .observe({ type: "event", durationThreshold: 16, buffered: true });
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__EVENTS__.push({ name: e.name, id: e.interactionId, d: e.duration }); })
          .observe({ type: "first-input", buffered: true });
        const mark = () => { if (window.__READY__ === undefined && document.querySelector("#output h1")) window.__READY__ = performance.now(); };
        new MutationObserver(mark).observe(document, { childList: true, subtree: true });
        window.__DOC__ = doc;
        // Per-keystroke processing: keydown until the preview next changes.
        window.__KEYS__ = []; let pending = null;
        addEventListener("keydown", () => { pending = performance.now(); }, true);
        const watch = () => { const o = document.querySelector("#output"); if (!o) return setTimeout(watch, 50);
          new MutationObserver(() => { if (pending !== null) { window.__KEYS__.push(performance.now() - pending); pending = null; } }).observe(o, { childList: true, subtree: true }); };
        addEventListener("DOMContentLoaded", watch);
      }, doc);
      await page.goto(`http://127.0.0.1:${srv.address().port}/`);
      await page.waitForFunction(() => window.__READY__ !== undefined && document.querySelector(".monaco-editor"), null, { timeout: 60000 });
      const readyMs = await page.evaluate(() => window.__READY__);
      await page.waitForTimeout(500);
      const html = await page.evaluate(() => document.querySelector("#output").innerHTML.replace(/id="mermaid-[^"]*"/g, "").replace(/mermaid-\d+/g, "m"));
      await page.click(".monaco-editor .view-lines");
      await page.keyboard.press("Meta+End");
      if (doc === "x10") {
        for (let k = 0; k < 9; k++) await page.keyboard.insertText("\n" + DEFAULT_MD);
        await page.waitForTimeout(1500);
      }
      await page.evaluate(() => { window.__EVENTS__.length = 0; window.__KEYS__.length = 0; });
      const t0 = Date.now();
      await page.keyboard.type(" the quick brown fox jumps over the lazy dog, again and again", { delay: 50 });
      await page.waitForTimeout(1000);
      const ev = await page.evaluate(() => window.__EVENTS__);
      const keys = await page.evaluate(() => window.__KEYS__);
      const byId = new Map();
      for (const e of ev) if (e.id) byId.set(e.id, Math.max(byId.get(e.id) ?? 0, e.d));
      const inter = [...byId.values()];
      const cdp = await ctx.newCDPSession(page); await cdp.send("Performance.enable");
      const heap = (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
      const wasm = await page.evaluate(() => (globalThis.__SANDBOX_TIMINGS__ || []).reduce((n, t) => n + (t.wasmMemoryBytes || 0), 0));
      rows.push({ mode, doc, iteration: i, readyMs, keyUpdates: keys.length, keyMedian: keys.length ? q(keys, 0.5) : null, keyP95: keys.length ? q(keys, 0.95) : null, keyMax: keys.length ? Math.max(...keys) : null, interactions: inter.length, inp98: inter.length ? q(inter, 0.98) : null, median: inter.length ? q(inter, 0.5) : null, max: inter.length ? Math.max(...inter) : null,
        typingWallMs: Date.now() - t0, heapMB: heap / 1e6, wasmMB: wasm / 1e6, htmlHash: crypto.createHash("sha256").update(html).digest("hex").slice(0, 16), errors });
      console.log(mode, doc, i, readyMs.toFixed(0), "ms ready; key median", rows.at(-1).keyMedian?.toFixed(2), "p95", rows.at(-1).keyP95?.toFixed(2), "updates", keys.length, ";", inter.length, "interactions; p98", rows.at(-1).inp98, "median", rows.at(-1).median, "heap", (heap / 1e6).toFixed(1), "wasm", (wasm / 1e6).toFixed(1), rows.at(-1).htmlHash, errors.join("|"));
      await ctx.close();
    }
    srv.close();
  }
}
fs.writeFileSync(path.join(here, "results.json"), JSON.stringify({ chrome: browser.version(), iterations: ITER, rows }, null, 1));
await browser.close();
