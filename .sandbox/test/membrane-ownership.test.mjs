import assert from "node:assert/strict";
import test from "node:test";
import { SandboxManager } from "../core/sandbox-manager.js";
import { createJsonTransfer } from "../core/json-transfer.js";
import { createForwardMembrane } from "../membrane/forward-membrane.js";
import { createFixtureSandbox, defineHostGlobal, fixtureBundle, runIsolated } from "./helpers/fixture-sandbox.mjs";

// Membrane state is owned by each sandbox (issue #3). These cases grant one
// mutable host object to two sandboxes, or wrap one host value in both, and
// check that neither sandbox can reach the other through a shared wrapper.

const SHARED_BODY = `
  return {
    mark: (value) => { TestShared.marker = value; },
    readMark: () => typeof TestShared.marker === "undefined" ? null : TestShared.marker,
    hijackDescribe: (label) => {
      TestShared.describe = (...args) => { globalThis.intercepted = args; return label; };
    },
    describe: (...args) => TestShared.describe(...args),
    intercepted: () => globalThis.intercepted ?? null,
    setMode: (mode) => { TestShared.mode = mode; },
    readMode: () => TestShared.mode,
    childIdentity: () => TestShared.child === TestShared.child,
    rootIdentity: () => TestShared.child.parent === TestShared,
    plantInHost: (label) => { TestShared.mode = () => { globalThis.intercepted = [label]; return label; }; },
    callHostMode: () => typeof TestShared.mode === "function" ? TestShared.mode() : null,
  };
`;

/** Host class whose instances the reverse membrane pins when wrapped. */
class HostToken {
  label() {
    return "token";
  }
}

/**
 * Creates the mutable host object granted to every sandbox in a case.
 *
 * @returns {object} Host capability with data, a method, and a nested object.
 */
function createSharedHostObject() {
  const shared = {
    mode: "a",
    describe() {
      return `host:${this.mode}`;
    },
  };
  shared.child = { name: "child", parent: shared };
  return shared;
}

/**
 * Grants one host object to a test and returns a factory for sandboxes that
 * receive it, so cases can create siblings before or after a mutation.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {object} shared Host object exposed as `TestShared`.
 * @returns {(libraryName: string) => Promise<object>} Sandbox factory.
 */
function grantShared(t, shared) {
  const permission = defineHostGlobal(t, "TestShared", shared);
  return (libraryName) => createFixtureSandbox(t, SHARED_BODY, { libraryName, permissions: [permission] });
}

test("a method one sandbox replaces on a shared host object is never run by a later sibling", async (t) => {
  // Reproducer: with a process-wide wrapper cache, the second sandbox received
  // the wrapper the first had modified, so its call ran the first sandbox's
  // QuickJS function and handed it the second sandbox's arguments.
  const create = grantShared(t, createSharedHostObject());
  const first = await create("first");
  first.exports.hijackDescribe("hijacked-by-first");
  assert.equal(first.exports.describe(), "hijacked-by-first");

  const second = await create("second");
  assert.equal(second.exports.describe("secret-from-second"), "host:a");
  assert.deepEqual(first.exports.intercepted(), []);
});

test("a method one sandbox replaces on a shared host object stays native in an existing sibling", async (t) => {
  const create = grantShared(t, createSharedHostObject());
  const first = await create("first");
  const second = await create("second");
  first.exports.hijackDescribe("hijacked-by-first");
  assert.equal(second.exports.describe("secret-from-second"), "host:a");
  assert.equal(first.exports.intercepted(), null);
});

test("a property one sandbox adds to a shared host object is invisible to its siblings", async (t) => {
  const shared = createSharedHostObject();
  const create = grantShared(t, shared);
  const first = await create("first");
  const existing = await create("existing");
  first.exports.mark("from-first");
  const later = await create("later");
  assert.equal(first.exports.readMark(), "from-first");
  assert.equal(existing.exports.readMark(), null);
  assert.equal(later.exports.readMark(), null);
  assert.equal(Object.hasOwn(shared, "marker"), false);
});

