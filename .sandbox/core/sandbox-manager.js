// Import the one QuickJS build the runtime uses. The `quickjs-emscripten`
// entry point references all four builds (release/debug x sync/asyncify), so
// importing it makes bundlers ship every .wasm file.
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten-core";
import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
import { Arena } from "quickjs-emscripten-sync";
import { createArenaConfig } from "../marshallers/index.js";
import { exposeWebAPIs, validatePermissions } from "./webapi-exposure.js";
import { createJsonTransfer } from "./json-transfer.js";
import { createForwardMembrane } from "../membrane/forward-membrane.js";
import { createReverseMembrane } from "../membrane/reverse-membrane.js";

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
/** Wasm page size and the QuickJS build's initial memory (16 MiB). */
const WASM_PAGE = 65536;
const INITIAL_PAGES = 256;

/**
 * Returns the QuickJS variant for a dedicated module instance. With
 * `limits.memoryBytes`, the instance gets a linear memory whose maximum is
 * that size, so allocation past it fails inside QuickJS ("out of memory").
 * QuickJS's own malloc limit is not used: in this build it cannot measure
 * allocation sizes and does not bound the linear memory.
 *
 * @param {{memoryBytes?: number}} [limits] Limits.
 */
function variantFor(limits) {
  if (limits?.memoryBytes === undefined) return RELEASE_SYNC;
  const { memoryBytes } = limits;
  if (!Number.isInteger(memoryBytes) || memoryBytes < INITIAL_PAGES * WASM_PAGE) {
    throw new Error(`limits.memoryBytes must be an integer >= ${INITIAL_PAGES * WASM_PAGE}`);
  }
  const maximum = Math.floor(memoryBytes / WASM_PAGE);
  return newVariant(RELEASE_SYNC, { wasmMemory: new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum }) });
}

/**
 * Applies the optional per-call time limit to a sandbox context.
 *
 * `callTimeMs` bounds the wall-clock time of each outermost entry into the VM:
 * QuickJS polls the interrupt handler during execution and throws an
 * InternalError ("interrupted") that sandboxed code cannot catch once the
 * deadline passes. Time spent in host functions that the library called
 * counts toward the deadline, but a host function is not stopped mid-way.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Sandbox context.
 * @param {{callTimeMs?: number}} [limits] Limits.
 */
function applyLimits(vm, limits) {
  const callTimeMs = limits?.callTimeMs;
  if (callTimeMs === undefined) return;
  if (!(callTimeMs > 0)) throw new Error("limits.callTimeMs must be positive");
  let depth = 0;
  let deadline = Infinity;
  vm.runtime.setInterruptHandler(() => depth > 0 && Date.now() > deadline);
  for (const name of VM_ENTRY_POINTS) {
    const original = vm[name];
    if (typeof original !== "function") continue;
    vm[name] = function limitedVmEntry(...args) {
      if (depth++ === 0) deadline = Date.now() + callTimeMs;
      try {
        return original.apply(this, args);
      } finally {
        depth--;
      }
    };
  }
}

/**
 * Opt-in execution guard for the compatibility harness.
 *
 * When SANDBOX_GUARD_DIR is set (Node.js only), counts the boundary entries
 * made into this context after initialization and records them in a file per
 * process, thread, and library. The harness rejects a sandbox-mode run whose
 * guard files show no entries, which would mean the tests exercised the native
 * library instead of the proxy. Writes happen at 1, 10, 100, ... entries and
 * at exit, so the recorded count is a lower bound.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Context to observe.
 * @param {string} libraryName Library recorded in the guard file.
 * @returns {{arm: () => void}} Starts counting once initialization is done.
 */
