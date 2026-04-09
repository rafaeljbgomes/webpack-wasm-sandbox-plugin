import { getQuickJS, newQuickJSAsyncWASMModule } from "quickjs-emscripten";
import { Arena } from "quickjs-emscripten-sync";
import sandboxConfig from "./sandbox.config.js";

const wrapperCache = new WeakMap();
const exportBindCache = new WeakMap();
const returnedObjCache = new WeakMap();
let tempIdCounter = 0;

// Matches all known engine phrasings for "this is a constructor, call it with new".
const REQUIRES_NEW_RE =
  /requires 'new'|must be called with new|cannot be invoked without 'new'/i;

// Helper: identifies TypedArray views (excludes DataView)
function isTypedArrayView(value) {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/**
 * Wraps a host function so the arena bridge (which always calls without `new`)
 * can still invoke constructors correctly.
 */
function makeCallable(fn, thisArg) {
  return (...args) => {
    let result;
    try {
      result = Reflect.apply(fn, thisArg, args);
    } catch (e) {
      if (e instanceof TypeError && REQUIRES_NEW_RE.test(e.message)) {
        result = Reflect.construct(fn, args);
      } else {
        throw e;
      }
    }
    // Wrap returned objects so their methods stay bound to the real host instance.
    // This prevents Arena from creating a sync Proxy over objects with native
    // internal slots (e.g. Intl.DateTimeFormat), where Proxy breaks slot checks.
    // TypedArrays are excluded — they're handled by the custom marshaller.
    if (
      result !== null &&
      typeof result === "object" &&
      !isTypedArrayView(result)
    ) {
      return bindWebApi(result);
    }
    return result;
  };
}

export function bindWebApi(apiObject) {
  if (typeof apiObject !== "object" || apiObject === null) {
    return apiObject;
  }

  if (wrapperCache.has(apiObject)) {
    return wrapperCache.get(apiObject);
  }

  const boundObject = {};
  wrapperCache.set(apiObject, boundObject);

  let keys = [];
  try {
    // Walk the full prototype chain so methods defined on built-in prototypes
    // (e.g. Crypto.prototype.getRandomValues, Intl.ListFormat.prototype.format)
    // are included. Object.getOwnPropertyNames is used at each level to capture
    // non-enumerable properties that for...in would miss.
    const seen = new Set();
    let proto = apiObject;
    while (proto && proto !== Object.prototype) {
      for (const k of Object.getOwnPropertyNames(proto)) seen.add(k);
      proto = Object.getPrototypeOf(proto);
    }
    keys = [...seen];
  } catch (err) {}

  for (const key of keys) {
    try {
      if (typeof apiObject[key] === "function") {
        boundObject[key] = makeCallable(apiObject[key], apiObject);
      } else {
        Object.defineProperty(boundObject, key, {
          get: () => bindWebApi(apiObject[key]),
          set: (val) => {
            apiObject[key] = val;
          },
        });
      }
    } catch (err) {}
  }

  return boundObject;
}

/**
 * Reverse membrane for QJS→host exports.
 * Uses a Proxy with a lazy `get` trap to create QJS-side bound closures
 * via arena.evalCode(), so method calls preserve the original QJS `this`
 * — bypassing Arena's ue() re-marshalling which creates new QJS objects
 * that lack private fields / internal slots.
 */
/**
 * Wraps a return value from a bound method call — if it's a non-primitive,
 * non-TypedArray object, applies wrapReturned to preserve QJS `this` identity.
 */
function maybeWrapResult(arena, result, sbHelpers) {
  if (
    result !== null &&
    typeof result === "object" &&
    !isTypedArrayView(result)
  ) {
    return wrapReturned(arena, result, undefined, sbHelpers);
  }
  return result;
}

/**
 * Creates a bound Proxy for a function (class or standalone) from the sandbox.
 * Intercepts both direct calls AND property access (for static methods).
 */
function bindSandboxFunction(arena, fn, fnAccessPath, depth, sbHelpers) {
  const childFnCache = new Map();
  const callFn = arena.evalCode(`(...args) => ${fnAccessPath}(...args)`);

  return new Proxy(fn, {
    apply(_target, _thisArg, args) {
      return maybeWrapResult(arena, callFn(...args), sbHelpers);
    },
    construct(target, args) {
      // Delegate to the original — the proxy-generator's construct trap
      // or Arena's own construct handling will take care of `new`.
      return Reflect.construct(target, args);
    },
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      const value = target[key];
      if (typeof value === "function") {
        if (!childFnCache.has(key)) {
          const childPath = `${fnAccessPath}["${key}"]`;
          childFnCache.set(
            key,
            bindSandboxFunction(arena, value, childPath, depth + 1, sbHelpers),
          );
        }
        return childFnCache.get(key);
      }
      if (
        typeof value === "object" &&
        value !== null &&
        !isTypedArrayView(value)
      ) {
        return bindSandboxExport(
          arena,
          value,
          `${fnAccessPath}["${key}"]`,
          depth + 1,
          sbHelpers,
        );
      }
      return value;
    },
  });
}

