import assert from "node:assert/strict";
import test from "node:test";
import { SandboxManager } from "../core/sandbox-manager.js";

const LIB = `var __SANDBOXED_LIB__ = {
  makeSet: () => new Set([1, 2, 3]),
  makeMap: () => new Map([["a", 1], ["b", { c: 2 }]]),
  objWithSet: () => ({ name: "x", items: new Set(["a", "b"]) }),
  setOfObjects: () => new Set([{ k: 1 }, { k: 2 }]),
  Holder: class { constructor() { this.s = new Set([7]); } self() { return this; } },
  sizeOf: (s) => (s instanceof Set ? "Set:" + s.size : s instanceof Map ? "Map:" + s.size : "no:" + typeof s),
  roundtrip: (s) => s,
  setHas: (s, v) => s.has(v),
};`;

async function make() {
  const sb = await SandboxManager.createSandbox("x", LIB, { permissions: [] });
  sb.unrefPump();
  return sb;
}

test("a VM Set returns to the host as a real Set", async () => {
  const sb = await make();
  const s = sb.exports.makeSet();
  assert.ok(s instanceof Set);
  assert.deepEqual([...s], [1, 2, 3]);
  sb.dispose();
});

test("a VM Map returns to the host as a real Map", async () => {
  const sb = await make();
  const m = sb.exports.makeMap();
  assert.ok(m instanceof Map);
  assert.equal(m.get("a"), 1);
  assert.deepEqual(m.get("b"), { c: 2 });
  sb.dispose();
});

test("a Set nested in a returned object is a real Set", async () => {
  const sb = await make();
  const o = sb.exports.objWithSet();
  assert.ok(o.items instanceof Set);
  assert.deepEqual([...o.items], ["a", "b"]);
  sb.dispose();
});

test("a Set held by an instance is a real Set", async () => {
  const sb = await make();
  const self = sb.createInstance("Holder", []).self();
  assert.ok(self.s instanceof Set);
  assert.deepEqual([...self.s], [7]);
  sb.dispose();
});

test("a Set of plain objects crosses by value", async () => {
  const sb = await make();
  const s = sb.exports.setOfObjects();
  assert.ok(s instanceof Set);
  assert.deepEqual([...s], [{ k: 1 }, { k: 2 }]);
  sb.dispose();
});

test("a host Set passed in becomes a usable VM Set", async () => {
  const sb = await make();
  assert.equal(sb.exports.sizeOf(new Set([1, 2, 3])), "Set:3");
  assert.equal(sb.exports.setHas(new Set(["x"]), "x"), true);
  sb.dispose();
});

test("a host Map passed in becomes a usable VM Map", async () => {
  const sb = await make();
  assert.equal(sb.exports.sizeOf(new Map([["a", 1]])), "Map:1");
  sb.dispose();
});
