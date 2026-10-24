import assert from "node:assert/strict";
import test from "node:test";
import { getQuickJS } from "quickjs-emscripten";
import { createArenaConfig } from "../marshallers/index.js";
import { createFixtureSandbox } from "./helpers/fixture-sandbox.mjs";

const TYPED_ARRAY_KINDS = [
  ["Int8Array", [-1, 2, 3]],
  ["Uint8Array", [1, 2, 255]],
  ["Uint8ClampedArray", [0, 128, 255]],
  ["Int16Array", [-300, 2, 3]],
  ["Uint16Array", [1, 2, 65535]],
  ["Int32Array", [-70000, 2, 3]],
  ["Uint32Array", [1, 2, 4294967295]],
  ["Float32Array", [1.5, -2.25, 3]],
  ["Float64Array", [Math.PI, -0.5, 1e300]],
  ["BigInt64Array", [-1n, 2n, 3n]],
  ["BigUint64Array", [1n, 2n, 18446744073709551615n]],
];

const LIBRARY_BODY = `
  return {
    describeView: (view) => [view.constructor.name, Array.from(view, String)],
    doubleBytes: (bytes) => bytes.map((b) => b * 2),
    mutate: (bytes) => { bytes[0] = 99; return bytes[0]; },
    window: () => new Uint8Array([0, 1, 2, 3, 4, 5]).subarray(2, 5),
    pattern: () => /a+b/gi,
    describePattern: (re) => [re instanceof RegExp, re.source, re.flags, re.test("AAB")],
    echo: (value) => value,
    describeArguments: (args) => [args.length, args[0], args[1]],
    nativeArguments: function () { return arguments; },
    describeError: (error) => [error instanceof RangeError, error.name, error.message, error.path],
    makeError: (name, message) => {
      const error = new globalThis[name](message);
      error.path = "user.email";
      error.params = { min: 3 };
      return error;
    },
    aggregate: () => new AggregateError([new TypeError("inner")], "many"),
    custom: () => {
      class ValidationError extends Error {
        constructor(message) { super(message); this.name = "ValidationError"; this.path = "a"; this.unlisted = "x"; }
      }
      return new ValidationError("bad");
    },
    cyclic: () => { const error = new TypeError("cyclic"); error.value = {}; error.value.self = error.value; error.inner = error; return error; },
    large: () => { const error = new TypeError("large"); error.errors = Array.from({ length: 150 }, (_, i) => i); return error; },
    thrown: () => { const error = new RangeError("boom"); error.path = "a.b"; throw error; },
    withCause: () => new Error("outer", { cause: new Error("root") }),
    map: () => new Map([["a", 1]]),
    set: () => new Set([1, 2]),
    dataView: () => new DataView(new ArrayBuffer(4)),
    describeDataView: (view) => view instanceof DataView,
  };
`;

test("all four marshallers are registered and claim their host types", async () => {
  const qjs = await getQuickJS();
  const vm = qjs.newContext();
  const { arenaOptions, dispose } = createArenaConfig(vm);
  try {
    assert.equal(arenaOptions.customMarshaller.length, 4);
    assert.equal(arenaOptions.customUnmarshaller.length, 4);
    const args = (function () { return arguments; })(1);
    for (const value of [new Uint8Array(1), /x/, args, new Error("e")]) {
      assert.equal(arenaOptions.isWrappable(value), false, Object.prototype.toString.call(value));
    }
    assert.equal(arenaOptions.isWrappable({}), true);
  } finally {
    dispose();
    vm.dispose();
  }
});

test("typed arrays of every kind cross into QuickJS with their type and values", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  for (const [kind, values] of TYPED_ARRAY_KINDS) {
    const view = new globalThis[kind](values);
    assert.deepEqual(exports.describeView(view), [kind, values.map(String)], kind);
  }
});

test("typed arrays of every kind return to the host as real views", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  for (const [kind, values] of TYPED_ARRAY_KINDS) {
    const result = exports.echo(new globalThis[kind](values));
    assert.ok(result instanceof globalThis[kind], kind);
    assert.deepEqual(Array.from(result), values, kind);
  }
});

