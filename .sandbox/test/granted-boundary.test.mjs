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

test("writes to granted APIs stay inside the sandbox or fail; the host is unchanged", async (t) => {
  const capability = { secret: "kept", run: () => "host" };
  defineHostGlobal(t, "Capability", capability);
  const originalDateTimeFormat = Intl.DateTimeFormat;
  const originalNumberFormat = Intl.NumberFormat;
  const originalEncode = TextEncoder.prototype.encode;
  const { exports } = await createFixtureSandbox(t, LIBRARY_BODY, {
    permissions: ["Intl", "TextEncoder", "Capability"],
  });

  const inside = exports.patchGranted();
  // Writes to built-ins succeed against the sandbox's view of the capability;
  // the primitive write to the custom object fails (grants are read-only)...
  assert.deepEqual(inside, { assign: "ok", add: "ok", remove: "ok", prototype: "ok", custom: "threw" });
  // ...but the host objects behind the grant are untouched.
  assert.equal(Intl.DateTimeFormat, originalDateTimeFormat);
  assert.equal(Intl.NumberFormat, originalNumberFormat);
  assert.equal(Object.hasOwn(Intl, "__injected"), false);
  assert.equal(TextEncoder.prototype.encode, originalEncode);
  // Neither the function replacement nor the primitive write reaches the host.
  assert.equal(capability.run(), "host");
  assert.equal(capability.secret, "kept");
});

const CFG_PROBES = `
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
`;
const makeCfg = () => ({ flag: false, nested: { v: "orig" }, list: ["orig"], fn: () => "host" });
const hostState = (cfg) => ({ flag: cfg.flag, nested: cfg.nested.v, list: cfg.list[0], added: cfg.added, fn: cfg.fn() });

test("a granted object is read-only: no write from the sandbox reaches the host", async (t) => {
  const capability = makeCfg();
  defineHostGlobal(t, "Cfg", capability);
  const { exports } = await createFixtureSandbox(t, CFG_PROBES, { permissions: ["Cfg"] });
  // Additions and function replacements change only the sandbox's wrapper.
  assert.deepEqual(exports.run(), { flag: "threw", nested: "threw", list: "threw", added: "ok", object: "threw", fn: "ok", del: "threw" });
  assert.deepEqual(hostState(capability), { flag: false, nested: "orig", list: "orig", added: undefined, fn: "host" });
});

test("only the primitive writes the policy lists reach the host", async (t) => {
  const capability = makeCfg();
  defineHostGlobal(t, "Cfg", capability);
  const { exports } = await createFixtureSandbox(t, CFG_PROBES, {
    permissions: ["Cfg"],
    writable: { Cfg: ["flag", "nested.v", "nested"] },
  });
  // `nested` is writable but only with primitives; `list.0` is not listed.
  assert.deepEqual(exports.run(), { flag: "ok", nested: "ok", list: "threw", added: "ok", object: "threw", fn: "ok", del: "threw" });
  assert.deepEqual(hostState(capability), { flag: true, nested: "x", list: "orig", added: undefined, fn: "host" });
});

test("objects returned by a granted function are copied or read-only; writes never reach the host", async (t) => {
  // A DOM-like element: a class instance is wrapped, not copied.
  class HostImage { constructor() { this.src = ""; } }
  const made = [];
  defineHostGlobal(t, "makeImage", () => { const img = new HostImage(); made.push(img); return img; });
  defineHostGlobal(t, "makePlain", () => { const o = { src: "" }; made.push(o); return o; });
  const { exports } = await createFixtureSandbox(t, `
    const write = (o) => { try { o.src = "https://attacker.example/x"; return "ok:" + o.src; } catch (e) { return e.name; } };
    return { wrapped: () => write(makeImage()), plain: () => write(makePlain()) };
  `, { permissions: ["makeImage", "makePlain"] });
  assert.equal(exports.wrapped(), "TypeError");
  // Plain-data results are copied by value, so the write changes the sandbox's copy.
  assert.equal(exports.plain(), "ok:https://attacker.example/x");
  assert.deepEqual(made.map((o) => o.src), ["", ""]);
});

test("writable paths are validated when the sandbox is created", async (t) => {
  defineHostGlobal(t, "Cfg", makeCfg());
  defineHostGlobal(t, "cfgFactory", () => ({}));
  await assert.rejects(createFixtureSandbox(t, "return {};", { permissions: [], writable: { Cfg: ["flag"] } }), /not granted/);
  await assert.rejects(createFixtureSandbox(t, "return {};", { permissions: ["Cfg"], writable: { Cfg: ["missing"] } }), /does not name an existing property/);
  await assert.rejects(createFixtureSandbox(t, "return {};", { permissions: ["cfgFactory"], writable: { cfgFactory: ["x"] } }), /need an object grant/);
  await assert.rejects(createFixtureSandbox(t, "return {};", { permissions: ["crypto"], writable: { crypto: ["x"] } }), /no writable properties/);
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

test("known limit: methods of a granted object keep their authority under read-only grants", async (t) => {
  // Read-only grants close the property-write channel only. A granted method
  // that changes state (setAttribute on a DOM element) still does, so DOM
  // grants need method-level narrowing; see the paper's limitations.
  class HostElement {
    constructor() { this.attributes = {}; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  const element = new HostElement();
  defineHostGlobal(t, "el", element);
  const { exports } = await createFixtureSandbox(t, `
    return { run: () => {
      let direct;
      try { el.attributes = {}; direct = "ok"; } catch (e) { direct = e.name; }
      el.setAttribute("src", "https://attacker.example/x");
      return direct;
    } };
  `, { permissions: ["el"] });
  assert.equal(exports.run(), "TypeError");
  assert.equal(element.attributes.src, "https://attacker.example/x");
});
