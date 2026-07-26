import { getQuickJSSync, newQuickJSAsyncWASMModule } from "quickjs-emscripten";
import { Arena } from "quickjs-emscripten-sync";
import { createArenaConfig } from "../marshallers/index.js";
import { exposeWebAPIs } from "./webapi-exposure.js";
import {
  bindSandboxExport,
  maybeWrapResult,
  wrapReturned,
  nextTempId,
} from "../membrane/reverse-membrane.js";

export { bindWebApi } from "../membrane/forward-membrane.js";

/**
 * Builds the runtime shared by synchronous and asynchronous sandbox creation.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm QuickJS context owned by the sandbox.
 * @param {string} libraryName Policy key for the isolated dependency.
 * @param {string} libraryCode Bundled dependency source that defines `__SANDBOXED_LIB__`.
 * @param {object} [options] Optional workload definitions loaded into the same context.
 * @returns {object} Sandbox exports, workload access, boundary helpers, and lifecycle controls.
 */
function buildSandbox(vm, libraryName, libraryCode, options = {}) {
  const { arenaOptions, dispose: disposeMarshallers } = createArenaConfig(vm);
  const arena = new Arena(vm, arenaOptions);

  exposeWebAPIs(arena, libraryName);

  // The child bundle publishes its exports through this agreed global.
  const libExports = arena.evalCode(`${libraryCode}; __SANDBOXED_LIB__;`);

  // Compile temporary-object operations once so routine boundary crossings do
  // not repeatedly parse helper source.
  arena.evalCode("globalThis.__SANDBOX_TEMP__ = new Map();");
  const sbHelpers = {
    /** Stores a live QuickJS value under a host-generated identifier. */
    tempSet: arena.evalCode(
      "(id, v) => globalThis.__SANDBOX_TEMP__.set(id, v)",
    ),
    /** Invokes a method while preserving the stored object's QuickJS receiver. */
    tempCall: arena.evalCode(
      "(id, key, ...args) => globalThis.__SANDBOX_TEMP__.get(id)[key](...args)",
    ),
    /** Reads a property from the live QuickJS object rather than a dump. */
    tempGet: arena.evalCode(
      "(id, key) => globalThis.__SANDBOX_TEMP__.get(id)[key]",
    ),
    /** Constructs and stores an instance before it crosses the boundary. */
    tempCreate: arena.evalCode(
      "(ctorKey, id, ...args) => { const inst = new __SANDBOXED_LIB__[ctorKey](...args); globalThis.__SANDBOX_TEMP__.set(id, inst); return inst; }",
    ),
  };

  const workloadExports = {};

  /**
   * Evaluates and binds a workload once within its owning library context.
   *
   * @param {object} workload Workload name, global export name, and bundled source.
   * @returns {object} Bound workload exports.
   */
  function loadWorkload(workload) {
    if (workloadExports[workload.name]) {
      return workloadExports[workload.name];
    }

    const workloadGlobalName = workload.globalName;
    const rawWorkloadExports = arena.evalCode(
      `${workload.code}; ${workloadGlobalName};`,
    );
    workloadExports[workload.name] = bindSandboxExport(
      arena,
      rawWorkloadExports,
      workloadGlobalName,
      sbHelpers,
      0,
    );
    return workloadExports[workload.name];
  }

  for (const workload of options.workloads ?? []) {
    loadWorkload(workload);
  }

  // Binding keeps method receivers and identity anchored in QuickJS.
  const boundExports = bindSandboxExport(
    arena,
    libExports,
    "__SANDBOXED_LIB__",
    sbHelpers,
    0,
  );

  // Keep the job pump referenced through top-level-await initialization; the
  // generated proxy releases that reference once the sandbox is ready.
  const pumpInterval = setInterval(() => {
    try {
      if (vm.runtime.hasPendingJob()) {
        arena.executePendingJobs();
      }
    } catch (err) {
      console.error("Sandbox async execution error:", err);
    }
  }, 1);

  return {
    vm,
    arena,
    exports: boundExports,
    workloads: workloadExports,
    loadWorkload,
    /** Calls a root export and applies reverse-membrane result handling. */
    callRootExport: (callExpression, args) => {
      const result = callExpression(...args);
      return maybeWrapResult(arena, result, sbHelpers);
    },
    /** Wraps a boundary result while preserving its live QuickJS receiver. */
    wrapResult: (value) => maybeWrapResult(arena, value, sbHelpers),
    /**
     * Construct a new instance of `ctorKey` inside QJS and wrap it so that
     * all method calls keep the original QJS `this`.
     *
     * Unlike `wrapResult(ctor(...args))`, this never marshals the instance
     * through the host boundary before storing it in __SANDBOX_TEMP__.
     * That round-trip loses object identity and breaks WeakMap-based private
     * field emulation (the TypeScript `__classPrivateFieldGet` pattern).
     *
     * @param {string} ctorKey Named dependency export to construct.
     * @param {unknown[]} constructorArgs Constructor arguments.
     * @returns {object} Host proxy bound to the live QuickJS instance.
     */
    createInstance: (ctorKey, constructorArgs) => {
      const id = nextTempId();
      const result = sbHelpers.tempCreate(ctorKey, id, ...constructorArgs);
      return wrapReturned(arena, result, id, sbHelpers);
    },
    /** Allows Node.js to exit when the job pump is the only active handle. */
    unrefPump: () => pumpInterval.unref(),
    /** Releases the job pump, marshallers, Arena, and QuickJS context. */
    dispose: () => {
      clearInterval(pumpInterval);
      disposeMarshallers();
      for (const fn of Object.values(sbHelpers)) {
        if (fn.alive) fn.dispose();
      }
      arena.dispose();
      vm.dispose();
    },
  };
}

/** Creates and owns per-library QuickJS sandbox contexts. */
export class SandboxManager {
  /**
   * Creates a sandbox using the already initialized synchronous QuickJS module.
   *
   * @param {string} libraryName Policy key for the isolated dependency.
   * @param {string} libraryCode Bundled dependency source.
   * @param {object} [options] Optional workload definitions.
   * @returns {object} Initialized sandbox runtime.
   */
  static createSandboxSync(libraryName, libraryCode, options = {}) {
    const qjs = getQuickJSSync();
    const sandbox = buildSandbox(
      qjs.newContext(),
      libraryName,
      libraryCode,
      options,
    );
    return sandbox;
  }

  /**
   * Loads the asynchronous QuickJS WASM module and creates a sandbox.
   *
   * @param {string} libraryName Policy key for the isolated dependency.
   * @param {string} libraryCode Bundled dependency source.
   * @param {object} [options] Optional workload definitions.
   * @returns {Promise<object>} Initialized sandbox runtime.
   */
  static async createSandbox(libraryName, libraryCode, options = {}) {
    const qjs = await newQuickJSAsyncWASMModule();
    const sandbox = buildSandbox(
      qjs.newContext(),
      libraryName,
      libraryCode,
      options,
    );
    return sandbox;
  }
}
