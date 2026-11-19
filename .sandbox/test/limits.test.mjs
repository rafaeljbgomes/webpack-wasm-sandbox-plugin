import { test } from "node:test";
import assert from "node:assert/strict";
import { SandboxManager } from "../core/sandbox-manager.js";

const lib = `var __SANDBOXED_LIB__ = {
  ok: () => 42,
  spin: () => { for (;;) { try { for (;;) {} } catch (e) {} } },
  alloc: () => { const a = []; for (;;) a.push(new ArrayBuffer(1e6)); },
};`;

test("callTimeMs interrupts a runaway call and the sandbox stays usable", async () => {
  const sb = await SandboxManager.createSandbox("lim", lib, { permissions: [], limits: { callTimeMs: 100 } });
  const t0 = Date.now();
  assert.throws(() => sb.exports.spin(), /interrupted/);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(sb.exports.ok(), 42);
  sb.dispose();
});

test("memoryBytes caps the instance's linear memory", async () => {
  const sb = await SandboxManager.createSandbox("lim", lib, { permissions: [], limits: { memoryBytes: 64 * 2 ** 20 } });
  assert.throws(() => sb.exports.alloc(), /out of memory/);
  assert.equal(sb.exports.ok(), 42);
  sb.dispose();
});

test("invalid limits are rejected", async () => {
  await assert.rejects(SandboxManager.createSandbox("lim", lib, { limits: { memoryBytes: 1024 } }), /memoryBytes/);
  await assert.rejects(SandboxManager.createSandbox("lim", lib, { limits: { callTimeMs: 0 } }), /callTimeMs/);
});

test("the shared module refuses a per-library memory cap", async () => {
  await SandboxManager.ready();
  assert.throws(() => SandboxManager.createSandboxSync("lim", lib, { limits: { memoryBytes: 64 * 2 ** 20 } }), /dedicated module/);
});
