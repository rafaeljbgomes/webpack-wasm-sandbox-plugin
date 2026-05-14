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
 * Shared sandbox construction logic. Called by both createSandboxSync and
 * createSandbox after obtaining a QuickJS VM context — eliminates duplication.
 *
 * Returns the sandbox object: { vm, arena, exports, wrapResult, createInstance,
 * unrefPump, dispose }.
 */
function buildSandbox(vm, libraryName, libraryCode, options = {}) {
  const { arenaOptions, dispose: disposeMarshallers } = createArenaConfig(vm);
  const arena = new Arena(vm, arenaOptions);

  exposeWebAPIs(arena, libraryName);

  // Evaluate the library code.
  // Assuming libraryCode sets a global __SANDBOXED_LIB__.
  const libExports = arena.evalCode(`${libraryCode}; __SANDBOXED_LIB__;`);

  // Pre-compile __SANDBOX_TEMP__ helpers once.
  // Replaces per-call arena.evalCode() inside wrapReturned / createInstance
  // with a single parse+compile pass; all subsequent cross-boundary calls are
  // plain function invocations with no QJS compilation overhead.
  arena.evalCode("globalThis.__SANDBOX_TEMP__ = new Map();");
  const sbHelpers = {
    // Store a value by numeric id:  (id, value) → void
    tempSet: arena.evalCode(
      "(id, v) => globalThis.__SANDBOX_TEMP__.set(id, v)",
    ),
    // Call a stored object's method:  (id, key, ...args) → result
    tempCall: arena.evalCode(
      "(id, key, ...args) => globalThis.__SANDBOX_TEMP__.get(id)[key](...args)",
    ),
    // Read a stored object's property:  (id, key) → value
    tempGet: arena.evalCode(
      "(id, key) => globalThis.__SANDBOX_TEMP__.get(id)[key]",
    ),
    // Construct a named export class and store the instance:  (ctorKey, id, ...args) → instance
    tempCreate: arena.evalCode(
      "(ctorKey, id, ...args) => { const inst = new __SANDBOXED_LIB__[ctorKey](...args); globalThis.__SANDBOX_TEMP__.set(id, inst); return inst; }",
    ),
  };

  const workloadExports = {};
  function loadWorkload(workload) {
    if (workloadExports[workload.name]) {
      return workloadExports[workload.name];
    }

    const workloadEvalStartedAt = nowMs();
    const workloadGlobalName = workload.globalName;
    const rawWorkloadExports = arena.evalCode(
      `${workload.code}; ${workloadGlobalName};`,
    );
    recordDuration("workload_bundle_eval_ms", nowMs() - workloadEvalStartedAt);
    workloadExports[workload.name] = bindSandboxExport(
      arena,
      rawWorkloadExports,
      workloadGlobalName,
      0,
      sbHelpers,
    );
    return workloadExports[workload.name];
  }

  for (const workload of options.workloads ?? []) {
    loadWorkload(workload);
  }

  // Bind exports so method calls preserve the original QJS `this`,
  // fixing private fields (mime) and object identity (luxon) issues.
  const boundExports = bindSandboxExport(
    arena,
    libExports,
    "__SANDBOXED_LIB__",
    0,
    sbHelpers,
  );

  // Drive the QuickJS async job queue so Promises resolve inside the VM.
  // Do NOT .unref() here — the pump must keep Node alive during top-level
  // await initialization. The proxy calls unrefPump() after init completes.
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
    callRootExport: (callExpression, args) => {
      for (const arg of args) {
        recordCrossing("host_to_vm", arg);
      }

      const callStartedAt = nowMs();
      const result = callExpression(...args);
      recordMembraneCall(nowMs() - callStartedAt);
      recordCrossing("vm_to_host", result);
      return maybeWrapResult(arena, result, sbHelpers);
    },
    // Wrap a raw Arena sync-proxy returned by a construct-trap call through
    // wrapReturned so that method calls on the constructed instance preserve
    // QJS `this` (required for private class fields).
    wrapResult: (value) => maybeWrapResult(arena, value, sbHelpers),
    /**
     * Construct a new instance of `ctorKey` inside QJS and wrap it so that
     * all method calls keep the original QJS `this`.
     *
     * Unlike `wrapResult(ctor(...args))`, this never marshals the instance
     * through the host boundary before storing it in __SANDBOX_TEMP__.
     * That round-trip loses object identity and breaks WeakMap-based private
     * field emulation (the TypeScript `__classPrivateFieldGet` pattern).
     */
    createInstance: (ctorKey, constructorArgs) => {
      const id = nextTempId();
      const result = sbHelpers.tempCreate(ctorKey, id, ...constructorArgs);
      return wrapReturned(arena, result, id, sbHelpers);
    },
    unrefPump: () => pumpInterval.unref(),
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

export class SandboxManager {
  static createSandboxSync(libraryName, libraryCode, options = {}) {
    const startedAt = nowMs();
    const qjs = getQuickJSSync();
    const sandbox = buildSandbox(
      qjs.newContext(),
      libraryName,
      libraryCode,
      options,
    );
    recordDuration("sandbox_create_ms", nowMs() - startedAt);
    return sandbox;
  }

  static async createSandbox(libraryName, libraryCode, options = {}) {
    const startedAt = nowMs();
    const qjs = await newQuickJSAsyncWASMModule();
    const sandbox = buildSandbox(
      qjs.newContext(),
      libraryName,
      libraryCode,
      options,
    );
    recordDuration("sandbox_create_ms", nowMs() - startedAt);
    return sandbox;
  }
}
