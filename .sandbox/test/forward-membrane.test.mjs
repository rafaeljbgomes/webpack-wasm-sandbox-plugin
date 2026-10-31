import assert from "node:assert/strict";
import test from "node:test";
import { createForwardMembrane } from "../membrane/forward-membrane.js";
import { REQUIRES_NEW_RE } from "../core/sb-utils.js";
import { createFixtureSandbox, defineHostGlobal } from "./helpers/fixture-sandbox.mjs";

// Unit cases share one membrane, as the forward membrane of a single sandbox.
const { bindWebApi, makeCallable } = createForwardMembrane();

/** Host class whose methods only work on the real receiver. */
class HostCounter {
  #count = 0;
  increment() {
    this.#count += 1;
    return this.#count;
  }
  get count() {
    return this.#count;
  }
}

/** Constructor-only host class with private state. */
class HostBox {
  #value;
  constructor(value) {
    this.#value = value;
  }
  get() {
    return this.#value;
  }
}

test("makeCallable calls ordinary functions with the native receiver", () => {
  const owner = { value: 3, read() { return this.value; } };
  assert.equal(makeCallable(owner.read, owner)(), 3);
});

test("makeCallable constructs constructor-only functions and wraps the instance", () => {
  const instance = makeCallable(HostBox, globalThis)(9);
  assert.equal(typeof instance, "object");
  assert.equal(instance.get(), 9);
});

test("makeCallable returns typed arrays unwrapped for copy-based marshalling", () => {
  const result = makeCallable(() => new Uint8Array([1, 2]), null)();
  assert.ok(result instanceof Uint8Array);
  assert.deepEqual([...result], [1, 2]);
});

test("makeCallable propagates unrelated TypeErrors instead of constructing", () => {
  let constructed = false;
  function Rejecting() {
    if (new.target) constructed = true;
    throw new TypeError("bad input");
  }
  assert.throws(() => makeCallable(Rejecting, null)(), { name: "TypeError", message: "bad input" });
  assert.equal(constructed, false);
});

for (const [engine, message] of [
  ["Node.js classes", "Class constructor HostBox cannot be invoked without 'new'"],
  ["V8 built-ins", "Constructor Map requires 'new'"],
  ["Chromium DOM constructors", "Failed to construct 'TextEncoder': Please use the 'new' operator, this DOM object constructor cannot be called as a function."],
]) {
  test(`constructor-only messages from ${engine} are recognised`, () => {
    assert.match(message, REQUIRES_NEW_RE);
  });
}

test("the constructor-only matcher ignores ordinary TypeError messages", () => {
  for (const message of ["bad input", "Cannot read properties of undefined (reading 'x')", "x is not a function"]) {
    assert.doesNotMatch(message, REQUIRES_NEW_RE);
  }
});

test("bindWebApi passes primitives through unchanged", () => {
  assert.equal(bindWebApi(5), 5);
  assert.equal(bindWebApi("text"), "text");
  assert.equal(bindWebApi(null), null);
  assert.equal(bindWebApi(undefined), undefined);
});

test("bindWebApi reuses one wrapper for cycles and repeated references", () => {
  const root = { name: "root" };
  root.self = root;
  const wrapper = bindWebApi(root);
  assert.equal(wrapper.self, wrapper);
  assert.equal(bindWebApi(root), wrapper);
});

test("bindWebApi exposes prototype methods bound to the native owner", () => {
  const format = new Intl.NumberFormat("en-US");
  const wrapper = bindWebApi(format);
  assert.equal(wrapper.format(1234.5), "1,234.5");
});

test("bindWebApi assignments write through to the host object", () => {
  const target = { mode: "a" };
  const wrapper = bindWebApi(target);
  wrapper.mode = "b";
  assert.equal(target.mode, "b");
});

test("an exposed host object keeps its native receiver inside QuickJS", async (t) => {
  const counter = new HostCounter();
  const sandbox = await createFixtureSandbox(t, `
    return { use: () => [TestCounter.increment(), TestCounter.increment(), TestCounter.count] };
  `, { permissions: [defineHostGlobal(t, "TestCounter", counter)] });
  assert.deepEqual(sandbox.exports.use(), [1, 2, 2]);
  assert.equal(counter.count, 2);
});

test("an exposed constructor-only host class can be constructed inside QuickJS", async (t) => {
  const sandbox = await createFixtureSandbox(t, "return { make: (v) => new TestBox(v).get() };", {
    permissions: [defineHostGlobal(t, "TestBox", HostBox)],
  });
  assert.equal(sandbox.exports.make(7), 7);
});

test("unrelated host TypeErrors reach QuickJS with their name and message", async (t) => {
  const failing = () => {
    throw new TypeError("bad input");
  };
  const sandbox = await createFixtureSandbox(t, `
    return { call: () => { try { TestFailing(); return null; } catch (e) { return [e.name, e.message]; } } };
  `, { permissions: [defineHostGlobal(t, "TestFailing", failing)] });
  assert.deepEqual(sandbox.exports.call(), ["TypeError", "bad input"]);
});

test("QuickJS writes to an exposed host object reach the host", async (t) => {
  const settings = { mode: "a" };
  const sandbox = await createFixtureSandbox(t, "return { set: () => { TestSettings.mode = 'b'; return TestSettings.mode; } };", {
    permissions: [defineHostGlobal(t, "TestSettings", settings)],
  });
  assert.equal(sandbox.exports.set(), "b");
  assert.equal(settings.mode, "b");
});

test("a self-referencing exposed object keeps its identity inside QuickJS", async (t) => {
  const root = { name: "root" };
  root.self = root;
  const sandbox = await createFixtureSandbox(t, "return { check: () => [TestRoot.self === TestRoot, TestRoot.self.self.name] };", {
    permissions: [defineHostGlobal(t, "TestRoot", root)],
  });
  assert.deepEqual(sandbox.exports.check(), [true, "root"]);
});

test("nested references back to an exposed object keep identity inside QuickJS", async (t) => {
  const root = { name: "root" };
  root.child = { parent: root };
  const sandbox = await createFixtureSandbox(t, "return { check: () => TestTree.child.parent === TestTree };", {
    permissions: [defineHostGlobal(t, "TestTree", root)],
  });
  assert.equal(sandbox.exports.check(), true);
});
