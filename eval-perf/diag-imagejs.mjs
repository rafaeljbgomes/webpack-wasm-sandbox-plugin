// Why the sandboxed ImageJS page does not become ready in Firefox and WebKit.
import fs from "node:fs"; import http from "node:http"; import path from "node:path";
import { firefox, webkit, chromium } from "playwright-core";
const dir = path.resolve("eval-perf/out/image-js--sandbox");
const T = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html", "": "text/javascript" };
const coi = process.env.COI !== "0";
const srv = http.createServer((q, s) => { const f = path.join(dir, new URL(q.url, "http://x").pathname === "/" ? "index.html" : new URL(q.url, "http://x").pathname);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { "Content-Type": T[path.extname(f)] ?? "application/octet-stream", ...(coi ? { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } : {}) }); s.end(fs.readFileSync(f)); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
for (const [n, l] of [["firefox", firefox], ["webkit", webkit], ["chrome", chromium]]) {
  const b = await l.launch(n === "chrome" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {});
  const p = await b.newPage(); const log = [];
  p.on("pageerror", (e) => log.push("pageerror: " + String(e.message).slice(0, 300)));
  p.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") log.push(m.type() + ": " + m.text().slice(0, 300)); });
  await p.goto(`http://127.0.0.1:${srv.address().port}/`);
  let ready = false; try { await p.waitForFunction(() => document.title === "ready", null, { timeout: 30000 }); ready = true; } catch {}
  console.log(n, "coi=" + coi, "ready=" + ready, "title=" + (await p.title()), "\n   " + log.slice(0, 6).join("\n   "));
  await b.close();
}
srv.close();