test("only the visible bytes of an offset view cross the boundary", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const backing = new Uint8Array([9, 8, 7, 6, 5]);
  assert.deepEqual(exports.describeView(new Uint8Array(backing.buffer, 1, 3)), ["Uint8Array", ["8", "7", "6"]]);
  const window = exports.window();
  assert.deepEqual([...window], [2, 3, 4]);
  assert.equal(window.buffer.byteLength, 3);
});

test("typed arrays are copied, so QuickJS mutations do not reach the host view", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const bytes = new Uint8Array([1, 2]);
  assert.equal(exports.mutate(bytes), 99);
  assert.equal(bytes[0], 1);
  assert.deepEqual([...exports.doubleBytes(new Uint8Array([1, 2]))], [2, 4]);
});

test("RegExp source and flags survive both directions", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.deepEqual(exports.describePattern(/a+b/gi), [true, "a+b", "gi", true]);
  const pattern = exports.pattern();
  assert.ok(pattern instanceof RegExp);
  assert.equal(pattern.source, "a+b");
  assert.equal(pattern.flags, "gi");
});

test("host arguments objects cross into QuickJS and return with Arguments identity", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const viaArguments = function () { return [exports.describeArguments(arguments), exports.echo(arguments)]; };
  const [described, echoed] = viaArguments(1, "x");
  assert.deepEqual(described, [2, 1, "x"]);
  assert.equal(Object.prototype.toString.call(echoed), "[object Arguments]");
  assert.deepEqual([...echoed], [1, "x"]);
});

test("native QuickJS arguments objects return with Arguments identity", {
  todo: "only host-originated arguments are tagged; QuickJS arguments arrive as plain objects",
}, async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(Object.prototype.toString.call(exports.nativeArguments(1, 2)), "[object Arguments]");
});

test("host errors cross into QuickJS with their subclass and listed fields", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const error = new RangeError("out of range");
  error.path = "items[0]";
  assert.deepEqual(exports.describeError(error), [true, "RangeError", "out of range", "items[0]"]);
});

test("returned errors keep their built-in subclass and listed fields", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  for (const name of ["Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError"]) {
    const error = exports.makeError(name, `${name} message`);
    assert.ok(error instanceof globalThis[name], name);
    assert.equal(error.name, name);
    assert.equal(error.message, `${name} message`);
    assert.equal(error.path, "user.email");
    assert.deepEqual(error.params, { min: 3 });
  }
});

test("returned AggregateErrors keep their nested errors as copied payloads", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const error = exports.aggregate();
  assert.ok(error instanceof AggregateError);
  assert.equal(error.message, "many");
  assert.equal(error.errors.length, 1);
  assert.equal(error.errors[0].name, "TypeError");
  assert.equal(error.errors[0].message, "inner");
});

test("custom error subclasses keep their name but only listed fields", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const error = exports.custom();
  assert.ok(error instanceof Error);
  assert.equal(error.name, "ValidationError");
  assert.equal(error.path, "a");
  assert.equal(error.unlisted, undefined);
});

test("cyclic and oversized error fields are bounded", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const cyclic = exports.cyclic();
  assert.equal(cyclic.message, "cyclic");
  assert.equal(typeof cyclic.inner, "object");
  assert.equal(exports.large().errors.length, 100);
});

test("thrown QuickJS errors reach the host with name, message and fields", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.throws(() => exports.thrown(), (error) => {
    assert.equal(error.name, "RangeError");
    assert.equal(error.message, "boom");
    assert.equal(error.path, "a.b");
    return true;
  });
});

test("thrown QuickJS errors are instances of the host subclass", {
  todo: "thrown errors surface as QuickJSUnwrapError; only returned errors are reconstructed",
}, async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.throws(() => exports.thrown(), RangeError);
});

test("Error.cause crosses the boundary", {
  todo: "cause is not in the marshaller's copied field list (spec §8)",
}, async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(exports.withCause().cause?.message, "root");
});

test("returned Map and Set objects are usable on the host", {
  todo: "no collection marshaller is registered; spec §8 lists Map and Set as known boundaries",
}, async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(exports.map().get("a"), 1);
  assert.equal(exports.set().has(2), true);
});

test("DataView keeps its identity across the boundary", {
  todo: "DataView is not claimed by a marshaller; spec §8 lists it as a known boundary",
}, async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.ok(exports.dataView() instanceof DataView);
  assert.equal(exports.describeDataView(new DataView(new ArrayBuffer(4))), true);
});
