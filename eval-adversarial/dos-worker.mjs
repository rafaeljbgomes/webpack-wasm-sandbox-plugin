import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { attack, limits } = workerData;
let memory;
const orig = WebAssembly.instantiate;
WebAssembly.instantiate = async function (s, imports, ...r) {
  const res = await orig.call(this, s, imports, ...r);
  for (const ns of Object.values(imports ?? {})) for (const v of Object.values(ns)) if (v instanceof WebAssembly.Memory) memory = v;
  return res;
};
const payload = `
;__SANDBOXED_LIB__.__attack = {
  spin() { for (;;) {} },
  alloc() { const a = []; for (;;) a.push(new Array(1e5).fill(1.5)); },
  string() { let s = "x"; for (;;) s = s + s; },
  recurse() { const f = (n) => f(n + 1) + 1; return f(0); },
  catchSpin() { for (;;) { try { for (;;) {} } catch (e) {} } },
};`;
const code = fs.readFileSync(path.join(root, "dist", "strip-ansi.bundle.js"), "utf8") + payload;
const sb = await SandboxManager.createSandbox("strip-ansi", code, { permissions: [], limits: limits ?? undefined });
const mem0 = memory.buffer.byteLength;
const t0 = performance.now();
let outcome;
try { sb.exports.__attack[attack](); outcome = "returned"; }
catch (e) { outcome = `${e?.name}: ${String(e?.message).slice(0, 60)}`; }
const elapsed = performance.now() - t0;
let usable;
try { usable = sb.exports.default("\u001b[31mok\u001b[0m") === "ok"; } catch (e) { usable = "threw " + e?.name; }
parentPort.postMessage({ attack, limits, outcome, elapsedMs: Math.round(elapsed), wasmMemoryMB: Math.round(memory.buffer.byteLength / 2 ** 20), wasmMemoryStartMB: Math.round(mem0 / 2 ** 20), sandboxUsableAfter: usable });
