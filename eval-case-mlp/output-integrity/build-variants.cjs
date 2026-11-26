// Builds the variants of the output-integrity study (Section 4.9 case study).
// Compromised builds swap the app's node_modules/marked for the compromised
// copy (make-evil-marked.cjs) for the duration of the build only.
// Checker-integrity study (tamper.mjs): t-* variants use a compromised Marked
// that also tampers with its realm (make-evil-marked.cjs, TAMPER=...);
// `tamper: true` selects evil-marked-tamper (both vectors), "blind"/"sink" one
// vector. LavaMoat variants: pol-clean / pol-regen generate policies (from the
// genuine / the compromised release) into lavamoat-policies/, pol-reviewed
// derives regen-reviewed from regen, and t-lavamoat-* build the compromised
// release under one of them.
// Usage: APP=<checkout> node output-integrity/build-variants.cjs [variant ...]
const fs = require("fs"); const path = require("path");
const { build } = require("../build.cjs");
const APP = path.resolve(process.env.APP);
const html = { type: "html", sanitizer: "dompurify" };
const htmlTT = { type: "html", sanitizer: "dompurify", trustedTypes: "sandbox-marked" };
const TT = "require-trusted-types-for 'script'";
const NOEXFIL = "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'";
const contract = (c) => ({ "marked.parse": c });
const LP = path.join(__dirname, "lavamoat-policies");
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
  // compromised Marked that also tampers with the realm (checker integrity)
  "t-native-shipped": ["native", { evil: true, tamper: true }],
  "t-native-shipped-blind": ["native", { evil: true, tamper: "blind" }],
  "t-native-shipped-sink": ["native", { evil: true, tamper: "sink" }],
  "t-sb-shipped": ["sandbox", { evil: true, tamper: true }],
  "t-sb-forget-contract": ["sandbox", { evil: true, tamper: true, forget: true, outputs: contract(html) }],
  "t-sb-forget-contract-csp": ["sandbox", { evil: true, tamper: true, forget: true, outputs: contract(html), csp: NOEXFIL }],
  "t-sb-forget-contract-tt": ["sandbox", { evil: true, tamper: true, forget: true, outputs: contract(htmlTT), csp: TT }],
  "t-lavamoat-clean": ["lavamoat", { evil: true, tamper: true, policy: path.join(LP, "clean") }],
  "t-lavamoat-regen": ["lavamoat", { evil: true, tamper: true, policy: path.join(LP, "regen") }],
  "t-lavamoat-regen-reviewed": ["lavamoat", { evil: true, tamper: true, policy: path.join(LP, "regen-reviewed") }],
  // LavaMoat policies (no bundle)
  "pol-clean": ["lavamoat", { policy: "generate-only", policyDir: path.join(LP, "clean") }],
  "pol-regen": ["lavamoat", { evil: true, tamper: true, policy: "generate-only", policyDir: path.join(LP, "regen") }],
  "pol-reviewed": ["review", {}],
  // genuine Marked
  "b-lavamoat": ["lavamoat", { policy: path.join(LP, "clean") }],
  "b-native-shipped": ["native", {}],
  "b-sb-shipped": ["sandbox", {}],
  "b-sb-forget-contract": ["sandbox", { forget: true, outputs: contract(html) }],
  "b-sb-shipped-contract": ["sandbox", { outputs: contract(html) }],
  "b-sb-forget-contract-tt": ["sandbox", { forget: true, outputs: contract(htmlTT), csp: TT }],
};
const markedDir = path.join(APP, "node_modules", "marked");
const evilDirFor = (tamper) => path.join(__dirname, tamper ? (tamper === true ? "evil-marked-tamper" : "evil-marked-tamper-" + tamper) : "evil-marked");
// LavaMoat names a package from its real path, so there the compromised copy
// is copied into node_modules/marked instead of symlinked.
async function withMarked(opts, mode, fn) {
  if (!opts.evil) return fn();
  const aside = markedDir + ".genuine";
  fs.renameSync(markedDir, aside);
  if (mode === "lavamoat") fs.cpSync(evilDirFor(opts.tamper), markedDir, { recursive: true });
  else fs.symlinkSync(evilDirFor(opts.tamper), markedDir, "dir");
  try { return await fn(); } finally { fs.rmSync(markedDir, { recursive: true, force: true }); fs.renameSync(aside, markedDir); }
}
// The reviewed policy: the regenerated policy minus every global marked is not
// granted (ECMAScript built-ins stay, as QuickJS provides them too; marked's
// grant is empty). Same rule as eval-lavamoat/run.cjs. Written as
// policy-override.json next to a copy of the regenerated policy.json.
const ES_BUILTINS = new Set(["Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "Error", "EvalError", "Float32Array", "Float64Array", "Int8Array", "Int16Array", "Int32Array", "JSON", "Map", "Math", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError", "TypeError", "URIError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt", "decodeURIComponent", "encodeURIComponent"]);
function reviewPolicy() {
  const regen = JSON.parse(fs.readFileSync(path.join(LP, "regen", "policy.json"), "utf8"));
  const override = { resources: { marked: { globals: {} } } };
  for (const [g, v] of Object.entries(regen.resources?.marked?.globals ?? {})) {
    if (!(v !== "write" && ES_BUILTINS.has(g.split(".")[0]))) override.resources.marked.globals[g] = false;
  }
  const dir = path.join(LP, "regen-reviewed");
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(LP, "regen", "policy.json"), path.join(dir, "policy.json"));
  fs.writeFileSync(path.join(dir, "policy-override.json"), JSON.stringify(override, null, 1) + "\n");
  return { removed: Object.keys(override.resources.marked.globals) };
}
module.exports = { VARIANTS };
// Each variant builds in its own process: Node caches require.resolve, which
// the plugin uses to find the library, so a later build in the same process
// would keep resolving marked to the compromised copy.
function bundleHas(name, needle) {
  const dist = path.join(__dirname, "..", "out", name, "dist");
  return fs.readdirSync(dist).some((f) => (f.endsWith(".js") || !f.includes(".")) && fs.readFileSync(path.join(dist, f), "utf8").includes(needle));
}
const payloadPresent = (name) => bundleHas(name, "exfil.invalid");
const prologuePresent = (name) => bundleHas(name, "tamper:T1=");
if (require.main === module) {
  // default: all variants, policies first (the t-lavamoat-* builds need them)
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(VARIANTS).sort((a, b) => (b.startsWith("pol-") - a.startsWith("pol-")));
  if (process.env.VARIANT_CHILD) {
    (async () => {
      const name = names[0]; const [mode, opts] = VARIANTS[name];
      if (mode === "review") return console.log(JSON.stringify({ name, ...reviewPolicy() }));
      if (opts.policy && !["generate", "generate-only"].includes(opts.policy) && !fs.existsSync(path.join(opts.policy, "policy.json"))) throw new Error("policy " + opts.policy + " missing: build pol-clean/pol-regen/pol-reviewed first");
      const r = await withMarked(opts, mode, () => build(mode, { ...opts, outName: name }));
      console.log(JSON.stringify({ name, ...r }));
    })().catch((e) => { console.log(names[0], "FAILED", String(e.message ?? e).slice(0, 2000)); process.exit(1); });
  } else {
    const { spawnSync } = require("child_process");
    for (const name of names) {
      const r = spawnSync(process.execPath, [__filename, name], { env: { ...process.env, VARIANT_CHILD: "1" }, encoding: "utf8" });
      const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("{") || l.includes("FAILED"));
      console.log(line ?? `${name} FAILED (no output) ${r.stderr?.slice(0, 500)}`);
      if (r.status !== 0) { process.exitCode = 1; continue; }
      const [mode, o] = VARIANTS[name];
      if (mode === "review" || o.policy === "generate-only") continue;
      // The payload must be in exactly the compromised builds, and the tamper prologue in exactly the t-* builds.
      if (payloadPresent(name) !== !!o.evil) { console.log(name, "FAILED payload check"); process.exitCode = 1; }
      if (prologuePresent(name) !== !!o.tamper) { console.log(name, "FAILED tamper-prologue check"); process.exitCode = 1; }
    }
  }
}
