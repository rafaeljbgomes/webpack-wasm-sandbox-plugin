// Output-integrity study, attack runs. Loads each built variant of Markdown
// Live Preview in headless Chrome (fresh context per run) and records, for
// the compromised Marked's payload corpus (payloads.cjs):
//  - script payloads that ran (window.__PWN__ calls, incl. from iframes);
//  - exfiltration requests to http://exfil.invalid (intercepted, never sent);
//  - whether the app still works (preview heading present, Mermaid diagram
//    rendered, editor present) and the page errors, incl. Trusted Types
//    violations.
// "click" payloads are clicked; "focus" payloads rely on autofocus.
// Usage: node output-integrity/attack.mjs [variant ...]   (RUNS=3)
import http from "node:http"; import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const corpus = require("./payloads.cjs");
const OUT = path.join(here, "..", "out");
const RUNS = Number(process.env.RUNS ?? 3);
const variants = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(OUT).filter((d) => d.startsWith("e-") || d.startsWith("b-")).sort();
const T = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".webp": "image/webp", "": "text/javascript" };
function serve(dir) {
  const srv = http.createServer((q, s) => { const u = decodeURIComponent(new URL(q.url, "http://x").pathname); const f = path.join(dir, u === "/" ? "index.html" : u); if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); return s.end(); } s.writeHead(200, { "Content-Type": T[path.extname(f)] ?? "application/octet-stream", "Cache-Control": "no-store" }); s.end(fs.readFileSync(f)); });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const results = { chrome: browser.version(), runs: RUNS, corpus: corpus.map(({ id, kind, needs }) => ({ id, kind, needs })), variants: {} };
for (const v of variants) {
  const srv = await serve(path.join(OUT, v));
  const runs = [];
  for (let r = 0; r < RUNS; r++) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const exfil = new Set();
    await ctx.route("http://exfil.invalid/**", (route) => { exfil.add(new URL(route.request().url()).pathname.slice(1)); route.fulfill({ status: 204 }); });
    const page = await ctx.newPage();
    const errors = []; const ttViolations = [];
    page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
    page.on("console", (m) => { if (m.type() === "error" && /Trusted ?Type|TrustedHTML|require-trusted-types/i.test(m.text())) ttViolations.push((m.text() + " @ " + (m.location()?.url ?? "").split("/").pop() + ":" + m.location()?.lineNumber).slice(0, 300)); });
    await page.addInitScript(() => {
      localStorage.clear();
      window.__PWNED__ = [];
      window.__PWN__ = (id) => { window.__PWNED__.push(id); };
    });
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    let ready = true;
    // Polls with evaluate(): waitForFunction evaluates a string, which a page
    // that enforces Trusted Types blocks.
    ready = false;
    for (let t = 0; t < 300 && !ready; t++) {
      ready = await page.evaluate(() => !!(document.querySelector("#output h1") && document.querySelector(".monaco-editor")));
      if (!ready) await page.waitForTimeout(100);
    }
    await page.waitForTimeout(2000);
    for (const el of await page.$$("#output .pwn-click")) { try { await el.click({ force: true, timeout: 1000 }); } catch {} await page.waitForTimeout(100); }
    await page.waitForTimeout(1500);
    const state = await page.evaluate(() => ({
      pwned: [...new Set(window.__PWNED__)],
      mermaidSvg: document.querySelectorAll("#output .mermaid svg").length,
      mermaidError: document.querySelectorAll("#output .mermaid-error").length,
      outputChars: document.querySelector("#output")?.innerHTML.length ?? 0,
    }));
    runs.push({ ready, ...state, exfil: [...exfil].sort(), errors: [...new Set(errors)], ttViolations: [...new Set(ttViolations)] });
    await ctx.close();
  }
  srv.close();
  const union = (k) => [...new Set(runs.flatMap((x) => x[k]))].sort();
  const consistent = runs.every((x) => JSON.stringify(x.pwned.sort()) === JSON.stringify(runs[0].pwned.sort()) && JSON.stringify(x.exfil) === JSON.stringify(runs[0].exfil));
  results.variants[v] = { ready: runs.every((x) => x.ready), executed: union("pwned"), exfiltrated: union("exfil"), mermaidSvg: runs.map((x) => x.mermaidSvg), mermaidError: runs.map((x) => x.mermaidError), ttViolations: [...new Set(runs.flatMap((x) => x.ttViolations))], errors: union("errors"), consistent };
  const s = results.variants[v];
  console.log(`${v.padEnd(28)} ready=${s.ready} exec=${s.executed.length} [${s.executed.join(",")}] exfil=${s.exfiltrated.length} [${s.exfiltrated.join(",")}] mermaid=${s.mermaidSvg} tt=${s.ttViolations.length} consistent=${s.consistent} errors=${s.errors.length}`);
}
await browser.close();
fs.writeFileSync(path.join(here, process.env.RESULTS ?? "attack-results.json"), JSON.stringify(results, null, 1));
