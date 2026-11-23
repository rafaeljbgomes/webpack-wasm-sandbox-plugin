// Loads a built mode of the case study and reports whether the preview rendered.
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] ?? "native"; const dir = path.join(here, "out", mode);
const T = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".webp": "image/webp", "": "text/javascript" };
const srv = http.createServer((q, s) => { const u = decodeURIComponent(new URL(q.url, "http://x").pathname); const f = path.join(dir, u === "/" ? "index.html" : u); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); } s.writeHead(200, { "Content-Type": T[path.extname(f)] ?? "application/octet-stream" }); s.end(fs.readFileSync(f)); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const p = await b.newPage(); const errs = []; const ext = [];
p.on("pageerror", (e) => errs.push(e.message.slice(0, 300))); p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 300)); });
p.on("request", (r) => { if (!r.url().startsWith("http://127.0.0.1")) ext.push(r.url()); });
await p.goto(`http://127.0.0.1:${srv.address().port}/`);
await p.waitForTimeout(4000);
const out = await p.evaluate(() => ({ h1: document.querySelector("#output h1")?.textContent, tables: document.querySelectorAll("#output table").length, mermaid: document.querySelectorAll("#output svg").length, codeBlocks: document.querySelectorAll("#output pre code").length, editor: !!document.querySelector(".monaco-editor") }));
console.log(mode, JSON.stringify(out), "errors:", errs.slice(0, 5), "external:", ext.slice(0, 3));
await b.close(); srv.close();
