// Reverse membrane: wraps QJS-exported objects so all method calls execute
// inside the VM with the original QJS `this`, preserving private fields and
// object identity across the host boundary.

import { isTypedArrayView } from "../core/sb-utils.js";

const exportBindCache = new WeakMap();
const returnedObjCache = new WeakMap();
let tempIdCounter = 0;
const ARG_TAG = "[object Arguments]";

function isArgumentsObject(value) {
  return Object.prototype.toString.call(value) === ARG_TAG;
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

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

export function nextTempId() {
  return tempIdCounter++;
}

/**
 * Wraps a return value from a bound method call — if it's a non-primitive,
 * non-TypedArray, non-Date object, applies wrapReturned to preserve QJS `this`.
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
 */
export function bindSandboxFunction(arena, fn, fnAccessPath, depth, sbHelpers) {
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
    get: makeGetTrap(arena, fnAccessPath, childFnCache, depth, sbHelpers),
  });
}

/**
 * Creates a Proxy over an Arena-dumped export object that intercepts property
 * access and routes function calls through QJS-side bound closures, bypassing
 * Arena's ue() re-marshalling which would lose private fields / object identity.
 */
export function bindSandboxExport(arena, obj, accessPath, sbHelpers, depth = 0) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object" && typeof obj !== "function") return obj;
  if (depth > 3) return obj;
  if (exportBindCache.has(obj)) return exportBindCache.get(obj);

  const fnCache = new Map();

  const bound = new Proxy(obj, {
    get: makeGetTrap(arena, accessPath, fnCache, depth, sbHelpers),
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
 * @param preStoredId - If provided, the object was already stored in
 *   __SANDBOX_TEMP__ by a QJS-side constructor (via createInstance).
 *   Skips the setter round-trip, which would otherwise create a new
 *   QJS object and break WeakMap-based private field emulation.
 * @param sbHelpers - Pre-compiled QJS helper functions (tempSet, tempCall,
 *   tempGet) compiled once at sandbox creation to avoid per-call evalCode
 *   parse+compile overhead.
 */
export function wrapReturned(arena, obj, preStoredId, sbHelpers) {
  if (!shouldWrapReturned(obj)) return obj;
  if (returnedObjCache.has(obj)) return returnedObjCache.get(obj);

  let id;
  if (preStoredId !== undefined) {
    // Object was already stored in __SANDBOX_TEMP__ inside QJS by the
    // constructor closure (createInstance). No round-trip needed.
    id = preStoredId;
  } else {
    id = nextTempId();
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
  // for those properties. We read them directly from the live QJS object instead.
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
            return maybeWrapResult(arena, sbHelpers.tempCall(id, key, ...args), sbHelpers);
          });
        }
        return fnCache.get(key);
      }
      if (shouldWrapReturned(value)) {
        return maybeWrapResult(arena, value, sbHelpers);
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
