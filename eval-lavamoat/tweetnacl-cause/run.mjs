// Where does TweetNaCl's slowdown under LavaMoat come from? Times key
// derivation + signing + verification (the browser workload's operations) in
// Node.js in four configurations, each in a fresh process:
//   native        - plain require
//   lockdown      - SES lockdown() first, library loaded normally
//   compartment   - no lockdown, library evaluated in an SES Compartment
//   both          - lockdown() and a Compartment (what LavaMoat does)
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const mode = process.argv[2];
const src = fs.readFileSync(require.resolve("tweetnacl/nacl-fast.js"), "utf8");
if (mode === "lockdown" || mode === "both") { await import("ses"); lockdown({ errorTaming: "unsafe", consoleTaming: "unsafe" }); }
let nacl;
if (mode === "native" || mode === "lockdown") {
  nacl = require("tweetnacl");
} else {
  if (mode === "compartment") await import("ses");
  const module = { exports: {} };
  const c = new Compartment({ __options__: true, globals: { module, crypto: globalThis.crypto } });
  c.evaluate(`(function(module){ ${src}\n })`)(module);
  nacl = module.exports;
}
const seed = new Uint8Array(32).fill(7), msg = new TextEncoder().encode("x".repeat(256));
const run = () => { const kp = nacl.sign.keyPair.fromSeed(seed); const s = nacl.sign.detached(msg, kp.secretKey); if (!nacl.sign.detached.verify(msg, s, kp.publicKey)) throw new Error("bad"); };
for (let i = 0; i < 20; i++) run();
const t = []; for (let i = 0; i < 30; i++) { const s = performance.now(); run(); t.push(performance.now() - s); }
t.sort((a, b) => a - b);
console.log(JSON.stringify({ mode, medianMs: +t[15].toFixed(2) }));
