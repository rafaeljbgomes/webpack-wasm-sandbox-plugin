// Adversarial scenarios against the membrane, run by compromised builds of
// real libraries: the shipped bundle plus an appended payload, loaded through
// the same SandboxManager path as the generated proxies.
//
//  (i)  callback abuse: a compromised Lodash receives application callbacks
//  (ii) granted-API abuse: a compromised library with Intl, TextEncoder,
//       TextDecoder and crypto grants hunts for a host reference
//  (iii) denial of service: run in workers by dos.mjs
//
// Run: node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs eval-adversarial/run.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = (lib) => fs.readFileSync(path.join(root, "dist", `${lib}.bundle.js`), "utf8");
globalThis.__HOST_MARK__ = "host-realm";

// Probe run inside the VM on any value: does it yield a host-realm Function?
const PROBE = `
function __probe(v) {
  const out = {};
  const tries = {
    "constructor.constructor": () => v.constructor.constructor,
    "getPrototypeOf.constructor": () => Object.getPrototypeOf(v).constructor,
    "call.constructor": () => v.call && v.call.constructor,
    "__proto__.constructor": () => v.__proto__ && v.__proto__.constructor && v.__proto__.constructor.constructor,
  };
  for (const [k, f] of Object.entries(tries)) {
    try {
      const F = f();
      if (typeof F !== "function") { out[k] = "n/a"; continue; }
      out[k] = F("return [typeof process, typeof require, typeof fetch, typeof globalThis.__HOST_MARK__].join(',')")();
    } catch (e) { out[k] = "threw " + (e && e.name); }
  }
  return out;
}
`;

const results = { callbackAbuse: {}, grantedApiAbuse: {} };

// ---------------------------------------------------------------------------
// (i) Callback abuse: compromised Lodash
// ---------------------------------------------------------------------------
{
  const payload = `
;(function () {
  ${PROBE}
  const _ = __SANDBOXED_LIB__;
  const log = [];
  let stash = null;
  const origMap = _.map;
  _.map = function (coll, cb) {
    const r = {};
    if (typeof cb === "function") {
      stash = cb;
      r.typeof = typeof cb;
      try { r.toString = String(Function.prototype.toString.call(cb)).slice(0, 120); } catch (e) { r.toString = "threw " + e.name; }
      r.probe = __probe(cb);
      // crafted arguments: getter-laden object, VM function, Proxy, huge string
      let getterRuns = 0;
      const crafted = { get url() { getterRuns++; return "https://attacker.example/x"; }, fn: function () { return "vm-fn-ran"; } };
      try { r.craftedReturn = cb(crafted); } catch (e) { r.craftedReturn = "threw " + e.name; }
      r.getterRunsDuringCall = getterRuns;
      let reads = 0;
      const toctou = { get url() { reads++; return reads === 1 ? "https://app.example/safe" : "https://attacker.example/evil"; } };
      try { r.toctouReturn = cb({ toctou }); } catch (e) { r.toctouReturn = "threw " + e.name; }
      try { r.proxyArg = cb(new Proxy({}, { get: () => "trap" })); } catch (e) { r.proxyArg = "threw " + e.name; }
      // amplification: call the callback many times
      let n = 0; try { for (let i = 0; i < 1000; i++) { cb({ i }); n++; } } catch (e) {}
      r.amplifiedCalls = n;
      // exception from host callback
      try { cb({ throwMe: true }); } catch (e) { r.hostErrorName = e && e.name; r.hostErrorProbe = __probe(e); }
      // value returned by the callback (application-provided object)
      try { const ret = cb({ returnObject: true }); r.returnedType = typeof ret; r.returnedCall = ret && typeof ret.secretMethod === "function" ? ret.secretMethod() : "none"; r.returnedProbe = ret ? __probe(ret) : null; } catch (e) { r.returnedCall = "threw " + e.name; }
    }
    globalThis.__lastReport = r;
    return origMap.apply(this, arguments);
  };
  _.__report = () => JSON.stringify(globalThis.__lastReport);
  _.__replayStashed = () => { try { return stash ? String(stash({ replay: true })) : "no-stash"; } catch (e) { return "threw " + e.name + ": " + e.message; } };
})();
`;
  const sb = await SandboxManager.createSandbox("lodash", bundle("lodash") + payload, { permissions: [] });
  const _ = sb.exports.default ?? sb.exports;
  const seen = [];
  let secretCalls = 0;
  // The application's callback, which holds host authority (here: a log sink).
  const appCallback = (u) => {
    seen.push(u);
    if (u && u.throwMe) throw new TypeError("app error");
    if (u && u.returnObject) return { secretMethod: () => { secretCalls++; return "host-method-ran"; } };
    return u && typeof u === "object" ? Object.keys(u).join(",") : String(u);
  };
  _.map([1, 2], appCallback);
  const r = JSON.parse(_.__report());
  const crafted = seen.find((x) => x && "url" in x);
  r.hostSawCraftedAs = crafted ? { urlIsGetter: !!Object.getOwnPropertyDescriptor(crafted, "url")?.get, url: crafted.url, fnType: typeof crafted.fn } : null;
  if (crafted && typeof crafted.fn === "function") { try { r.hostCallingVmFn = crafted.fn(); } catch (e) { r.hostCallingVmFn = "threw " + e.name; } }
  r.secretMethodRanOnHost = secretCalls;
  const t = seen.find((x) => x && x.toctou);
  if (t) { const first = t.toctou.url; const second = t.toctou.url; r.toctouHostReads = [first, second]; }
  // Replay after the original call returned (callback retention).
  const before = seen.length;
  r.replayAfterReturn = _.__replayStashed();
  r.replayReachedHost = seen.length > before;
  results.callbackAbuse = r;
  sb.dispose();
}

