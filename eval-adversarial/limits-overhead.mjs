// Cost of the optional limits on a compute-heavy call (TweetNaCl) and a
// crossing-heavy call (Lodash), in Node; 5 warm-up + 30 measured calls.
import fs from "node:fs";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";
const code = (l) => fs.readFileSync(`dist/${l}.bundle.js`, "utf8");
const seed = new Uint8Array(32).fill(7), msg = new TextEncoder().encode("x".repeat(256));
const orders = Array.from({ length: 120 }, (_, i) => ({ region: "r" + (i % 4), total: i, status: i % 5 ? "completed" : "cancelled" }));
const cases = {
  tweetnacl: { perms: ["crypto"], run: (e) => { const n = e.default ?? e; const kp = n.sign.keyPair.fromSeed(seed); n.sign.detached(msg, kp.secretKey); } },
  lodash: { perms: [], run: (e) => { const _ = e.default ?? e; _.mapValues(_.groupBy(_.filter(orders, { status: "completed" }), "region"), (o) => _.sumBy(o, "total")); } },
};
const res = {};
for (const [lib, c] of Object.entries(cases)) for (const limits of [undefined, { callTimeMs: 1000, memoryBytes: 256 * 2 ** 20 }]) {
  const sb = await SandboxManager.createSandbox(lib, code(lib), { permissions: c.perms, limits });
  const t = [];
  for (let i = 0; i < 35; i++) { const s = performance.now(); c.run(sb.exports); if (i >= 5) t.push(performance.now() - s); }
  t.sort((a, b) => a - b);
  res[`${lib} ${limits ? "limits" : "none"}`] = +t[15].toFixed(2);
  sb.dispose();
}
console.log(JSON.stringify(res));
fs.writeFileSync("eval-adversarial/limits-overhead.json", JSON.stringify({ node: process.version, medianMs: res }, null, 1));
process.exit(0);
