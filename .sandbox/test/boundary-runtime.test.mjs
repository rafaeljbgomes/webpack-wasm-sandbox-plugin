import assert from "node:assert/strict";
import test from "node:test";
import { getQuickJS } from "quickjs-emscripten";
import { Arena } from "quickjs-emscripten-sync";
import { isPlainJsonGraph } from "../core/json-transfer.js";
import { createFixtureSandbox, defineHostGlobal } from "./helpers/fixture-sandbox.mjs";

// Focused regressions for the boundary fast path (ADR 27): helper caching, bulk
// unmarshalling, by-value Web API results, microtask job draining, marshaller
// classification, error shape, and QuickJS handle ownership. `getQuickJS()`
// returns the synchronous build, which aborts disposal on any leaked object.

test("steady-state crossings compile no QuickJS source", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    const shared = { tag: "shared" };
    return {
      make: (i) => ({ i, nested: { list: [i, "x", true, null] }, shared, fn() { return i; } }),
      fail: () => { const e = new RangeError("bad"); e.path = ["a"]; throw e; },
      bytes: (n) => new Uint8Array(n).fill(7),
      pattern: () => /a:b\\/c/gi,
    };
  `);
  const { exports } = sandbox;
  // Thrown QuickJS errors surface as QuickJSUnwrapError whose cause is the copy.
  const isBadRange = (error) =>
    error.cause?.name === "RangeError" && error.cause.message === "bad" && error.cause.path[0] === "a";
  // Warm up the lazily compiled marshaller readers.
  exports.make(0);
  exports.bytes(1);
  exports.pattern();
  assert.throws(() => exports.fail(), isBadRange);

  let compiled = 0;
  const evalCode = sandbox.vm.evalCode;
  sandbox.vm.evalCode = function countingEvalCode(...args) {
    compiled += 1;
    return evalCode.apply(this, args);
  };
  for (let i = 1; i <= 20; i += 1) {
    const value = exports.make(i);
    assert.equal(value.nested.list[0], i);
    assert.deepEqual([...exports.bytes(3)], [7, 7, 7]);
    assert.equal(String(exports.pattern()), "/a:b\\/c/gi");
    assert.throws(() => exports.fail(), isBadRange);
  }
  sandbox.vm.evalCode = evalCode;
  assert.equal(compiled, 0);
});

test("sandbox call errors do not reference the QuickJS context or heap", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return { fail: () => { throw new RangeError("Invalid time value"); } };
  `);
  const thrown = (() => {
    try {
      sandbox.exports.fail();
    } catch (error) {
      return error;
    }
  })();
  assert.equal(thrown.cause?.name, "RangeError");
  assert.match(thrown.message, /Invalid time value/);
  assert.equal(Object.hasOwn(thrown, "context"), false);
  // Mirror a test-runner serializer, which walks every own property up each
  // prototype chain; reaching the WebAssembly heap view visits millions of keys.
  const seen = new Set();
  let visited = 0;
  const walk = (value) => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    assert.ok(!ArrayBuffer.isView(value) || value.length < 4096, "error reaches a large typed array");
    for (let owner = value; owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
      for (const key of Object.getOwnPropertyNames(owner)) {
        visited += 1;
        let child;
        try {
          child = value[key];
        } catch {
          continue;
        }
        walk(child);
      }
    }
  };
  walk(thrown);
  assert.ok(visited < 10_000, `serializer walk visited ${visited} properties`);
});

test("bulk unmarshalling preserves values, descriptors, and identity", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    const shared = { tag: "shared" };
    const config = { level: 1 };
    const value = {
      nan: NaN, negativeZero: -0, infinity: -Infinity, long: "y".repeat(300),
      a: shared, b: shared, nothing: undefined,
      get computed() { return 42; },
    };
    Object.defineProperty(value, "hidden", { value: "h", enumerable: false });
    value[Symbol.iterator] = function* () { yield 1; };
    value.self = value;
    return { value: () => value, config: () => config };
  `);
  const result = sandbox.exports.value();
  assert.ok(Number.isNaN(result.nan));
  assert.ok(Object.is(result.negativeZero, -0));
  assert.equal(result.infinity, -Infinity);
  assert.equal(result.long, "y".repeat(300));
  assert.equal(result.a, result.b);
  assert.ok("nothing" in result);
  assert.equal(result.nothing, undefined);
  assert.equal(typeof Object.getOwnPropertyDescriptor(result, "computed").get, "function");
  assert.equal(Object.getOwnPropertyDescriptor(result, "hidden").enumerable, false);
  assert.equal(typeof result[Symbol.iterator], "function");
  assert.equal(result.self, result);
  assert.equal(sandbox.exports.config(), sandbox.exports.config());
});

test("guest replacement of intrinsics does not reach bridge helpers", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    JSON.parse = () => ({ forged: true });
    JSON.stringify = () => "{}";
    Object.defineProperties = () => { throw new Error("forged defineProperties"); };
    Object.defineProperty = () => { throw new Error("forged defineProperty"); };
    Object.getOwnPropertyDescriptors = () => ({});
    Object.setPrototypeOf = () => { throw new Error("forged setPrototypeOf"); };
    Reflect.ownKeys = () => [];
    Reflect.get = () => "forged";
    return {
      echo: (value) => ({ copy: value.items.map((item) => item.id), original: value }),
      make: () => ({ id: 1, nested: { ok: true } }),
    };
  `);
  const made = sandbox.exports.make();
  assert.deepEqual({ ...made, nested: { ...made.nested } }, { id: 1, nested: { ok: true } });
  const echoed = sandbox.exports.echo({ items: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual([...echoed.copy], ["a", "b"]);
  assert.equal(echoed.original.items[1].id, "b");
});

