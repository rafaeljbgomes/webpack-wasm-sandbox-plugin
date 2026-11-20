// Reproduces the effect of LavaMoat's wrapping of an endowed global
// constructor on TweetNaCl, without SES: Float64Array is replaced by a
// function that constructs instances with Reflect.construct(Float64Array,
// args, new.target), as LavaMoat's runtime does for globals granted by policy
// (SES compartments do not provide Float64Array themselves).
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mode = process.argv[2];
if (mode === "wrapped") {
  const Orig = Float64Array;
  const W = function () {
    "use strict";
    if (new.target) return Reflect.construct(Orig, arguments, new.target);
    return Reflect.apply(Orig, this, arguments);
  };
  Object.defineProperties(W, Object.getOwnPropertyDescriptors(Orig));
  Object.setPrototypeOf(W, Object.getPrototypeOf(Orig));
  globalThis.Float64Array = W;
}
const nacl = require("tweetnacl");
const seed = new Uint8Array(32).fill(7), msg = new TextEncoder().encode("x".repeat(256));
const run = () => { const kp = nacl.sign.keyPair.fromSeed(seed); const s = nacl.sign.detached(msg, kp.secretKey); if (!nacl.sign.detached.verify(msg, s, kp.publicKey)) throw new Error("bad"); };
for (let i = 0; i < 20; i++) run();
const t = []; for (let i = 0; i < 30; i++) { const s = performance.now(); run(); t.push(performance.now() - s); }
t.sort((a, b) => a - b);
const a = new Float64Array(16);
console.log(JSON.stringify({ mode, medianMs: +t[15].toFixed(2), protoIsFloat64: Object.getPrototypeOf(a) === Float64Array.prototype }));
