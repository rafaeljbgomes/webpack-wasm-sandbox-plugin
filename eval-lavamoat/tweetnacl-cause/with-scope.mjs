// Tests whether evaluating TweetNaCl's source inside a `with` scope, as SES
// does for compartment code, explains its slowdown under LavaMoat.
//   plain - the source evaluated by new Function, no `with`
//   with  - the same, inside `with (scope)` over a plain object
//   proxy - inside `with (scope)` over a Proxy that resolves globals, as SES's
//           scope proxy does
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mode = process.argv[2];
const src = fs.readFileSync(require.resolve("tweetnacl/nacl-fast.js"), "utf8");
const module = { exports: {} };
const body = `(function(module){ ${src}\n })(module);`;
if (mode === "plain") new Function("module", body)(module);
else {
  const target = { module, crypto: globalThis.crypto };
  const scope = mode === "proxy"
    ? new Proxy(target, { has: () => true, get: (t, k) => (k === Symbol.unscopables ? undefined : k in t ? t[k] : globalThis[k]) })
    : Object.assign(Object.create(null), target, { Float64Array, Uint8Array, Int32Array, Uint32Array, Math, Error, TypeError });
  new Function("scope", `with (scope) { ${body} }`)(scope);
}
const nacl = module.exports;
const seed = new Uint8Array(32).fill(7), msg = new TextEncoder().encode("x".repeat(256));
const run = () => { const kp = nacl.sign.keyPair.fromSeed(seed); const s = nacl.sign.detached(msg, kp.secretKey); if (!nacl.sign.detached.verify(msg, s, kp.publicKey)) throw new Error("bad"); };
for (let i = 0; i < 20; i++) run();
const t = []; for (let i = 0; i < 30; i++) { const s = performance.now(); run(); t.push(performance.now() - s); }
t.sort((a, b) => a - b);
console.log(JSON.stringify({ mode, medianMs: +t[15].toFixed(2) }));
