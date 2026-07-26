import { isTypedArrayView } from "../core/sb-utils.js";

const exportBindCache = new WeakMap();
const returnedObjCache = new WeakMap();
let tempIdCounter = 0;
const ARG_TAG = "[object Arguments]";

/**
 * Detects host Arguments objects that already crossed through a marshaller.
 *
 * @param {unknown} value Value to inspect.
 * @returns {boolean} Whether the value has Arguments identity.
 */
function isArgumentsObject(value) {
  return Object.prototype.toString.call(value) === ARG_TAG;
}

/**
 * Tests whether a value is a data-only object that does not need live QuickJS
 * receiver preservation.
 *
 * @param {object} value Object to inspect.
 * @returns {boolean} Whether the object has a plain or null prototype.
 */
function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Selects results that must remain connected to their live QuickJS object.
 * Values handled safely by copying or custom marshallers are excluded.
 *
 * @param {unknown} value Boundary result to classify.
 * @returns {boolean} Whether reverse-membrane wrapping is required.
 */
function shouldWrapReturned(value) {
  if (value === null) return false;

  const valueType = typeof value;
  if (valueType !== "object" && valueType !== "function") return false;

  if (
    isTypedArrayView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Set ||
    value instanceof Map ||
    Array.isArray(value) ||
    isArgumentsObject(value)
  ) {
    return false;
  }

  if (valueType === "function") return true;
  if (isPlainObject(value)) return false;

  return true;
}

/**
 * Builds the shared `get` trap used by both bindSandboxFunction and
 * bindSandboxExport. Caches wrapped functions in `fnCache` and lazily
 * wraps nested objects via bindSandboxExport.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Source sandbox bridge.
 * @param {string} accessPath QuickJS expression resolving the wrapped object.
 * @param {Map<PropertyKey, Function>} fnCache Stable wrappers keyed by property.
 * @param {number} depth Current recursive export-binding depth.
 * @param {object} sbHelpers Precompiled temporary-object operations.
 * @returns {Function} Proxy `get` trap shared by exported objects and functions.
 */
function makeGetTrap(arena, accessPath, fnCache, depth, sbHelpers) {
  return function get(target, key, receiver) {
    if (typeof key === "symbol") return Reflect.get(target, key, receiver);
    const value = target[key];
    if (typeof value === "function") {
      if (!fnCache.has(key)) {
        fnCache.set(
          key,
          bindSandboxFunction(arena, value, `${accessPath}["${key}"]`, depth + 1, sbHelpers),
        );
      }
      return fnCache.get(key);
    }
    if (typeof value === "object" && value !== null && !isTypedArrayView(value)) {
      return bindSandboxExport(arena, value, `${accessPath}["${key}"]`, sbHelpers, depth + 1);
    }
    return value;
  };
}

/**
 * Allocates an identifier for a live value stored in `__SANDBOX_TEMP__`.
 *
 * @returns {number} Process-local monotonically increasing identifier.
 */
export function nextTempId() {
  return tempIdCounter++;
}

/**
 * Wraps a return value from a bound method call — if it's a non-primitive,
 * non-TypedArray, non-Date object, applies wrapReturned to preserve QJS `this`.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Source sandbox bridge.
 * @param {unknown} result Boundary result to classify.
 * @param {object} sbHelpers Precompiled temporary-object operations.
 * @returns {unknown} Original value or an identity-preserving host proxy.
 */
export function maybeWrapResult(arena, result, sbHelpers) {
  if (shouldWrapReturned(result)) {
    return wrapReturned(arena, result, undefined, sbHelpers);
  }
  return result;
}

/**
 * Creates a bound Proxy for a function (class or standalone) from the sandbox.
 * Intercepts both direct calls AND property access (for static methods).
 * Uses a QJS-side closure so calls preserve the original QJS `this`.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Source sandbox bridge.
 * @param {Function} fn Arena-exported function used as the proxy target.
 * @param {string} fnAccessPath QuickJS expression resolving the function.
 * @param {number} depth Current recursive export-binding depth.
 * @param {object} sbHelpers Precompiled temporary-object operations.
 * @returns {Function} Host-callable proxy bound to the QuickJS function.
 */