test("plain Web API call results cross as real QuickJS data", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return {
      parts: () => {
        const parts = new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).formatToParts(new Date(0));
        return {
          isArray: Array.isArray(parts),
          plain: Object.getPrototypeOf(parts[0]) === Object.prototype,
          types: parts.map((part) => part.type).join(","),
        };
      },
      options: () => {
        const options = new Intl.NumberFormat("en-US").resolvedOptions();
        options.locale = "mutated";
        return Object.getPrototypeOf(options) === Object.prototype;
      },
    };
  `, { permissions: ["Intl"] });
  const parts = sandbox.exports.parts();
  assert.equal(parts.isArray, true);
  assert.equal(parts.plain, true);
  assert.match(parts.types, /month/);
  assert.equal(sandbox.exports.options(), true);
});

test("only lossless JSON graphs qualify for by-value transfer", () => {
  assert.equal(isPlainJsonGraph({ a: [1, "b", null, { c: false }] }), true);
  assert.equal(isPlainJsonGraph(Object.create(null)), true);
  assert.equal(isPlainJsonGraph({ a: undefined }), false);
  assert.equal(isPlainJsonGraph([1, , 3]), false);
  assert.equal(isPlainJsonGraph({ a: -0 }), false);
  assert.equal(isPlainJsonGraph({ a: Number.NaN }), false);
  assert.equal(isPlainJsonGraph(new Date(0)), false);
  assert.equal(isPlainJsonGraph({ get a() { return 1; } }), false);
  const shared = {};
  assert.equal(isPlainJsonGraph({ a: shared, b: shared }), false);
});

test("forged typed-array constructor names never select host globals", async (t) => {
  let invoked = false;
  defineHostGlobal(t, "ForgedTypedArrayCtor", function forged() {
    invoked = true;
  });
  const sandbox = await createFixtureSandbox(t, `
    return {
      forged: () => {
        const view = new Uint8Array([1, 2]);
        Object.defineProperty(view, "constructor", { value: { name: "ForgedTypedArrayCtor" } });
        return view;
      },
      real: () => new Float64Array([1.5, -2]),
    };
  `);
  // The rejected view falls back to generic object handling, never a host call.
  assert.doesNotThrow(() => sandbox.exports.forged());
  assert.equal(invoked, false);
  const real = sandbox.exports.real();
  assert.ok(real instanceof Float64Array);
  assert.deepEqual([...real], [1.5, -2]);
});

test("QuickJS promise reactions drain before host timers", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return { next: async (value) => (await Promise.resolve(value)) + 1 };
  `);
  let timerFired = false;
  const timer = setTimeout(() => {
    timerFired = true;
  }, 0);
  let value = 0;
  for (let i = 0; i < 25; i += 1) {
    value = await sandbox.exports.next(value);
  }
  clearTimeout(timer);
  assert.equal(value, 25);
  assert.equal(timerFired, false);
});

test("marshallers round-trip claimed kinds in both directions", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return {
      echo: (value) => value,
      isTaggedArray: (value) => Array.isArray(value) && value.length === 2,
      error: () => { const e = new TypeError("typed"); e.issues = [{ code: "x" }]; return e; },
    };
  `);
  const { exports } = sandbox;
  const bytes = exports.echo(new Int16Array([-1, 2]));
  assert.ok(bytes instanceof Int16Array);
  assert.deepEqual([...bytes], [-1, 2]);
  const pattern = exports.echo(/x:\/y/my);
  assert.ok(pattern instanceof RegExp);
  assert.equal(pattern.source, "x:\\/y");
  assert.equal(pattern.flags, "my");
  const hostArguments = (function () {
    return arguments;
  })(1, "two");
  assert.equal(exports.isTaggedArray(hostArguments), true);
  const args = exports.echo(hostArguments);
  assert.equal(Object.prototype.toString.call(args), "[object Arguments]");
  assert.deepEqual([...args], [1, "two"]);
  const error = exports.error();
  assert.ok(error instanceof TypeError);
  assert.equal(error.message, "typed");
  assert.equal(error.issues[0].code, "x");
});

test("a QuickJS prototype with a tag accessor does not recurse in the Arguments check", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return { proto: () => Object.getPrototypeOf(new Uint8Array(1)) };
  `);
  assert.doesNotThrow(() => sandbox.exports.proto());
});