test("a shared capability keeps working in a sandbox after its sibling is disposed", async (t) => {
  const create = grantShared(t, createSharedHostObject());
  const first = await create("first");
  first.exports.hijackDescribe("hijacked-by-first");
  first.dispose();
  const second = await create("second");
  assert.equal(second.exports.describe(), "host:a");
});

test("writes to existing data properties of a shared host object still reach the host", async (t) => {
  // Separate wrappers do not copy host state: a granted mutable host object is
  // still one object, so its data properties are visible to every grantee.
  const shared = createSharedHostObject();
  const create = grantShared(t, shared);
  const first = await create("first");
  const second = await create("second");
  first.exports.setMode("b");
  assert.equal(shared.mode, "b");
  assert.equal(second.exports.readMode(), "b");
  assert.equal(second.exports.describe(), "host:b");
});

test("a function one sandbox writes into a shared host property is not callable by a sibling", {
  todo: "data-property writes go through to the host object, so a sibling granted the same object reads the planted function",
}, async (t) => {
  const create = grantShared(t, createSharedHostObject());
  const first = await create("first");
  const second = await create("second");
  first.exports.plantInHost("planted-by-first");
  assert.equal(second.exports.callHostMode(), null);
  assert.equal(first.exports.intercepted(), null);
});

test("repeated references to a shared host object keep identity within each sandbox", async (t) => {
  const create = grantShared(t, createSharedHostObject());
  const first = await create("first");
  const second = await create("second");
  for (const sandbox of [first, second, first]) {
    assert.equal(sandbox.exports.childIdentity(), true);
    assert.equal(sandbox.exports.rootIdentity(), true);
  }
});

test("forward membranes give each sandbox its own wrapper for one host object", () => {
  const shared = createSharedHostObject();
  const first = createForwardMembrane();
  const second = createForwardMembrane();
  const wrapper = first.bindWebApi(shared);
  assert.notEqual(second.bindWebApi(shared), wrapper);
  assert.equal(first.bindWebApi(shared), wrapper);
  assert.equal(wrapper.child.parent, wrapper);
  wrapper.describe = () => "replaced";
  assert.equal(second.bindWebApi(shared).describe(), "host:a");
});

test("a disposed forward membrane rejects further binding and calls", () => {
  const membrane = createForwardMembrane();
  const host = { value: 1, read() { return this.value; } };
  const wrapper = membrane.bindWebApi(host);
  membrane.dispose();
  for (const use of [() => membrane.bindWebApi(host), () => wrapper.read(), () => { wrapper.value = 2; }]) {
    assert.throws(use, { message: /sandbox has been disposed/ });
  }
  assert.equal(host.value, 1);
});

test("a by-value transfer offer is consumed only by the sandbox that made it", () => {
  const first = createJsonTransfer();
  const second = createJsonTransfer();
  const result = { list: [1, 2] };
  first.offer(result);
  assert.equal(second.take(result), false);
  assert.equal(first.take(result), true);
  assert.equal(first.take(result), false);
});

test("two sandboxes wrapping the same host value receive distinct reverse wrappers", async (t) => {
  const token = new HostToken();
  const first = await createFixtureSandbox(t, "return {};", { libraryName: "first" });
  const second = await createFixtureSandbox(t, "return {};", { libraryName: "second" });
  const fromFirst = first.wrapResult(token);
  const fromSecond = second.wrapResult(token);
  assert.notEqual(fromFirst, fromSecond);
  assert.equal(first.wrapResult(token), fromFirst);
  assert.equal(second.wrapResult(token), fromSecond);
});

