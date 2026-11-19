// Marked spec conformance (CommonMark, GFM, new, original, redos) in native
// and sandbox modes. The sandbox side uses the same runtime as the generated
// proxy, plus a 10 s call deadline so that a hanging case is reported.
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs compatibility-harness/marked-specs.mjs
import fs from "node:fs";
import path from "node:path";
import { getTests, htmlIsEqual } from "../test-harness/marked/node_modules/@markedjs/testutils/lib/index.js";
import { Marked } from "../test-harness/marked/lib/marked.esm.js";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";

const specDir = path.resolve("test-harness/marked/test/specs");
const sets = ["commonmark", "gfm", "new", "original", "redos"];
const tests = await getTests(sets.map((s) => path.join(specDir, s)));
const defaults = { commonmark: { gfm: false, pedantic: false }, gfm: { gfm: true, pedantic: false }, new: {}, original: { gfm: false, pedantic: true }, redos: {} };
const sb = await SandboxManager.createSandbox("marked", fs.readFileSync("dist/marked.bundle.js", "utf8"), { permissions: [], limits: { callTimeMs: 10000 } });
const flat = (t) => Array.isArray(t) ? t : Object.values(t).flatMap((x) => (Array.isArray(x) ? x : x.specs ?? []));
const res = {};
for (const [i, set] of sets.entries()) {
  const specs = flat(tests[i]);
  const r = (res[set] = { total: 0, shouldPass: 0, native: 0, sandbox: 0, bothPass: 0, sandboxOnlyFail: [], interrupted: 0 });
  for (const spec of specs) {
    if (spec.shouldFail) continue; // cases upstream marks as known failures
    r.total++;
    const opts = { ...defaults[set], ...(spec.options ?? {}) };
    let nOk = false, sOk = false;
    try { nOk = await htmlIsEqual(new Marked(opts).parse(spec.markdown), spec.html); } catch {}
    try {
      const inst = sb.createInstance("Marked", [opts]);
      sOk = await htmlIsEqual(inst.parse(spec.markdown), spec.html);
    } catch (e) { if (/interrupted/.test(String(e?.message))) r.interrupted++; }
    if (nOk) r.native++; if (sOk) r.sandbox++; if (nOk && sOk) r.bothPass++;
    if (nOk && !sOk) r.sandboxOnlyFail.push(String(spec.section ?? "") + " #" + String(spec.example ?? ""));
  }
  console.log(set, JSON.stringify({ ...r, sandboxOnlyFail: r.sandboxOnlyFail.slice(0, 8) }));
}
fs.writeFileSync("compatibility-results/marked-specs/results.json", JSON.stringify(res, null, 1));
process.exit(0);