function bindSandboxExport(arena, obj, accessPath, depth = 0, sbHelpers) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object" && typeof obj !== "function") return obj;
  if (depth > 3) return obj;
  if (exportBindCache.has(obj)) return exportBindCache.get(obj);

  const fnCache = new Map();

  const bound = new Proxy(obj, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);

      const value = target[key];
      if (typeof value === "function") {
        if (!fnCache.has(key)) {
          const fnPath = `${accessPath}["${key}"]`;
          fnCache.set(
            key,
            bindSandboxFunction(arena, value, fnPath, depth + 1, sbHelpers),
          );
        }
        return fnCache.get(key);
      }
      if (
        typeof value === "object" &&
        value !== null &&
        !isTypedArrayView(value)
      ) {
        return bindSandboxExport(
          arena,
          value,
          `${accessPath}["${key}"]`,
          depth + 1,
          sbHelpers,
        );
      }
      return value;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });

  exportBindCache.set(obj, bound);
  return bound;
}

/**
 * Wraps objects returned from bound sandbox methods.
 * Stores the QJS-side result in a temporary Map entry and binds methods
 * from that reference, preserving object identity for private fields.
 *
 * @param preStoredId - If provided, the object was already stored in
 *   __SANDBOX_TEMP__ by a QJS-side constructor (via createInstance).
 *   Skips the setter round-trip, which would otherwise create a new
 *   QJS object and break WeakMap-based private field emulation.
 * @param sbHelpers - Pre-compiled QJS helper functions (tempSet, tempCall,
 *   tempGet) compiled once at sandbox creation to avoid per-call evalCode
 *   parse+compile overhead.
 */
function wrapReturned(arena, obj, preStoredId, sbHelpers) {
  if (obj === null || typeof obj !== "object") return obj;
  if (isTypedArrayView(obj)) return obj;
  if (returnedObjCache.has(obj)) return returnedObjCache.get(obj);

  let id;
  if (preStoredId !== undefined) {
    // Object was already stored in __SANDBOX_TEMP__ inside QJS by the
    // constructor closure (createInstance).  No round-trip needed.
    id = preStoredId;
  } else {
    id = tempIdCounter++;
    sbHelpers.tempSet(id, obj);
  }

  const fnCache = new Map();
  // Stores host-side property overrides (e.g. from mock.method / direct assignment).
  // These take priority over fnCache so that mocked methods are visible both on the
  // host side (mock.calls) and when the object is marshalled back into QJS.
  const hostOverrides = new Map();

  // Cache for QJS-side property getters (for primitive-typed properties such
  // as Luxon DateTime.year / .month / .day that are defined as class getters).
  // Arena's sync-proxy materialises the object via ctx.dump() — a JSON dump
  // that never calls QJS prototype getters — so target[key] returns NaN/undefined
  // for those properties.  We read them directly from the live QJS object instead.
  const propGetterCache = new Map();

  const bound = new Proxy(obj, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);

      // Return any host-side override set via the set trap (e.g. mock.method).
      if (hostOverrides.has(key)) {
        return hostOverrides.get(key);
      }

      // Proxy invariant: if the target has a non-configurable, non-writable
      // data property, the trap MUST return the exact same value as target[key].
      // Wrapping it in a new Proxy (even with identical content) would produce
      // a different object reference and throw a TypeError at the engine level.
      // This surfaces for Arena-dumped objects where ctx.dump() materialises
      // properties like ZodError.issues as sealed own data properties.
      const desc = Object.getOwnPropertyDescriptor(target, key);
      if (desc && !desc.configurable && desc.writable === false) {
        return Reflect.get(target, key, receiver);
      }

      const value = target[key];
      if (typeof value === "function") {
        if (!fnCache.has(key)) {
          fnCache.set(key, (...args) => {
            const result = sbHelpers.tempCall(id, key, ...args);
            if (
              result !== null &&
              typeof result === "object" &&
              !isTypedArrayView(result)
            ) {
              return wrapReturned(arena, result, undefined, sbHelpers);
            }
            return result;
          });
        }
        return fnCache.get(key);
      }
      if (
        typeof value === "object" &&
        value !== null &&
        !isTypedArrayView(value)
      ) {
        return wrapReturned(arena, value, undefined, sbHelpers);
      }
      // For primitive-typed properties (numbers, strings, booleans, null,
      // undefined) read the value directly from the live QJS object so that
      // class getter properties defined on the prototype (e.g. DateTime.year,
      // DateTime.month) are actually invoked inside the VM rather than read
      // from Arena's ctx.dump() snapshot which omits prototype getters.
      if (!propGetterCache.has(key)) {
        propGetterCache.set(key, () => sbHelpers.tempGet(id, key));
      }
      return propGetterCache.get(key)();
    },
    set(target, key, value) {
      // Persist the host value so get() returns it directly (bypassing fnCache),
      // and invalidate any stale fnCache entry for the same key.
      hostOverrides.set(key, value);
      fnCache.delete(key);
      target[key] = value;
      return true;
    },
  });

  returnedObjCache.set(obj, bound);
  return bound;
}

