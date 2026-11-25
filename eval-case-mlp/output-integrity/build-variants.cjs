// Builds the variants of the output-integrity study (Section 4.9 case study).
// Compromised builds swap the app's node_modules/marked for the compromised
// copy (make-evil-marked.cjs) for the duration of the build only.
// Usage: APP=<checkout> node output-integrity/build-variants.cjs [variant ...]
const fs = require("fs"); const path = require("path");
const { build } = require("../build.cjs");
const APP = path.resolve(process.env.APP);
const html = { type: "html", sanitizer: "dompurify" };
const htmlTT = { type: "html", sanitizer: "dompurify", trustedTypes: "sandbox-marked" };
const TT = "require-trusted-types-for 'script'";
const NOEXFIL = "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'";
const contract = (c) => ({ "marked.parse": c });
const VARIANTS = {
  // compromised Marked
  "e-native-shipped": ["native", { evil: true }],
  "e-native-forget": ["native", { evil: true, forget: true }],
  "e-sb-shipped": ["sandbox", { evil: true }],
  "e-sb-forget": ["sandbox", { evil: true, forget: true }],
  "e-sb-forget-contract": ["sandbox", { evil: true, forget: true, outputs: contract(html) }],
  "e-sb-forget-contract-csp": ["sandbox", { evil: true, forget: true, outputs: contract(html), csp: NOEXFIL }],
  "e-sb-forget-contract-tt": ["sandbox", { evil: true, forget: true, outputs: contract(htmlTT), csp: TT }],
  "e-sb-bypass-contract": ["sandbox", { evil: true, forget: true, bypass: true, outputs: contract(html) }],
  "e-sb-bypass-contract-tt": ["sandbox", { evil: true, forget: true, bypass: true, outputs: contract(htmlTT), csp: TT }],
  // genuine Marked
  "b-native-shipped": ["native", {}],
  "b-sb-shipped": ["sandbox", {}],
  "b-sb-forget-contract": ["sandbox", { forget: true, outputs: contract(html) }],
  "b-sb-shipped-contract": ["sandbox", { outputs: contract(html) }],
  "b-sb-forget-contract-tt": ["sandbox", { forget: true, outputs: contract(htmlTT), csp: TT }],
};
const markedDir = path.join(APP, "node_modules", "marked");
const evilDir = path.join(__dirname, "evil-marked");
async function withMarked(evil, fn) {
  if (!evil) return fn();
  const aside = markedDir + ".genuine";
  fs.renameSync(markedDir, aside);
  fs.symlinkSync(evilDir, markedDir, "dir");
  try { return await fn(); } finally { fs.unlinkSync(markedDir); fs.renameSync(aside, markedDir); }
}
module.exports = { VARIANTS };
// Each variant builds in its own process: Node caches require.resolve, which
// the plugin uses to find the library, so a later build in the same process
// would keep resolving marked to the compromised copy.
function payloadPresent(name) {
  const dist = path.join(__dirname, "..", "out", name, "dist");
  return fs.readdirSync(dist).some((f) => f.endsWith(".js") && fs.readFileSync(path.join(dist, f), "utf8").includes("exfil.invalid"));
}
if (require.main === module) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VARIANTS);
  if (process.env.VARIANT_CHILD) {
    (async () => {
      const name = names[0]; const [mode, opts] = VARIANTS[name];
      const r = await withMarked(opts.evil, () => build(mode, { ...opts, outName: name }));
      console.log(JSON.stringify({ name, ...r }));
    })().catch((e) => { console.log(name, "FAILED", String(e.message ?? e).slice(0, 2000)); process.exit(1); });
  } else {
    const { spawnSync } = require("child_process");
    for (const name of names) {
      const r = spawnSync(process.execPath, [__filename, name], { env: { ...process.env, VARIANT_CHILD: "1" }, encoding: "utf8" });
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("{") || l.includes("FAILED"));
      console.log(line ?? `${name} FAILED (no output) ${r.stderr?.slice(0, 500)}`);
      if (r.status !== 0) { process.exitCode = 1; continue; }
      // The payload must be in exactly the compromised builds.
      if (payloadPresent(name) !== !!VARIANTS[name][1].evil) { console.log(name, "FAILED payload check"); process.exitCode = 1; }
    }
  }
}
