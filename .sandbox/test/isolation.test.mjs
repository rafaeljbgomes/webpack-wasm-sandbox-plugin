import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSandbox } from "./helpers/fixture-sandbox.mjs";

const LIBRARY_BODY = `
  return {
    pollute: () => {
      Object.prototype.polluted = "yes";
      Array.prototype.arrayPolluted = "yes";
      Function.prototype.functionPolluted = "yes";
      globalThis.leaked = "yes";
      return { a: 1 };
    },
    observe: () => [({}).polluted ?? null, [].arrayPolluted ?? null, typeof globalThis.leaked],
    list: () => [1, 2],
    reachHostFunction: (callback) => attempt(() => callback.constructor("return typeof process")()),
    reachHostObject: (value) => attempt(() => value.constructor.constructor("return typeof process")()),
    reachHostPrototype: (value) => attempt(() => Object.getPrototypeOf(value).constructor.constructor("return typeof process")()),
  };
  function attempt(fn) {
    try { return fn(); } catch (error) { return "threw"; }
  }
`;

test("prototype pollution inside QuickJS does not reach host prototypes", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  exports.pollute();
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.equal(Object.hasOwn(Array.prototype, "arrayPolluted"), false);
  assert.equal(Object.hasOwn(Function.prototype, "functionPolluted"), false);
  assert.equal(Object.hasOwn(globalThis, "leaked"), false);
});

test("values returned after pollution carry no polluted properties", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const result = exports.pollute();
  assert.equal("polluted" in result, false);
  assert.equal("arrayPolluted" in exports.list(), false);
});

test("pollution in one sandbox is invisible to another sandbox", async (t) => {
  const first = await createFixtureSandbox(t, LIBRARY_BODY, { libraryName: "first" });
  const second = await createFixtureSandbox(t, LIBRARY_BODY, { libraryName: "second" });
  first.exports.pollute();
  assert.deepEqual(first.exports.observe(), ["yes", "yes", "string"]);
  assert.deepEqual(second.exports.observe(), [null, null, "undefined"]);
});

test("host callbacks do not expose the host Function constructor", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(exports.reachHostFunction(() => 1), "undefined");
});

test("host objects passed as arguments do not expose the host Function constructor", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  assert.equal(exports.reachHostObject({ a: 1 }), "undefined");
  assert.equal(exports.reachHostPrototype({ a: 1 }), "undefined");
});