test("disposal succeeds after async calls and nested custom-marshalled values", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return {
      later: async (value) => ({ value, when: new Date(0), bytes: new Uint8Array([value]) }),
      inspect: (input) => [input.when instanceof Date, input.bytes.length, input.pattern.flags, typeof input.nested.at],
      failure: () => ({ error: new TypeError("nested"), list: [new Int8Array(1), /x/g] }),
    };
  `);
  const resolved = await sandbox.exports.later(3);
  assert.equal(resolved.value, 3);
  assert.ok(resolved.when instanceof Date);
  assert.deepEqual(
    [...sandbox.exports.inspect({ when: new Date(1), bytes: new Uint8Array(2), pattern: /y/m, nested: { at: new Date(2) } })],
    [true, 2, "m", "object"],
  );
  const failure = sandbox.exports.failure();
  assert.ok(failure.error instanceof TypeError);
  assert.ok(failure.list[0] instanceof Int8Array);
  assert.ok(failure.list[1] instanceof RegExp);
  assert.doesNotThrow(() => sandbox.dispose());
});

test("exposed accessors keep identity and live host state across repeated reads", async (t) => {
  const counter = { c: 0 };
  const root = { name: "root", get counter() { return counter; } };
  root.self = root;
  root.child = { parent: root };
  const sandbox = await createFixtureSandbox(t, `
    return {
      read: () => TestRoot.counter.c,
      identity: () => [TestRoot.self.self === TestRoot, TestRoot.child.parent === TestRoot],
    };
  `, { permissions: [defineHostGlobal(t, "TestRoot", root)] });
  assert.equal(sandbox.exports.read(), 0);
  counter.c = 1;
  assert.equal(sandbox.exports.read(), 1);
  assert.deepEqual([...sandbox.exports.identity()], [true, true]);
  assert.doesNotThrow(() => sandbox.dispose());
});

test("a host getter that returns a tracked object does not leak it", async () => {
  // Upstream Arena returned map-owned handles from host functions, which
  // quickjs-emscripten then disposed; the next read re-marshalled an unowned copy.
  const ctx = (await getQuickJS()).newContext();
  const arena = new Arena(ctx, { isMarshalable: true });
  const wrapper = {};
  Object.defineProperty(wrapper, "name", { get: () => "root", enumerable: true });
  Object.defineProperty(wrapper, "self", { get: () => wrapper, enumerable: true });
  arena.expose({ TestRoot: wrapper });
  assert.equal(arena.evalCode("TestRoot.self.self.name"), "root");
  assert.equal(arena.evalCode("TestRoot.self.self === TestRoot"), true);
  arena.dispose();
  assert.doesNotThrow(() => ctx.dispose());
});

test("memory-limited Arena disposes cleanly after out-of-memory on the call path", async () => {
  const ctx = (await getQuickJS()).newContext();
  const arena = new Arena(ctx, { isMarshalable: true });
  arena.setMemoryLimit(400 * 1024);
  const make = arena.evalCode(`globalThis.keep = []; (i) => { const o = { id: i, nested: { data: "x".repeat(1000), list: [1, 2, { deep: "y".repeat(300) }] } }; keep.push(o); return o; }`);
  const echo = arena.evalCode("(v) => { keep.push(v); return [v, { wrap: v }]; }");
  assert.throws(() => {
    for (let i = 0; i < 100000; i += 1) echo({ host: i, value: make(i) });
  }, /out of memory/);
  arena.dispose();
  assert.doesNotThrow(() => ctx.dispose());
});

test("an error result that cannot be converted under a memory limit is still disposed", async () => {
  // Mirrors upstream Arena's memory-limit test: the guest exhausts memory while
  // writing into a synced host object, so converting the thrown error fails too.
  const ctx = (await getQuickJS()).newContext();
  const arena = new Arena(ctx, { isMarshalable: true });
  arena.setMemoryLimit(200 * 1024);
  const data = arena.sync({ items: [] });
  arena.expose({ data });
  arena.evalCode("for (let i = 0; i < 10; i++) { data.items.push({ id: i }); }");
  assert.equal(data.items.length, 10);
  assert.throws(() => {
    arena.evalCode('for (let i = 0; i < 100000; i++) { data.items.push({ id: i, data: "x".repeat(1000) }); }');
  });
  arena.dispose();
  assert.doesNotThrow(() => ctx.dispose());
});