export function bindSandboxFunction(arena, fn, fnAccessPath, depth, sbHelpers) {
  const childFnCache = new Map();
  const callFn = arena.evalCode(`(...args) => ${fnAccessPath}(...args)`);

  return new Proxy(fn, {
    /** Invokes the function through its QuickJS access path. */
    apply(_target, _thisArg, args) {
      return maybeWrapResult(arena, callFn(...args), sbHelpers);
    },
    /** Delegates construction to the layer that owns constructor handling. */
    construct(target, args) {
      // Construction remains the responsibility of the outer generated proxy
      // or Arena when no generated trap is involved.
      return Reflect.construct(target, args);
    },
    get: makeGetTrap(arena, fnAccessPath, childFnCache, depth, sbHelpers),
  });
}

/**
 * Creates a Proxy over an Arena-dumped export object that intercepts property
 * access and routes function calls through QJS-side bound closures, bypassing
 * Arena's ue() re-marshalling which would lose private fields / object identity.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Source sandbox bridge.
 * @param {unknown} obj Arena-exported value to bind.
 * @param {string} accessPath QuickJS expression resolving the value.
 * @param {object} sbHelpers Precompiled temporary-object operations.
 * @param {number} [depth=0] Current recursive binding depth.
 * @returns {unknown} Primitive input unchanged or an identity-cached host proxy.
 */
export function bindSandboxExport(arena, obj, accessPath, sbHelpers, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object" && typeof obj !== "function") return obj;
  if (depth > 3) return obj;
  if (exportBindCache.has(obj)) return exportBindCache.get(obj);

  const fnCache = new Map();

  const bound = new Proxy(obj, {
    get: makeGetTrap(arena, accessPath, fnCache, depth, sbHelpers),
    /** Mirrors host assignments onto the Arena-exported target. */
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
 * Stores the QJS-side result in __SANDBOX_TEMP__ and binds methods from that
 * reference, preserving object identity for private fields.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Source sandbox bridge.
 * @param {unknown} obj Arena result to wrap.
 * @param {number} [preStoredId] If provided, the object was already stored in
 *   __SANDBOX_TEMP__ by a QJS-side constructor (via createInstance).
 *   Skips the setter round-trip, which would otherwise create a new
 *   QJS object and break WeakMap-based private field emulation.
 * @param {object} sbHelpers Pre-compiled QJS helper functions (tempSet, tempCall,
 *   tempGet) compiled once at sandbox creation to avoid per-call evalCode
 *   parse+compile overhead.
 * @returns {unknown} Original value or an identity-cached host proxy.
 */
export function wrapReturned(arena, obj, preStoredId, sbHelpers) {
  if (!shouldWrapReturned(obj)) return obj;
  if (returnedObjCache.has(obj)) return returnedObjCache.get(obj);

  let id;
  if (preStoredId !== undefined) {
    // Constructor-created objects are stored before crossing the boundary, so
    // storing them again would replace their identity inside QuickJS.
    id = preStoredId;
  } else {
    id = nextTempId();
    sbHelpers.tempSet(id, obj);
  }

  const fnCache = new Map();
  // Host overrides take priority over cached QuickJS methods so test mocks and
  // direct assignments remain observable on the host.
  const hostOverrides = new Map();

  // Arena dumps omit prototype getters, so primitive properties are read from
  // the live QuickJS object and their accessor closures are cached.
  const propGetterCache = new Map();

  const bound = new Proxy(obj, {
    /** Resolves overrides, methods, nested objects, or live QuickJS properties. */
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);

      if (hostOverrides.has(key)) {
        return hostOverrides.get(key);
      }

      // ECMAScript requires the exact target value for frozen data properties;
      // wrapping such a value would violate the Proxy invariant.
      const desc = Object.getOwnPropertyDescriptor(target, key);
      if (desc && !desc.configurable && desc.writable === false) {
        return Reflect.get(target, key, receiver);
      }

      const value = target[key];
      if (typeof value === "function") {
        if (!fnCache.has(key)) {
          fnCache.set(key, (...args) => {
            return maybeWrapResult(arena, sbHelpers.tempCall(id, key, ...args), sbHelpers);
          });
        }
        return fnCache.get(key);
      }
      if (shouldWrapReturned(value)) {
        return maybeWrapResult(arena, value, sbHelpers);
      }
      if (!propGetterCache.has(key)) {
        propGetterCache.set(key, () => sbHelpers.tempGet(id, key));
      }
      return propGetterCache.get(key)();
    },
    /** Stores a host override and invalidates any cached method wrapper. */
    set(target, key, value) {
      // Invalidate the QuickJS method wrapper so subsequent reads observe the
      // host-side replacement.
      hostOverrides.set(key, value);
      fnCache.delete(key);
      target[key] = value;
      return true;
    },
  });

  returnedObjCache.set(obj, bound);
  return bound;
}
