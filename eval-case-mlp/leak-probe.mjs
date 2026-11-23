// Heap and sandbox state after successive edits, to tell a per-call leak from
// the cost of one large parse. Usage: node eval-case-mlp/leak-probe.mjs <mode>
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const here = path.dirname(fileURLToPath(import.meta.url)); const mode = process.argv[2] ?? "sandbox";
const dir = path.join(here, "out", mode);
const T = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".ttf": "font/ttf", "": "text/javascript" };
const srv = http.createServer((q, s) => { const u = decodeURIComponent(new URL(q.url, "http://x").pathname); const f = path.join(dir, u === "/" ? "index.html" : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); } s.writeHead(200, { "Content-Type": T[path.extname(f)] ?? "application/octet-stream" }); s.end(fs.readFileSync(f)); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--js-flags=--expose-gc"] });
const ctx = await b.newContext(); const p = await ctx.newPage(); const errs = [];
p.on("pageerror", (e) => errs.push(e.message.slice(0, 80)));
await p.goto(`http://127.0.0.1:${srv.address().port}/`);
await p.waitForFunction(() => document.querySelector("#output h1") && document.querySelector(".monaco-editor"));
const cdp = await ctx.newCDPSession(p); await cdp.send("Performance.enable");
const heap = async () => { await p.evaluate(() => globalThis.gc?.()); return ((await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize").value / 1e6).toFixed(1); };
await p.click(".monaco-editor .view-lines"); await p.keyboard.press("Meta+End");
const out = [`start ${await heap()}MB`];
for (let k = 1; k <= 40; k++) { await p.keyboard.type("x"); await p.waitForTimeout(30); if (k % 10 === 0) out.push(`${k} keys ${await heap()}MB`); }
console.log(mode, out.join(" | "), "errors:", errs.length);
await b.close(); srv.close();
