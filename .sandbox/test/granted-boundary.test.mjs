import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureSandbox, defineHostGlobal } from "./helpers/fixture-sandbox.mjs";

// Adversarial probes against what a library CAN reach: the APIs it was
// granted, the arguments it receives, and the callbacks it is handed. The
// isolation tests cover ungranted authority; these cover the granted surface.

const LIBRARY_BODY = `
  function attempt(fn) { try { fn(); return "ok"; } catch (error) { return "threw"; } }
  return {
    patchGranted: () => ({
      assign: attempt(() => { Intl.DateTimeFormat = function () { return "pwned"; }; }),
      add: attempt(() => { Intl.__injected = 1; }),
      remove: attempt(() => { delete Intl.NumberFormat; }),
      prototype: attempt(() => { TextEncoder.prototype.encode = () => "pwned"; }),
      custom: attempt(() => { Capability.secret = "stolen"; Capability.run = () => "pwned"; }),
    }),
    mutateArgument: (o) => {
      o.added = "from-sandbox";
      o.nested.value = "changed";
      delete o.removeMe;
      try { o.__proto__.polluted = "yes"; } catch (error) {}
    },
    tagCallback: (cb) => { cb.injected = 1; return cb(); },
  };
`;

test("writes to granted built-in APIs stay inside the sandbox; custom objects accept primitive writes", async (t) => {
  const capability = { secret: "kept", run: () => "host" };
  defineHostGlobal(t, "Capability", capability);
  const originalDateTimeFormat = Intl.DateTimeFormat;
  const originalNumberFormat = Intl.NumberFormat;
  const originalEncode = TextEncoder.prototype.encode;
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY, {
    permissions: ["Intl", "TextEncoder", "Capability"],
  });

  const inside = exports.patchGranted();
  // The writes succeed against the sandbox's view of the capability...
  assert.deepEqual(inside, { assign: "ok", add: "ok", remove: "ok", prototype: "ok", custom: "ok" });
  // ...but the host objects behind the grant are untouched.
  assert.equal(Intl.DateTimeFormat, originalDateTimeFormat);
  assert.equal(Intl.NumberFormat, originalNumberFormat);
  assert.equal(Object.hasOwn(Intl, "__injected"), false);
  assert.equal(TextEncoder.prototype.encode, originalEncode);
  // Function replacement does not write through.
  assert.equal(capability.run(), "host");
  // Primitive writes to existing data properties DO write through by design
  // (forward-membrane.js: assertInertHostValue). A grant therefore conveys
  // read access plus primitive write access to the granted object's state.
  assert.equal(capability.secret, "stolen");
});

test("only primitive writes to existing properties of a granted object reach the host", async (t) => {
  const capability = { flag: false, nested: { v: "orig" }, list: ["orig"], fn: () => "host" };
  defineHostGlobal(t, "Cfg", capability);
  const { exports } = await createFixtureSandbox(t, `
    function attempt(fn) { try { fn(); return "ok"; } catch (error) { return "threw"; } }
    return { run: () => ({
      flag: attempt(() => { Cfg.flag = true; }),
      nested: attempt(() => { Cfg.nested.v = "x"; }),
      list: attempt(() => { Cfg.list[0] = "x"; }),
      added: attempt(() => { Cfg.added = "x"; }),
      object: attempt(() => { Cfg.nested = { v: "evil" }; }),
      fn: attempt(() => { Cfg.fn = () => "pwned"; }),
      del: attempt(() => { delete Cfg.flag; }),
    }) };
  `, { permissions: ["Cfg"] });
  const inside = exports.run();
  assert.deepEqual(inside, { flag: "ok", nested: "ok", list: "ok", added: "ok", object: "threw", fn: "ok", del: "threw" });
  assert.deepEqual(
    { flag: capability.flag, nested: capability.nested.v, list: capability.list[0], added: capability.added, fn: capability.fn() },
    { flag: true, nested: "x", list: "x", added: undefined, fn: "host" },
  );
});

test("mutations of arguments inside the sandbox are not reflected on host objects", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  const argument = { nested: { value: "orig" }, removeMe: true };
  exports.mutateArgument(argument);
  assert.deepEqual(argument, { nested: { value: "orig" }, removeMe: true });
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
});

test("properties set on a host callback inside the sandbox do not reach the host function", async (t) => {
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY);
  function hostCallback() { return 7; }
  assert.equal(exports.tagCallback(hostCallback), 7);
  assert.equal(Object.hasOwn(hostCallback, "injected"), false);
});
