import { chromium } from "playwright-core";
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const report = JSON.parse(fs.readFileSync(path.join(OUT, "build-report.json"), "utf8"));
const results = {};
for (const key of Object.keys(report)) {
  const dir = path.join(OUT, key);
  const server = http.createServer((req, res) => { const u = new URL(req.url, "http://x").pathname; const f = path.join(dir, u === "/" ? "index.html" : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); } res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html" : f.endsWith(".wasm") ? "application/wasm" : "text/javascript" }); res.end(fs.readFileSync(f)); });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const ctx = await b.newContext(); const p = await ctx.newPage(); const errs = [];
  p.on("console", (m) => { if (m.type() === "error" && !/favicon|404/.test(m.text())) errs.push(m.text().slice(0, 300)); });
  p.on("pageerror", (e) => errs.push("pageerror: " + e.message.slice(0, 300)));
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.waitForTimeout(6000);
  const out = await p.evaluate(() => ({ title: document.querySelector("h1")?.textContent, verdict: document.querySelector("#output h2")?.textContent ?? null, text: document.querySelector("#output")?.innerText?.slice(0, 1500), rows: [...document.querySelectorAll("#output tr")].slice(1).map((tr) => [...tr.children].map((td) => td.textContent)) }));
  results[key] = { ...out, errors: errs.slice(0, 6) };
  console.log(key, out.verdict, JSON.stringify(out.rows), out.verdict ? "" : (out.text || "") + " ERR " + errs.join(" | ").slice(0, 600));
  await ctx.close(); server.close();
}
fs.writeFileSync(path.join(OUT, "browser-results.json"), JSON.stringify(results, null, 1));
await b.close();