function installExecutionGuard(vm, libraryName) {
  const proc = globalThis.process;
  const dir = proc?.env?.SANDBOX_GUARD_DIR;
  if (!dir || !proc.versions?.node) return { arm: () => {} };
  const load = (name) => proc.getBuiltinModule?.(name);
  const fs = load("fs");
  const path = load("path");
  if (!fs || !path) return { arm: () => {} };
  const threadId = load("worker_threads")?.threadId ?? 0;
  const file = path.join(dir, `guard-${proc.pid}-${threadId}-${libraryName.replace(/[^a-z0-9._-]/gi, "_")}-${Math.random().toString(36).slice(2, 8)}.json`);
  let armed = false;
  let entries = 0;
  let next = 1;
  const write = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Write then rename, so a worker killed mid-write leaves the last
      // complete record rather than an empty file.
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ library: libraryName, pid: proc.pid, threadId, entries }));
      fs.renameSync(`${file}.tmp`, file);
    } catch { /* best effort */ }
  };
  for (const name of VM_ENTRY_POINTS) {
    const original = vm[name];
    if (typeof original !== "function") continue;
    vm[name] = function guardedVmEntry(...args) {
      if (armed && ++entries >= next) {
        next *= 10;
        write();
      }
      return original.apply(this, args);
    };
  }
  proc.on?.("exit", write);
  return { arm: () => { armed = true; write(); } };
}

function buildSandbox(vm, libraryName, libraryCode, options = {}) {
  let arena;
  // Negative control for the compatibility harness: a run in which the
  // library's sandbox cannot be created must not pass the library's tests.
  if (globalThis.process?.env?.SANDBOX_POISON_LIBRARY === libraryName) {
    throw new Error(`Sandbox for ${libraryName} disabled by SANDBOX_POISON_LIBRARY`);
  }
  const guard = installExecutionGuard(vm, libraryName);
  applyLimits(vm, options.limits);
  memoizeHandleTypes(vm);
  detachUnwrapErrorContext(vm);
  // Observe VM entries first so jobs queued during library initialization drain.
  const jobPump = createJobPump(vm, () => arena);
  // Membrane state is owned by this sandbox so wrappers, transfer offers, and
  // temporary identifiers never cross into another QuickJS context.
  const jsonTransfer = createJsonTransfer();
  const forwardMembrane = createForwardMembrane({ offerJsonTransfer: jsonTransfer.offer });
  const { arenaOptions, dispose: disposeMarshallers } = createArenaConfig(vm, jsonTransfer.take);
  arena = new Arena(vm, arenaOptions);

  exposeWebAPIs(arena, libraryName, options.permissions, forwardMembrane, options.writable);

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
    /** Same as tempCreate for a constructor exported by a declared subpath. */
    tempCreateInSubpath: arena.evalCode(
      "(subpath, ctorKey, id, ...args) => { const inst = new globalThis.__SANDBOXED_SUBPATHS__[subpath][ctorKey](...args); globalThis.__SANDBOX_TEMP__.set(id, inst); return inst; }",
    ),
  };
  const reverseMembrane = createReverseMembrane(arena, sbHelpers);

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
    workloadExports[workload.name] = reverseMembrane.bindSandboxExport(
      rawWorkloadExports,
      workloadGlobalName,
      0,
    );
    return workloadExports[workload.name];
  }

  for (const workload of options.workloads ?? []) {
    loadWorkload(workload);
  }

  const subpathViews = new Map();

  /**
   * Returns the host view of a declared subpath. Its exports live in this
   * sandbox's context, published by the bundle under `__SANDBOXED_SUBPATHS__`,
   * so values passed between the root and its subpaths stay in QuickJS.
   *
   * @param {string} subpath Declared subpath, e.g. `locale`.
   * @returns {{exports: unknown, createInstance: Function, callSingleton: Function}} Bound view.
   */
  function loadSubpath(subpath) {
    if (subpathViews.has(subpath)) return subpathViews.get(subpath);
    const accessPath = `globalThis.__SANDBOXED_SUBPATHS__[${JSON.stringify(subpath)}]`;
    const present = arena.evalCode(
      `typeof globalThis.__SANDBOXED_SUBPATHS__ === "object" && globalThis.__SANDBOXED_SUBPATHS__ !== null && Object.prototype.hasOwnProperty.call(globalThis.__SANDBOXED_SUBPATHS__, ${JSON.stringify(subpath)})`,
    );
    if (present !== true) {
      throw new Error(`Sandbox subpath not found in the ${libraryName} bundle: ${subpath}`);
    }
    const raw = arena.evalCode(accessPath);
    let callFn;
    const view = {
      exports: reverseMembrane.bindSandboxExport(raw, accessPath, 0),
      createInstance: (ctorKey, constructorArgs) => {
        const id = reverseMembrane.nextTempId();
        const result = sbHelpers.tempCreateInSubpath(subpath, ctorKey, id, ...constructorArgs);
        return reverseMembrane.wrapReturned(result, id);
      },
      callSingleton: (args) => {
        callFn ??= arena.evalCode(`(...args) => ${accessPath}(...args)`);
        return reverseMembrane.maybeWrapResult(callFn(...args));
      },
    };
    subpathViews.set(subpath, view);
    return view;
  }

  // Binding keeps method receivers and identity anchored in QuickJS.
  const boundExports = reverseMembrane.bindSandboxExport(
    libExports,
    "__SANDBOXED_LIB__",
    0,
  );

  // The fallback interval stays referenced through top-level-await
  // initialization; the generated proxy releases that reference once ready.
  jobPump.start();

  guard.arm();
  return {
    vm,
    arena,
    exports: boundExports,
    workloads: workloadExports,
    loadWorkload,
    loadSubpath,
    /** Calls a root export and applies reverse-membrane result handling. */
    callRootExport: (callExpression, args) => {
      const result = callExpression(...args);
      return reverseMembrane.maybeWrapResult(result);
    },
    /** Wraps a boundary result while preserving its live QuickJS receiver. */
    wrapResult: (value) => reverseMembrane.maybeWrapResult(value),
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
      const id = reverseMembrane.nextTempId();
      const result = sbHelpers.tempCreate(ctorKey, id, ...constructorArgs);
      return reverseMembrane.wrapReturned(result, id);
    },
    /** Allows Node.js to exit when the job pump is the only active handle. */
    unrefPump: () => jobPump.unref(),
    /** Releases the job pump, membrane state, marshallers, Arena, and QuickJS context. */
    dispose: () => {
      jobPump.dispose();
      // Membranes go first so any wrapper still held by the host fails closed
      // instead of reaching the context released below.
      reverseMembrane.dispose();
      forwardMembrane.dispose();
      disposeMarshallers();
      for (const fn of Object.values(sbHelpers)) {
        if (fn.alive) fn.dispose();
      }
      arena.dispose();
      vm.dispose();
    },
  };
}

