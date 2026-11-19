import assert from "node:assert/strict";
import test from "node:test";
import { SandboxManager } from "../core/sandbox-manager.js";

// A class whose array field is created empty in the constructor and filled by
// a method, the shape that a Markdown lexer's token list has. Before the
// extra-property array marshaller, the host kept the empty copy registered at
// construction and the elements were lost.
const LIB = `var __SANDBOXED_LIB__ = {
  Lexer: class {
    constructor() { this.tokens = []; this.tokens.links = Object.create(null); }
    lex() {
      this.tokens.push({ type: "a", raw: "x", tokens: [{ type: "text", raw: "x" }] });
      this.tokens.push({ type: "b", raw: "y" });
      this.tokens.links.ref = { href: "h", title: null };
      return this.tokens;
    }
  },
  plainArray: () => [1, 2, 3],
  arrayWithProps: () => { const a = [{ k: 1 }]; a.meta = { n: 2 }; return a; },
};`;

test("a constructor-created array filled by a method keeps its elements and extra props", async () => {
  const sb = await SandboxManager.createSandbox("x", LIB, { permissions: [] });
  sb.unrefPump();
  const inst = sb.createInstance("Lexer", []);
  const tokens = inst.lex();
  assert.ok(Array.isArray(tokens));
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].type, "a");
  assert.deepEqual(tokens[0].tokens, [{ type: "text", raw: "x" }]);
  assert.equal(tokens[1].type, "b");
  assert.equal(Object.getPrototypeOf(tokens.links), null, "links keeps its null prototype");
  assert.deepEqual({ ...tokens.links }, { ref: { href: "h", title: null } });
  sb.dispose();
});

test("plain arrays without extra properties are unchanged", async () => {
  const sb = await SandboxManager.createSandbox("x", LIB, { permissions: [] });
  sb.unrefPump();
  assert.deepEqual(sb.exports.plainArray(), [1, 2, 3]);
  sb.dispose();
});

test("a fresh array with extra properties crosses with elements and props", async () => {
  const sb = await SandboxManager.createSandbox("x", LIB, { permissions: [] });
  sb.unrefPump();
  const a = sb.exports.arrayWithProps();
  assert.ok(Array.isArray(a));
  assert.deepEqual([...a], [{ k: 1 }]);
  assert.deepEqual(a.meta, { n: 2 });
  sb.dispose();
});

test("the marshaller adds no global to the sandbox", async () => {
  const sb = await SandboxManager.createSandbox("x", LIB, { permissions: [] });
  sb.unrefPump();
  const leaked = sb.vm.getString(
    sb.vm.unwrapResult(sb.vm.evalCode("Object.getOwnPropertyNames(globalThis).filter(n => n.startsWith('__sb')).join(',')")),
  );
  assert.equal(leaked, "");
  sb.dispose();
});
