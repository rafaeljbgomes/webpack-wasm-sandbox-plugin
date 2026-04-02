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
          rootAPI = rootAPI.bind(globalThis);
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
      exports: libExports,
      dispose: () => {
        clearInterval(pumpInterval);
        arena.dispose();
        vm.dispose();
      },
    };
  }
}