/** Shared module for synchronous sandbox creation, loaded by `ready()`. */
let sharedModule;
let sharedModulePromise;

/** Creates and owns per-library QuickJS sandbox contexts. */
export class SandboxManager {
  /**
   * Loads the shared QuickJS module used by {@link createSandboxSync}.
   *
   * @returns {Promise<import("quickjs-emscripten-core").QuickJSWASMModule>} Shared module.
   */
  static async ready() {
    sharedModulePromise ??= newQuickJSWASMModuleFromVariant(RELEASE_SYNC).then((module) => {
      sharedModule = module;
      return module;
    });
    return sharedModulePromise;
  }

  /**
   * Creates a sandbox using the already initialized synchronous QuickJS module.
   *
   * @param {string} libraryName Policy key for the isolated dependency.
   * @param {string} libraryCode Bundled dependency source.
   * @param {object} [options] Optional explicit permissions and workload definitions.
   * @returns {object} Initialized sandbox runtime.
   */
  static createSandboxSync(libraryName, libraryCode, options = {}) {
    validatePermissions(options.permissions, options.writable);
    if (!sharedModule) {
      throw new Error("QuickJS module not loaded: await SandboxManager.ready() before createSandboxSync()");
    }
    if (options.limits?.memoryBytes !== undefined) {
      throw new Error("limits.memoryBytes needs a dedicated module: use createSandbox()");
    }
    const qjs = sharedModule;
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
    validatePermissions(options.permissions, options.writable);
    // Opt-in measurement hook: the evaluation harness defines the array.
    const timings = globalThis.__SANDBOX_TIMINGS__;
    const t0 = timings ? performance.now() : 0;
    const qjs = await newQuickJSWASMModuleFromVariant(variantFor(options.limits));
    const t1 = timings ? performance.now() : 0;
    const vm = qjs.newContext();
    const t2 = timings ? performance.now() : 0;
    const sandbox = buildSandbox(
      vm,
      libraryName,
      libraryCode,
      options,
    );
    if (Array.isArray(timings)) {
      timings.push({
        library: libraryName,
        wasmInstantiateMs: t1 - t0,
        contextMs: t2 - t1,
        bundleAndMembraneMs: performance.now() - t2,
        wasmMemoryBytes: qjs.getWasmMemory().buffer.byteLength,
      });
    }
    return sandbox;
  }
}
