// Which sandbox-side writes to a granted host object reach the host?
import { SandboxManager } from "../.sandbox/core/sandbox-manager.js";
const lib = `var __SANDBOXED_LIB__ = { w(code) { try { (0, eval)(code); return "ok"; } catch (e) { return "threw: " + e.message; } } };`;
const cases = [
  ["overwrite existing string prop", "Cap.str = 'x'", (c) => c.str],
  ["overwrite existing number prop", "Cap.num = 99", (c) => c.num],
  ["add new prop", "Cap.added = 'x'", (c) => c.added],
  ["delete existing prop", "delete Cap.toDelete", (c) => ("toDelete" in c) ? "present" : "deleted"],
  ["overwrite existing function", "Cap.fn = () => 'pwned'", (c) => c.fn()],
  ["write nested object prop", "Cap.nested.v = 'x'", (c) => c.nested.v],
  ["replace nested object", "Cap.nested = {v:'x'}", (c) => c.nested.v],
  ["write array element", "Cap.arr[0] = 'x'", (c) => c.arr[0]],
  ["push to array", "Cap.arr.push('x')", (c) => c.arr.length],
  ["set __proto__ member", "Cap.__proto__.polluted = 'x'", () => ({}).polluted],
  ["defineProperty getter", "Object.defineProperty(Cap, 'str', { get(){ return 'x'; } })", (c) => c.str],
  ["Intl-style: overwrite existing method", "Intl.DateTimeFormat = 1", () => typeof Intl.DateTimeFormat],
  ["Intl-style: add primitive", "Intl.added = 'x'", () => Intl.added],
];
const rows = [];
for (const [label, code, read] of cases) {
  globalThis.Cap = { str: "orig", num: 1, toDelete: true, fn: () => "host", nested: { v: "orig" }, arr: ["orig"] };
  const before = read(globalThis.Cap);
  const sb = await SandboxManager.createSandbox("probe", lib, { permissions: ["Cap", "Intl"] });
  const inside = sb.exports.w(code);
  const after = read(globalThis.Cap);
  sb.dispose();
  rows.push({ label, inside, before: String(before), after: String(after), reachedHost: String(before) !== String(after) });
  delete Intl.added;
}
console.table(rows);
process.exit(0);
