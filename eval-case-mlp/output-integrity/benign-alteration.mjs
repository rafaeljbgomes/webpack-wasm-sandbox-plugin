// How often does the html output contract change what genuine Marked
// returns? Runs every CommonMark 0.31.2 example (spec.json, sha256
// d431b29d...) through marked 15.0.7 (the app's version, default options) in
// Chrome, and compares the DOM serialization of marked's HTML with that of
// DOMPurify.sanitize (the app's dompurify, default config) of the same HTML.
// A difference is classified by what the sanitizer removed.
// Usage: APP=<checkout> node output-integrity/benign-alteration.mjs
import fs from "node:fs"; import path from "node:path"; import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(process.env.APP);
// Must be the genuine package (build-variants.cjs swaps in a symlink while building).
if (fs.lstatSync(path.join(APP, "node_modules/marked")).isSymbolicLink()) throw new Error("node_modules/marked is the compromised copy; wait for build-variants.cjs");
const spec = JSON.parse(fs.readFileSync(path.join(here, "commonmark-0.31.2-spec.json"), "utf8"));
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><title>x</title>");
await page.addScriptTag({ path: path.join(APP, "node_modules/marked/lib/marked.umd.js") });
await page.addScriptTag({ path: path.join(APP, "node_modules/dompurify/dist/purify.min.js") });
const versions = await page.evaluate(() => ({ dompurify: DOMPurify.version }));
const rows = await page.evaluate((examples) => {
  const norm = (h) => { const t = document.createElement("template"); t.innerHTML = h; return t.innerHTML; };
  return examples.map((e) => {
    const raw = marked.parse(e.markdown);
    const clean = DOMPurify.sanitize(raw);
    const removed = DOMPurify.removed.map((r) => r.element ? `el:${r.element.nodeName.toLowerCase()}` : `attr:${r.attribute?.name}`);
    return { example: e.example, section: e.section, same: norm(raw) === norm(clean), removed: [...new Set(removed)] };
  });
}, spec);
await browser.close();
const differ = rows.filter((r) => !r.same);
const bySection = {}; for (const r of differ) bySection[r.section] = (bySection[r.section] ?? 0) + 1;
const byRemoved = {}; for (const r of differ) for (const k of r.removed.length ? r.removed : ["(serialization only)"]) byRemoved[k] = (byRemoved[k] ?? 0) + 1;
const summary = { marked: JSON.parse(fs.readFileSync(path.join(APP, "node_modules/marked/package.json"))).version, ...versions, examples: rows.length, unchanged: rows.length - differ.length, changed: differ.length, bySection, byRemoved, changedExamples: differ };
fs.writeFileSync(path.join(here, "benign-alteration.json"), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, changedExamples: differ.map((d) => d.example).join(" ") }, null, 1));
