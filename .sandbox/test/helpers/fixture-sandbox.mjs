/**
 * Builds sandboxes from inline fixture libraries for unit tests.
 *
 * Fixtures use the same `var __SANDBOXED_LIB__ = ...` contract that the
 * Webpack child compiler emits, so the real runtime is exercised without
 * bundling, `dist/`, or upstream suites.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getQuickJS } from "quickjs-emscripten";
import { SandboxManager } from "../../core/sandbox-manager.js";

const hookUrl = new URL("./register-runtime-aliases.mjs", import.meta.url).href;
const managerUrl = new URL("../../core/sandbox-manager.js", import.meta.url).href;
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Wraps a fixture body in the child-bundle global contract.
 *
 * @param {string} body Statements ending in `return <exports>;`.
 * @returns {string} Library source that defines `__SANDBOXED_LIB__`.
 */
export function fixtureBundle(body) {
  return `var __SANDBOXED_LIB__ = (() => { ${body} })();`;
}

/**
 * Installs a host global for one test so it can be granted as a permission.
 *
 * `exposeWebAPIs()` reads permitted names from `globalThis`, so tests that
 * need a custom host capability define it here and it is removed afterwards.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} name Global name, also used as the permission name.
 * @param {unknown} value Host value to expose.
 * @returns {string} The global name, for use in `permissions`.
 */
export function defineHostGlobal(t, name, value) {
  if (Object.hasOwn(globalThis, name)) {
    throw new Error(`Host global ${name} already exists`);
  }
  globalThis[name] = value;
  t.after(() => {
    delete globalThis[name];
  });
  return name;
}

/**
 * Makes disposal idempotent and registers it as test cleanup.
 *
 * Tests that pin raw `dispose()` semantics must use `SandboxManager` directly.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {object} sandbox Sandbox runtime returned by `SandboxManager`.
 * @returns {object} The same sandbox with guarded disposal.
 */
function ownSandbox(t, sandbox) {
  const dispose = sandbox.dispose;
  let disposed = false;
  sandbox.dispose = () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  t.after(() => sandbox.dispose());
  return sandbox;
}

/**
 * Creates an asynchronous-module sandbox that is disposed when the test ends.
 *
 * Permissions default to an explicit empty list so tests never fall back to
 * the example policy module.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} body Fixture body passed to {@link fixtureBundle}.
 * @param {object} [options] Library name, permissions, and workloads.
 * @returns {Promise<object>} Initialized sandbox runtime.
 */
export async function createFixtureSandbox(t, body, options = {}) {
  const { libraryName = "fixture", permissions = [], workloads } = options;
  const sandbox = await SandboxManager.createSandbox(libraryName, fixtureBundle(body), {
    permissions,
    workloads,
  });
  return ownSandbox(t, sandbox);
}

/**
 * Creates a synchronous-module sandbox that is disposed when the test ends.
 *
 * `createSandboxSync()` requires the shared module to be loaded first.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {string} body Fixture body passed to {@link fixtureBundle}.
 * @param {object} [options] Library name, permissions, and workloads.
 * @returns {Promise<object>} Initialized sandbox runtime.
 */
export async function createFixtureSandboxSync(t, body, options = {}) {
  const { libraryName = "fixture", permissions = [], workloads } = options;
  await getQuickJS();
  const sandbox = SandboxManager.createSandboxSync(libraryName, fixtureBundle(body), {
    permissions,
    workloads,
  });
  return ownSandbox(t, sandbox);
}

/**
 * Runs an ES module snippet in a fresh Node.js process so process-wide state
 * (the shared QuickJS module, event-loop handles, the heap) starts empty.
 *
 * @param {string} source Module source; `SandboxManager` and `fixtureBundle` are in scope.
 * @param {object} [options] Child process options.
 * @param {string[]} [options.execArgv] Extra Node.js flags, such as `--expose-gc`.
 * @returns {{status: number|null, stdout: string, stderr: string}} Process outcome.
 */
export function runIsolated(source, { execArgv = [] } = {}) {
  const prelude = [
    `import { SandboxManager } from ${JSON.stringify(managerUrl)};`,
    `const fixtureBundle = ${fixtureBundle.toString()};`,
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [...execArgv, "--import", hookUrl, "--input-type=module", "-e", `${prelude}\n${source}`],
    { cwd: projectRoot, encoding: "utf8", timeout: 30_000 },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
