import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSandbox } from "./helpers/fixture-sandbox.mjs";

// Classes and factories shared by the cases below. Generated proxies construct
// named exports through createInstance(), so construction is tested there.
const LIBRARY_BODY = `
  const privates = new WeakMap();
  class WeakCounter {
    constructor(start) { privates.set(this, start); }
    increment() { privates.set(this, privates.get(this) + 1); return this; }
    get value() { return privates.get(this); }
  }
  class Hidden {
    #secret;
    constructor(secret) { this.#secret = secret; }
    reveal() { return this.#secret; }
  }
  class Base {
    constructor(value) { this.value = value; this.kind = new.target && new.target.name; }
    get double() { return this.value * 2; }
    bump() { this.value += 1; return this.value; }
    static create(value) { return new Base(value); }
  }
  class Derived extends Base {}
  function versioned() { return "called"; }
  versioned.version = "1.2";
  const frozenHolder = () => {
    const instance = new Base(1);
    Object.defineProperty(instance, "fixed", { value: { x: 1 }, writable: false, configurable: false });
    return instance;
  };
  return {
    WeakCounter, Hidden, Base, Derived, versioned,
    settings: { count: 1, read() { return this.count; }, nested: { level: { label: "deep" } } },
    makeBase: (value) => new Base(value),
    makeCounter: () => { let calls = 0; return () => ++calls; },
    frozenHolder,
    date: () => new Date(0),
    list: () => [1, { a: 2 }],
    plain: () => ({ a: 1 }),
    map: (values, fn) => values.map(fn),
    tempSize: () => globalThis.__SANDBOX_TEMP__.size,
  };
`;

test("exported object methods keep their QuickJS receiver", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(sandbox.exports.settings.read(), 1);
});

test("exported objects, methods and nested objects keep stable host wrappers", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(exports.settings, exports.settings);
  assert.equal(exports.settings.read, exports.settings.read);
  assert.equal(exports.makeBase, exports.makeBase);
  assert.equal(exports.settings.nested.level.label, "deep");
});

test("export keys with quotes and line terminators bind as data", async (t) => {
  // Keys were spliced into QuickJS source as `path["key"]`, so these broke the call.
  const keys = ['a"]; globalThis.injected = 1; //', "b\nc", `d${String.fromCharCode(0x2028)}e`];
  const { exports } = await createFixtureSandbox(
    t,
    `return {
      fns: Object.fromEntries(${JSON.stringify(keys).replace(String.fromCharCode(0x2028), "\\u2028")}.map((k, i) => [k, () => i])),
      probe: () => typeof globalThis.injected,
    };`,
  );

  assert.deepEqual(keys.map((key) => exports.fns[key]()), [0, 1, 2]);
  assert.equal(exports.probe(), "undefined");
});

test("callable exports expose their static properties", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(exports.versioned(), "called");
  assert.equal(exports.versioned.version, "1.2");
});

test("static methods on exported classes return live instances", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const instance = exports.Base.create(2);
  assert.equal(instance.bump(), 3);
  assert.equal(instance.double, 6);
});

test("createInstance keeps WeakMap-based private state", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY);
  const counter = sandbox.createInstance("WeakCounter", [1]);
  counter.increment().increment();
  assert.equal(counter.value, 3);
});

test("createInstance keeps native private fields", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(sandbox.createInstance("Hidden", ["secret"]).reveal(), "secret");
});

test("createInstance preserves new.target for subclasses", async (t) => {
  const sandbox = await createFixtureSandbox(t, LIBRARY_BODY);
  const derived = sandbox.createInstance("Derived", [3]);
  assert.equal(derived.kind, "Derived");
  assert.equal(derived.bump(), 4);
  assert.equal(derived.double, 8);
});

test("host construction of an exported subclass preserves new.target", async (t) => {
  // Direct `new` reaches Arena's patched ue() new.target branch (ADR 16),
  // unlike createInstance(), which constructs inside QuickJS.
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const derived = new exports.Derived(3);
  assert.equal(derived.kind, "Derived");
  assert.equal(derived.bump(), 4);
});

test("returned instances read prototype getters live from QuickJS", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const instance = exports.makeBase(1);
  assert.equal(instance.double, 2);
  instance.bump();
  assert.equal(instance.double, 4);
  assert.equal(instance.value, 2);
});

test("returned instances keep the same host wrapper across reads", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const instance = exports.makeBase(1);
  assert.equal(instance.bump, instance.bump);
});

test("host overrides on returned instances take precedence", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const instance = exports.makeBase(1);
  instance.bump = () => "mocked";
  assert.equal(instance.bump(), "mocked");
});

test("non-configurable read-only properties satisfy the Proxy invariant", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const holder = exports.frozenHolder();
  assert.deepEqual({ ...holder.fixed }, { x: 1 });
});

test("returned closures keep their QuickJS state", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const next = exports.makeCounter();
  assert.deepEqual([next(), next(), next()], [1, 2, 3]);
});

test("returned Dates keep Date identity instead of being proxied", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const date = exports.date();
  assert.equal(Object.prototype.toString.call(date), "[object Date]");
  assert.equal(date.getTime(), 0);
});

test("returned arrays and plain objects arrive as host values", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const list = exports.list();
  assert.ok(Array.isArray(list));
  assert.equal(list[1].a, 2);
  assert.equal(Object.getPrototypeOf(exports.plain()), Object.prototype);
});

test("host callbacks passed to exports are invoked with sandbox values", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.deepEqual(exports.map([1, 2, 3], (value) => value * 2), [2, 4, 6]);
});

test("released returned objects are removed from __SANDBOX_TEMP__", {
  todo: "each wrapped return value stays pinned in __SANDBOX_TEMP__ for the sandbox lifetime",
}, async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  for (let i = 0; i < 100; i += 1) exports.makeBase(i);
  assert.ok(exports.tempSize() < 100);
});