export class SandboxManager {
  quickJS = null;

  static async createSandbox(libraryName, libraryCode) {
    this.quickJS = await newQuickJSAsyncWASMModule();

    const vm = this.quickJS.newContext();

    // Per-sandbox cache for marshal: one QJS constructor fn per TypedArray type
    const typedArrayCreators = new Map();
    // Per-sandbox cache for unmarshal: QJS helper functions
    const unmarshalHelpers = {};

    // Pre-create TypedArray detector used by isHandleWrappable.
    // Must exist before Arena is constructed since Arena captures the callback at init.
    const isTypedArrayInVM = vm.unwrapResult(
      vm.evalCode("(h) => ArrayBuffer.isView(h) && !(h instanceof DataView)"),
    );

    const arena = new Arena(vm, {
      isMarshalable: true,

      // Prevent sync-proxy creation for TypedArrays: they cross the boundary as
      // value copies, not as live-synced references.  Without this, `de()` wraps
      // the host TypedArray in a Proxy and `ArrayBuffer.isView(proxy)` → false,
      // which would bypass the customMarshaller on re-entry.
      isWrappable: (value) => !isTypedArrayView(value),

      // Mirror of isWrappable for the QJS→host direction.
      // _wrapHandle() converts QJS object handles into QJS proxy-functions before
      // passing them to customUnmarshaller. For TypedArrays that bypasses the
      // unmarshaller entirely (ctx.typeof(proxyFn) === "function", not "object").
      // Returning false here tells _wrapHandle to skip wrapping, so the original
      // QJS handle reaches customUnmarshaller unchanged.
      isHandleWrappable: (handle, ctx) => {
        if (ctx.typeof(handle) !== "object") return true;
        const result = ctx.unwrapResult(
          ctx.callFunction(isTypedArrayInVM, ctx.undefined, handle),
        );
        const isTA = ctx.dump(result);
        result.dispose();
        return !isTA;
      },

      // host TypedArray  →  proper QJS TypedArray
      customMarshaller: [
        (value, ctx) => {
          if (!isTypedArrayView(value)) return undefined;
          const typeName = value.constructor.name;
          // Copy only the view's own bytes (handles non-zero byteOffset)
          const slicedBuffer = value.buffer.slice(
            value.byteOffset,
            value.byteOffset + value.byteLength,
          );
          const bufHandle = ctx.newArrayBuffer(slicedBuffer);
          if (!typedArrayCreators.has(typeName)) {
            typedArrayCreators.set(
              typeName,
              ctx.unwrapResult(ctx.evalCode(`(buf) => new ${typeName}(buf)`)),
            );
          }
          const result = ctx.unwrapResult(
            ctx.callFunction(
              typedArrayCreators.get(typeName),
              ctx.undefined,
              bufHandle,
            ),
          );
          bufHandle.dispose();
          return result;
        },
      ],

      // QJS TypedArray  →  real host TypedArray
      customUnmarshaller: [
        (handle, ctx) => {
          // Skip non-objects early to avoid expensive QJS calls
          if (ctx.typeof(handle) !== "object") return undefined;

          // Check ArrayBuffer.isView(h) && !(h instanceof DataView) inside QJS
          if (!unmarshalHelpers.isTypedArray) {
            unmarshalHelpers.isTypedArray = ctx.unwrapResult(
              ctx.evalCode(
                "(h) => ArrayBuffer.isView(h) && !(h instanceof DataView)",
              ),
            );
          }
          const checkResult = ctx.unwrapResult(
            ctx.callFunction(
              unmarshalHelpers.isTypedArray,
              ctx.undefined,
              handle,
            ),
          );
          const isTA = ctx.dump(checkResult);
          checkResult.dispose();
          if (!isTA) return undefined;

          // Get the constructor name (e.g. "Uint8Array", "Int32Array")
          if (!unmarshalHelpers.getTypeName) {
            unmarshalHelpers.getTypeName = ctx.unwrapResult(
              ctx.evalCode("(h) => h.constructor.name"),
            );
          }
          const typeNameHandle = ctx.unwrapResult(
            ctx.callFunction(
              unmarshalHelpers.getTypeName,
              ctx.undefined,
              handle,
            ),
          );
          const typeName = ctx.getString(typeNameHandle);
          typeNameHandle.dispose();

          // Copy exactly the view's bytes into a fresh ArrayBuffer inside QJS,
          // then hand it off to getArrayBuffer() which reads from WASM memory.
          if (!unmarshalHelpers.toExactBuffer) {
            unmarshalHelpers.toExactBuffer = ctx.unwrapResult(
              ctx.evalCode(
                "(h) => h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)",
              ),
            );
          }
          const exactBufHandle = ctx.unwrapResult(
            ctx.callFunction(
              unmarshalHelpers.toExactBuffer,
              ctx.undefined,
              handle,
            ),
          );
          const rawBytesLifetime = ctx.getArrayBuffer(exactBufHandle);
          exactBufHandle.dispose();
          // .value is a view into WASM memory; slice() makes a safe host copy
          const rawBytes = rawBytesLifetime.value.slice();
          rawBytesLifetime.dispose();

          const TypedArrayCtor = globalThis[typeName];
          if (!TypedArrayCtor) return undefined;
          return new TypedArrayCtor(rawBytes.buffer);
        },
      ],
    });

    // Expose safe WebAPIs dynamically based on config
    const config = sandboxConfig[libraryName] || { permissions: [] };
    const exposedAPIs = {};

    for (const apiName of config.permissions) {
      if (typeof globalThis[apiName] !== "undefined") {
        let rootAPI = globalThis[apiName];
        if (typeof rootAPI === "function") {
          rootAPI = makeCallable(rootAPI, globalThis);
        } else {
          rootAPI = bindWebApi(rootAPI);
        }
        exposedAPIs[apiName] = arena.sync(rootAPI);
      }
    }

    arena.expose(exposedAPIs);

    // Evaluate the library code
    // Assuming libraryCode sets a global __SANDBOXED_LIB__
    const code = `${libraryCode}; __SANDBOXED_LIB__;`;

    const libExports = arena.evalCode(code);

    // Pre-compile __SANDBOX_TEMP__ helpers once.
    // Replaces the per-call arena.evalCode() inside wrapReturned / createInstance
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
        const id = tempIdCounter++;
        const result = sbHelpers.tempCreate(ctorKey, id, ...constructorArgs);
        return wrapReturned(arena, result, id, sbHelpers);
      },
      unrefPump: () => pumpInterval.unref(),
      dispose: () => {
        clearInterval(pumpInterval);
        if (isTypedArrayInVM.alive) isTypedArrayInVM.dispose();
        for (const fn of typedArrayCreators.values()) {
          if (fn.alive) fn.dispose();
        }
        for (const fn of Object.values(unmarshalHelpers)) {
          if (fn.alive) fn.dispose();
        }
        for (const fn of Object.values(sbHelpers)) {
          if (fn.alive) fn.dispose();
        }
        arena.dispose();
        vm.dispose();
      },
    };
  }
}
