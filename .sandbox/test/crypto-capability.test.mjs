import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSandbox } from "./helpers/fixture-sandbox.mjs";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Creates a sandbox granted the constrained crypto capability.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} body Fixture body.
 * @returns {Promise<object>} Sandbox runtime.
 */
function createCryptoSandbox(t, body) {
  return createFixtureSandbox(t, body, { permissions: ["crypto"] });
}

/** Fixture that fills a QuickJS-created target and reports "ok" or the error name. */
const FILL_BODY = `
  const targets = {
    Float32Array: () => new Float32Array(4),
    Float64Array: () => new Float64Array(4),
    DataView: () => new DataView(new ArrayBuffer(4)),
    number: () => 5,
    plainObject: () => ({ length: 4 }),
    null: () => null,
  };
  const attempt = (target) => {
    try { crypto.getRandomValues(target); return "ok"; } catch (e) { return e.name; }
  };
  return {
    fillKind: (name) => attempt(new globalThis[name](4)),
    fillTarget: (name) => attempt(targets[name]()),
  };
`;

test("the facade is a null-prototype object with only the supported methods", async (t) => {
  const sandbox = await createCryptoSandbox(t, `
    return { shape: () => [Object.getPrototypeOf(crypto) === null, Object.keys(crypto).sort(), typeof crypto.subtle] };
  `);
  assert.deepEqual(sandbox.exports.shape(), [true, ["getRandomValues", "randomUUID"], "undefined"]);
});

test("the facade is also reachable as self.crypto", async (t) => {
  const sandbox = await createCryptoSandbox(t, "return { same: () => self.crypto === crypto };");
  assert.equal(sandbox.exports.same(), true);
});

test("getRandomValues fills and returns the same view", async (t) => {
  const sandbox = await createCryptoSandbox(t, `
    return {
      fill: () => {
        const view = new Uint8Array(16);
        const returned = crypto.getRandomValues(view);
        const other = crypto.getRandomValues(new Uint8Array(16));
        return [returned === view, Array.from(view).join() !== Array.from(other).join()];
      },
    };
  `);
  assert.deepEqual(sandbox.exports.fill(), [true, true]);
});

test("getRandomValues writes only inside the view's byte range", async (t) => {
  const sandbox = await createCryptoSandbox(t, `
    return {
      fill: () => {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes.subarray(8, 16));
        return [bytes.slice(0, 8).every((b) => b === 0), bytes.slice(16).every((b) => b === 0)];
      },
    };
  `);
  assert.deepEqual(sandbox.exports.fill(), [true, true]);
});

test("getRandomValues accepts every integer typed array", async (t) => {
  const sandbox = await createCryptoSandbox(t, FILL_BODY);
  for (const kind of ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "BigInt64Array", "BigUint64Array"]) {
    assert.equal(sandbox.exports.fillKind(kind), "ok", kind);
  }
});

test("getRandomValues rejects non-integer views and non-views with TypeError", async (t) => {
  const sandbox = await createCryptoSandbox(t, FILL_BODY);
  for (const target of ["Float32Array", "Float64Array", "DataView", "number", "plainObject", "null"]) {
    assert.equal(sandbox.exports.fillTarget(target), "TypeError", target);
  }
});

test("getRandomValues enforces the 65,536-byte quota", async (t) => {
  const sandbox = await createCryptoSandbox(t, `
    return {
      sizes: () => [65536, 65537].map((n) => {
        try { crypto.getRandomValues(new Uint8Array(n)); return "ok"; } catch (e) { return e.name; }
      }),
    };
  `);
  assert.deepEqual(sandbox.exports.sizes(), ["ok", "QuotaExceededError"]);
});

test("randomUUID returns a version 4 UUID", async (t) => {
  const sandbox = await createCryptoSandbox(t, "return { uuid: () => crypto.randomUUID() };");
  assert.match(sandbox.exports.uuid(), UUID_V4);
});