// ---------------------------------------------------------------------------
// (ii) Granted-API abuse: compromised strip-ansi with four grants
// ---------------------------------------------------------------------------
{
  const payload = `
;(function () {
  ${PROBE}
  const r = {};
  const targets = {};
  const add = (k, f) => { try { targets[k] = f(); } catch (e) { r[k] = "unavailable: " + (e && e.name); } };
  add("Intl.DateTimeFormat", () => Intl.DateTimeFormat);
  add("new Intl.DateTimeFormat()", () => new Intl.DateTimeFormat("en-US"));
  add("dtf.format", () => new Intl.DateTimeFormat("en-US").format);
  add("dtf.resolvedOptions()", () => new Intl.DateTimeFormat("en-US").resolvedOptions());
  add("dtf.formatToParts()", () => new Intl.DateTimeFormat("en-US").formatToParts(new Date(0)));
  add("Intl.NumberFormat", () => Intl.NumberFormat);
  add("TextEncoder", () => TextEncoder);
  add("new TextEncoder().encode()", () => new TextEncoder().encode("x"));
  add("new TextDecoder()", () => new TextDecoder());
  add("crypto", () => crypto);
  add("crypto.getRandomValues", () => crypto.getRandomValues);
  add("crypto.subtle", () => crypto.subtle);
  for (const [k, v] of Object.entries(targets)) r[k] = v === undefined ? "undefined" : __probe(v);
  // Errors thrown by host APIs
  try { new Intl.DateTimeFormat("en-US", { timeZone: "Nowhere/Invalid" }); r.hostErrorProbe = "no error"; } catch (e) { r.hostErrorName = e && e.name; r.hostErrorProbe = __probe(e); }
  // Crafted arguments to granted functions
  const tries = {
    "getRandomValues(Proxy)": () => crypto.getRandomValues(new Proxy(new Uint8Array(4), {})),
    "getRandomValues({length:1e9})": () => crypto.getRandomValues({ length: 1e9 }),
    "getRandomValues(Uint8Array(70000))": () => crypto.getRandomValues(new Uint8Array(70000)).length,
    "TextDecoder.decode(getter object)": () => new TextDecoder().decode({ get byteLength() { return 1e9; } }),
    "DateTimeFormat(locale with toString)": () => new Intl.DateTimeFormat({ toString() { return "en-US"; } }).format(0),
  };
  r.craftedArgs = {};
  for (const [k, f] of Object.entries(tries)) { try { const v = f(); r.craftedArgs[k] = "returned " + (typeof v === "string" ? v.slice(0, 40) : typeof v === "number" ? v : typeof v); } catch (e) { r.craftedArgs[k] = "threw " + (e && e.name); } }
  // Ungranted APIs
  r.ungranted = ["fetch", "XMLHttpRequest", "localStorage", "document", "process", "require", "setTimeout", "WebAssembly", "performance"].map((n) => n + ":" + typeof globalThis[n]).join(" ");
  __SANDBOXED_LIB__.__report = () => JSON.stringify(r);
})();
`;
  const before = { dtf: Intl.DateTimeFormat, te: TextEncoder, grv: crypto.getRandomValues };
  const sb = await SandboxManager.createSandbox("strip-ansi", bundle("strip-ansi") + payload, {
    permissions: ["Intl", "TextEncoder", "TextDecoder", "crypto"],
  });
  const r = JSON.parse(sb.exports.__report());
  r.hostIntrinsicsUnchanged = before.dtf === Intl.DateTimeFormat && before.te === TextEncoder && before.grv === crypto.getRandomValues;
  results.grantedApiAbuse = r;
  sb.dispose();
}

results.node = process.version;
fs.writeFileSync(path.join(root, "eval-adversarial", "results.json"), JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
process.exit(0);
