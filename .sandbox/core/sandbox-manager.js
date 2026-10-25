import { getQuickJSSync, newQuickJSWASMModule } from "quickjs-emscripten";
import { Arena } from "quickjs-emscripten-sync";
import { createArenaConfig } from "../marshallers/index.js";
import { exposeWebAPIs, validatePermissions } from "./webapi-exposure.js";
import {
  bindSandboxExport,
  maybeWrapResult,
  wrapReturned,
  nextTempId,
} from "../membrane/reverse-membrane.js";

export { bindWebApi } from "../membrane/forward-membrane.js";

/** Fallback job-pump period for VM entry points that are not instrumented. */
export const FALLBACK_PUMP_INTERVAL_MS = 10;

/** Context methods that can run guest code and therefore enqueue QuickJS jobs. */
const VM_ENTRY_POINTS = ["callFunction", "evalCode", "getProp", "setProp"];

// Native promise jobs cannot be replaced by test-runner fake timers.
const resolvedPromise = Promise.resolve();

/**
 * Drains QuickJS Promise jobs from a host microtask after every VM entry.
 *
 * QuickJS queues Promise reactions internally and never runs them on its own.
 * Draining them in the host microtask that follows the boundary call keeps
 * sandboxed async code close to native ordering instead of waiting for a timer.
 * A slow interval remains as a fallback for uninstrumented entry points.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Context whose entry points are observed.
 * @param {() => import("quickjs-emscripten-sync").Arena | undefined} getArena Arena that converts job errors.
 * @returns {{start: () => void, unref: () => void, dispose: () => void}} Pump lifecycle controls.
 */
function createJobPump(vm, getArena) {
  let scheduled = false;
  let disposed = false;
  let fallbackInterval;

  /** Runs every pending QuickJS job, including jobs queued while draining. */
  const drain = () => {
    scheduled = false;
    if (disposed || !vm.alive) return;
    const arena = getArena();
    if (!arena) return;
    try {
      if (vm.runtime.hasPendingJob()) {
        arena.executePendingJobs();
      }
    } catch (err) {
      console.error("Sandbox async execution error:", err);
    }
  };

  /** Schedules at most one drain per burst of boundary activity. */
  const requestDrain = () => {
    if (!scheduled && !disposed) {
      scheduled = true;
      resolvedPromise.then(drain);
    }
  };

  // Instance-level wrappers observe calls from Arena, quickjs-emscripten, and
  // the membranes because they all dispatch through this context object.
  for (const name of VM_ENTRY_POINTS) {
    const original = vm[name];
    if (typeof original !== "function") continue;
    vm[name] = function observedVmEntry(...args) {
      try {
        return original.apply(this, args);
      } finally {
        requestDrain();
      }
    };
  }

  return {
    /** Starts the fallback timer once initialization can no longer fail. */
    start: () => {
      fallbackInterval ??= setInterval(drain, FALLBACK_PUMP_INTERVAL_MS);
    },
    unref: () => fallbackInterval?.unref?.(),
    dispose: () => {
      disposed = true;
      clearInterval(fallbackInterval);
    },
  };
}

/**
 * Memoizes `typeof` per handle on a context instance.
 *
 * A handle always refers to the same QuickJS value, so its type cannot change,
 * while Arena and the marshallers ask for it several times per crossing and
 * each query allocates and decodes a C string in WASM memory.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Context to optimize.
 * @returns {void}
 */
function memoizeHandleTypes(vm) {
  const original = vm.typeof;
  const types = new WeakMap();
  vm.typeof = function memoizedTypeof(handle) {
    let type = types.get(handle);
    if (type === undefined) {
      type = original.call(this, handle);
      types.set(handle, type);
    }
    return type;
  };
}

/**
 * Drops the QuickJS context reference from errors raised by `vm.unwrapResult()`.
 *
 * quickjs-emscripten attaches the owning context to `QuickJSUnwrapError`, and
 * that context reaches the whole WebAssembly heap view. Test-runner error
 * serializers walk every reachable own property, so one failing assertion on a
 * sandbox error copied the full heap (about 2.3 GB for a 16 MiB heap). Name,
 * message, stack, and `cause` are kept; nothing in the runtime reads `context`.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Context to adjust.
 * @returns {void}
 */
function detachUnwrapErrorContext(vm) {
  const original = vm.unwrapResult;
  vm.unwrapResult = function unwrapWithoutContext(result) {
    try {
      return original.call(this, result);
    } catch (error) {
      if (error !== null && typeof error === "object" && Object.hasOwn(error, "context")) {
        delete error.context;
      }
      throw error;
    }
  };
}

/**
 * Builds the runtime shared by synchronous and asynchronous sandbox creation.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm QuickJS context owned by the sandbox.
 * @param {string} libraryName Policy key for the isolated dependency.
 * @param {string} libraryCode Bundled dependency source that defines `__SANDBOXED_LIB__`.
 * @param {object} [options] Optional explicit permissions and workload definitions loaded into the same context.
 * @returns {object} Sandbox exports, workload access, boundary helpers, and lifecycle controls.
 */
function buildSandbox(vm, libraryName, libraryCode, options = {}) {
  let arena;
  memoizeHandleTypes(vm);
  detachUnwrapErrorContext(vm);
  // Observe VM entries first so jobs queued during library initialization drain.
  const jobPump = createJobPump(vm, () => arena);
  const { arenaOptions, dispose: disposeMarshallers } = createArenaConfig(vm);
  arena = new Arena(vm, arenaOptions);

  exposeWebAPIs(arena, libraryName, options.permissions);

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

  // The fallback interval stays referenced through top-level-await
  // initialization; the generated proxy releases that reference once ready.
  jobPump.start();

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
    unrefPump: () => jobPump.unref(),
    /** Releases the job pump, marshallers, Arena, and QuickJS context. */
    dispose: () => {
      jobPump.dispose();
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
   * @param {object} [options] Optional explicit permissions and workload definitions.
   * @returns {object} Initialized sandbox runtime.
   */
  static createSandboxSync(libraryName, libraryCode, options = {}) {
    validatePermissions(options.permissions);
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
   * Loads a dedicated QuickJS WASM module instance and creates a sandbox.
   *
   * Each call instantiates a separate WebAssembly module with its own linear
   * memory. The synchronous (non-asyncify) build is used because the runtime
   * never suspends QuickJS on host promises, and asyncify instrumentation adds
   * a generator round trip to every boundary call.
   *
   * @param {string} libraryName Policy key for the isolated dependency.
   * @param {string} libraryCode Bundled dependency source.
   * @param {object} [options] Optional explicit permissions and workload definitions.
   * @returns {Promise<object>} Initialized sandbox runtime.
   */
  static async createSandbox(libraryName, libraryCode, options = {}) {
    validatePermissions(options.permissions);
    const qjs = await newQuickJSWASMModule();
    const sandbox = buildSandbox(
      qjs.newContext(),
      libraryName,
      libraryCode,
      options,
    );
    return sandbox;
  }
}
