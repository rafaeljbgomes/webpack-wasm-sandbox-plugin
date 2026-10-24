import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "../core/sandbox-manager.js";
import { createFixtureSandbox, createFixtureSandboxSync, fixtureBundle } from "./helpers/fixture-sandbox.mjs";

const hookUrl = new URL("./helpers/register-runtime-aliases.mjs", import.meta.url).href;
const managerUrl = new URL("../core/sandbox-manager.js", import.meta.url).href;
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Runs an ES module snippet in a fresh Node.js process so process-wide state
 * (the shared QuickJS module, event-loop handles) starts empty.
 *
 * @param {string} source Module source; `SandboxManager` and `fixtureBundle` are in scope.
 * @returns {{status: number|null, stdout: string, stderr: string}} Process outcome.
 */
function runIsolated(source) {
  const prelude = [
    `import { SandboxManager } from ${JSON.stringify(managerUrl)};`,
    `const fixtureBundle = ${fixtureBundle.toString()};`,
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    ["--import", hookUrl, "--input-type=module", "-e", `${prelude}\n${source}`],
    { cwd: projectRoot, encoding: "utf8", timeout: 30_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("asynchronous creation evaluates the bundle and binds its exports", async (t) => {
  const sandbox = await createFixtureSandbox(t, "return { add: (a, b) => a + b, label: 'fixture' };");
  assert.equal(sandbox.exports.add(2, 3), 5);
  assert.equal(sandbox.exports.label, "fixture");
});

test("synchronous creation works once the shared QuickJS module is loaded", async (t) => {
  const sandbox = await createFixtureSandboxSync(t, "return { twice: (x) => x * 2 };");
  assert.equal(sandbox.exports.twice(21), 42);
});

test("synchronous creation fails before the shared QuickJS module is loaded", () => {
  const result = runIsolated(`
    try {
      SandboxManager.createSandboxSync("fixture", fixtureBundle("return {};"), { permissions: [] });
      console.log("created");
    } catch (error) {
      console.log("rejected:" + error.message);
    }
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rejected:QuickJS not initialized/);
});

test("each sandbox owns a separate QuickJS context", async (t) => {
  const body = "return { mark: (v) => { globalThis.mark = v; }, read: () => globalThis.mark };";
  const first = await createFixtureSandbox(t, body);
  const second = await createFixtureSandbox(t, body);
  assert.notEqual(first.vm, second.vm);
  first.exports.mark("first");
  assert.equal(first.exports.read(), "first");
  assert.equal(second.exports.read(), undefined);
});

test("sandbox Promises resolve through the referenced job pump", async (t) => {
  const sandbox = await createFixtureSandbox(t, `
    return {
      later: (x) => Promise.resolve(x).then((v) => v * 3),
      chained: async (x) => { const a = await Promise.resolve(x); const b = await Promise.resolve(a + 1); return b; },
    };
  `);
  assert.equal(await sandbox.exports.later(5), 15);
  assert.equal(await sandbox.exports.chained(1), 2);
});

/**
 * Awaits a rejected sandbox Promise in a child process and reports what the
 * caller caught and which host unhandled rejections were raised.
 *
 * @returns {{caught: string|null, unhandled: string[]}} Observed outcome.
 */
function observeAwaitedRejection() {
  const result = runIsolated(`
    const unhandled = [];
    process.on("unhandledRejection", (reason) => unhandled.push(String(reason)));
    const sandbox = await SandboxManager.createSandbox(
      "fixture",
      fixtureBundle("return { fail: () => Promise.reject(new TypeError('denied')) };"),
      { permissions: [] },
    );
    let caught = null;
    try { await sandbox.exports.fail(); } catch (error) { caught = error.message; }
    await new Promise((resolve) => setTimeout(resolve, 50));
    sandbox.dispose();
    console.log(JSON.stringify({ caught, unhandled }));
  `);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

test("sandbox Promise rejections reach the awaiting host caller", () => {
  assert.equal(observeAwaitedRejection().caught, "denied");
});

test("an awaited sandbox rejection raises no host unhandledRejection", {
  todo: "each rejected sandbox Promise also emits a host unhandledRejection, which crashes Node.js under the default mode",
}, () => {
  assert.deepEqual(observeAwaitedRejection().unhandled, []);
});

test("disposal releases the context so later calls fail", async () => {
  const sandbox = await SandboxManager.createSandbox("fixture", fixtureBundle("return { ping: () => 'pong' };"), {
    permissions: [],
  });
  const ping = sandbox.exports.ping;
  assert.equal(ping(), "pong");
  sandbox.dispose();
  assert.equal(sandbox.vm.alive, false);
  assert.throws(() => ping());
});

test("disposal clears the job pump so Node.js can exit", () => {
  const result = runIsolated(`
    const sandbox = await SandboxManager.createSandbox(
      "fixture",
      fixtureBundle("return { ping: () => 'pong' };"),
      { permissions: [] },
    );
    sandbox.exports.ping();
    sandbox.dispose();
    console.log("disposed");
  `);
  // A leaked interval would keep the child alive until the spawn timeout.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /disposed/);
});

test("disposal succeeds after every registered marshaller has produced handles", () => {
  const result = runIsolated(`
    const sandbox = await SandboxManager.createSandbox(
      "fixture",
      fixtureBundle(\`return {
        bytes: (u8) => new Uint8Array(u8),
        pattern: () => /a+/gi,
        error: () => new RangeError("r"),
        args: function () { return arguments; },
      };\`),
      { permissions: [] },
    );
    sandbox.exports.bytes(new Uint8Array([1, 2]));
    sandbox.exports.pattern();
    sandbox.exports.error();
    sandbox.exports.args(1, 2);
    sandbox.dispose();
    console.log("disposed");
  `);
  // QuickJS aborts in JS_FreeRuntime when a marshaller leaks a handle.
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /disposed/);
});

test("after unrefPump(), sandbox Promises resolve while another handle keeps Node.js alive", () => {
  const result = runIsolated(`
    const sandbox = await SandboxManager.createSandbox(
      "fixture",
      fixtureBundle("return { later: (x) => Promise.resolve(x * 2) };"),
      { permissions: [] },
    );
    sandbox.unrefPump();
    const keepAlive = setInterval(() => {}, 1000);
    console.log("value:" + await sandbox.exports.later(4));
    clearInterval(keepAlive);
    sandbox.dispose();
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /value:8/);
});

test("after unrefPump(), a pending sandbox Promise alone does not keep Node.js alive", () => {
  // Characterises ADR 10: generated Node.js proxies unref the pump after
  // initialization, so awaiting sandbox work needs another live handle.
  const result = runIsolated(`
    const sandbox = await SandboxManager.createSandbox(
      "fixture",
      fixtureBundle("return { later: (x) => Promise.resolve(x * 2) };"),
      { permissions: [] },
    );
    sandbox.unrefPump();
    console.log("value:" + await sandbox.exports.later(4));
  `);
  assert.equal(result.status, 13, result.stderr);
  assert.doesNotMatch(result.stdout, /value:/);
  assert.match(result.stderr, /unsettled top-level await/i);
});

test("repeated dispose() is a no-op", { todo: "second dispose() currently throws QuickJSUseAfterFree" }, async () => {
  const sandbox = await SandboxManager.createSandbox("fixture", fixtureBundle("return {};"), { permissions: [] });
  sandbox.dispose();
  assert.doesNotThrow(() => sandbox.dispose());
});