test("a reverse wrapper keeps calling its own sandbox after a sibling is disposed", async (t) => {
  // Reproducer: the second wrapper was the first sandbox's cached proxy, so
  // its calls failed with "Lifetime not alive" once the first was disposed.
  const token = new HostToken();
  const first = await createFixtureSandbox(t, "return {};", { libraryName: "first" });
  const second = await createFixtureSandbox(t, "return {};", { libraryName: "second" });
  first.wrapResult(token);
  const fromSecond = second.wrapResult(token);
  first.dispose();
  assert.equal(fromSecond.label(), "token");
  assert.equal(second.wrapResult(token).label(), "token");
});

test("temporary-object identifiers are allocated per sandbox", async (t) => {
  // Identifiers are visible inside QuickJS through __SANDBOX_TEMP__, so a
  // process-wide counter revealed how many objects other sandboxes pinned.
  const body = "return { make: () => new (class Item {})(), ids: () => [...globalThis.__SANDBOX_TEMP__.keys()] };";
  const first = await createFixtureSandbox(t, body, { libraryName: "first" });
  const second = await createFixtureSandbox(t, body, { libraryName: "second" });
  first.exports.make();
  first.exports.make();
  second.exports.make();
  assert.deepEqual(first.exports.ids(), [0, 1]);
  assert.deepEqual(second.exports.ids(), [0]);
});

test("reverse wrappers and boundary helpers fail closed once their sandbox is disposed", async () => {
  const sandbox = await SandboxManager.createSandbox(
    "fixture",
    fixtureBundle("class Item { name() { return 'item'; } } return { Item, make: () => new Item(), ping: () => 'pong' };"),
    { permissions: [] },
  );
  const { exports } = sandbox;
  const item = exports.make();
  const ping = exports.ping;
  sandbox.dispose();
  for (const use of [
    () => ping(),
    () => item.name(),
    () => exports.make,
    () => sandbox.wrapResult(new HostToken()),
    () => sandbox.createInstance("Item", []),
  ]) {
    assert.throws(use, { message: /sandbox has been disposed/ });
  }
});

test("disposal releases reverse wrappers for host values that outlive the sandbox", () => {
  // The host keeps both the sandbox and the wrapped value alive, as a
  // generated proxy module does, so only the membrane can release the wrapper.
  const result = runIsolated(`
    const finalized = new Set();
    const registry = new FinalizationRegistry((label) => finalized.add(label));
    const token = { label() { return "token"; } };
    Object.setPrototypeOf(token, { kind: "host" });
    const create = () => SandboxManager.createSandbox("fixture", fixtureBundle("return {};"), { permissions: [] });
    const kept = await create();
    const released = await create();
    registry.register(kept.wrapResult(token), "kept");
    registry.register(released.wrapResult(token), "released");
    released.dispose();
    for (let i = 0; i < 10 && !finalized.has("released"); i += 1) {
      globalThis.gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log(JSON.stringify({ kept: finalized.has("kept"), released: finalized.has("released") }));
    kept.dispose();
  `, { execArgv: ["--expose-gc"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { kept: false, released: true });
});

test("a disposed sandbox is collectable while host values it wrapped stay alive", () => {
  const result = runIsolated(`
    let collected = false;
    const registry = new FinalizationRegistry(() => { collected = true; });
    const token = { label() { return "token"; } };
    Object.setPrototypeOf(token, { kind: "host" });
    globalThis.TestShared = { mode: "a", child: {} };
    await (async () => {
      const sandbox = await SandboxManager.createSandbox(
        "fixture",
        fixtureBundle("return { read: () => TestShared.child && TestShared.mode };"),
        { permissions: ["TestShared"] },
      );
      sandbox.exports.read();
      sandbox.wrapResult(token);
      registry.register(sandbox.arena, "arena");
      sandbox.dispose();
    })();
    for (let i = 0; i < 10 && !collected; i += 1) {
      globalThis.gc();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    console.log(JSON.stringify({ collected, tokenAlive: token.label() === "token" }));
  `, { execArgv: ["--expose-gc"] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)), { collected: true, tokenAlive: true });
});
