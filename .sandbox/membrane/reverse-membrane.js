import { isTypedArrayView, sandboxDisposedError } from "../core/sb-utils.js";

const ARG_TAG = "[object Arguments]";
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Builds a QuickJS member expression for one property of an access path.
 *
 * Property keys reach this point from host code and from library export
 * names, so they are embedded as escaped string literals. QuickJS rejects raw
 * U+2028 and U+2029 inside string literals, which JSON leaves unescaped.
 *
 * @param {string} accessPath QuickJS expression resolving the owner.
 * @param {string} key Property name to read.
 * @returns {string} QuickJS expression resolving the property.
 */
function memberAccessPath(accessPath, key) {
  const keyLiteral = JSON.stringify(key)
    .split(LINE_SEPARATOR).join("\\u2028")
    .split(PARAGRAPH_SEPARATOR).join("\\u2029");
  return `${accessPath}[${keyLiteral}]`;
}

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
 * Creates the reverse membrane owned by one sandbox.
 *
 * Every wrapper this membrane creates routes calls through the Arena and
 * helpers passed here, and the caches that preserve wrapper identity belong to
 * this sandbox alone. A process-wide cache would hand a wrapper bound to one
 * QuickJS context to another sandbox that wraps the same host value (issue #3).
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Source sandbox bridge.
 * @param {object} sbHelpers Pre-compiled QJS helper functions (tempSet, tempCall,
 *   tempGet) compiled once at sandbox creation to avoid per-call evalCode
 *   parse+compile overhead.
 * @returns {object} Membrane operations and the disposer that releases its state.
 */
export function createReverseMembrane(arena, sbHelpers) {
  // Released by dispose(); wrappers that outlive the sandbox then fail closed
  // instead of reaching the disposed context or keeping it reachable.
  let owner = {
    arena,
    sbHelpers,
    exportBindCache: new WeakMap(),
    returnedObjCache: new WeakMap(),
    tempIdCounter: 0,
  };

  /**
   * Returns the live membrane state or rejects use after disposal.
   *
   * @returns {object} Arena, helpers, caches, and identifier counter.
   */
  function live() {
    if (owner === null) throw sandboxDisposedError();
    return owner;
  }

  /**
   * Builds the shared `get` trap used by both bindSandboxFunction and
   * bindSandboxExport. Caches wrapped functions in `fnCache` and lazily
   * wraps nested objects via bindSandboxExport.
   *
   * @param {string} accessPath QuickJS expression resolving the wrapped object.
   * @param {Map<PropertyKey, Function>} fnCache Stable wrappers keyed by property.
   * @param {number} depth Current recursive export-binding depth.
   * @returns {Function} Proxy `get` trap shared by exported objects and functions.
   */
  function makeGetTrap(accessPath, fnCache, depth) {
    return function get(target, key, receiver) {
      live();
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      const value = target[key];
      if (typeof value === "function") {
        if (!fnCache.has(key)) {
          fnCache.set(
            key,
            bindSandboxFunction(value, memberAccessPath(accessPath, key), depth + 1),
          );
        }
        return fnCache.get(key);
      }
      if (typeof value === "object" && value !== null && !isTypedArrayView(value)) {
        return bindSandboxExport(value, memberAccessPath(accessPath, key), depth + 1);
      }
      return value;
    };
  }

  /**
   * Allocates an identifier for a live value stored in `__SANDBOX_TEMP__`.
   *
   * Identifiers are visible to guest code, so each sandbox counts its own
   * rather than revealing how many values other sandboxes have pinned.
   *
   * @returns {number} Sandbox-local monotonically increasing identifier.
   */
  function nextTempId() {
    return live().tempIdCounter++;
  }

  /**
   * Wraps a return value from a bound method call — if it's a non-primitive,
   * non-TypedArray, non-Date object, applies wrapReturned to preserve QJS `this`.
   *
   * @param {unknown} result Boundary result to classify.
   * @returns {unknown} Original value or an identity-preserving host proxy.
   */
  function maybeWrapResult(result) {
    live();
    if (shouldWrapReturned(result)) {
      return wrapReturned(result);
    }
    return result;
  }

  /**
   * Creates a bound Proxy for a function (class or standalone) from the sandbox.
   * Intercepts both direct calls AND property access (for static methods).
   * Uses a QJS-side closure so calls preserve the original QJS `this`.
   *
   * @param {Function} fn Arena-exported function used as the proxy target.
   * @param {string} fnAccessPath QuickJS expression resolving the function.
   * @param {number} depth Current recursive export-binding depth.
   * @returns {Function} Host-callable proxy bound to the QuickJS function.
   */
  function bindSandboxFunction(fn, fnAccessPath, depth) {
    const childFnCache = new Map();
    const callFn = live().arena.evalCode(`(...args) => ${fnAccessPath}(...args)`);

    return new Proxy(fn, {
      /** Invokes the function through its QuickJS access path. */
      apply(_target, _thisArg, args) {
        live();
        return maybeWrapResult(callFn(...args));
      },
      /** Delegates construction to the layer that owns constructor handling. */
      construct(target, args) {
        live();
        // Construction remains the responsibility of the outer generated proxy
        // or Arena when no generated trap is involved.
        return Reflect.construct(target, args);
      },
      get: makeGetTrap(fnAccessPath, childFnCache, depth),
    });
  }

  /**
   * Creates a Proxy over an Arena-dumped export object that intercepts property
   * access and routes function calls through QJS-side bound closures, bypassing
   * Arena's ue() re-marshalling which would lose private fields / object identity.
   *
   * @param {unknown} obj Arena-exported value to bind.
   * @param {string} accessPath QuickJS expression resolving the value.
   * @param {number} [depth=0] Current recursive binding depth.
   * @returns {unknown} Primitive input unchanged or an identity-cached host proxy.
   */
  function bindSandboxExport(obj, accessPath, depth = 0) {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object" && typeof obj !== "function") return obj;
    if (depth > 3) return obj;
    const { exportBindCache } = live();
    if (exportBindCache.has(obj)) return exportBindCache.get(obj);

    const fnCache = new Map();

    const bound = new Proxy(obj, {
      get: makeGetTrap(accessPath, fnCache, depth),
      /** Mirrors host assignments onto the Arena-exported target. */
      set(target, key, value) {
        live();
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
   * @param {unknown} obj Arena result to wrap.
   * @param {number} [preStoredId] If provided, the object was already stored in
   *   __SANDBOX_TEMP__ by a QJS-side constructor (via createInstance).
   *   Skips the setter round-trip, which would otherwise create a new
   *   QJS object and break WeakMap-based private field emulation.
   * @returns {unknown} Original value or an identity-cached host proxy.
   */
  function wrapReturned(obj, preStoredId) {
    if (!shouldWrapReturned(obj)) return obj;
    const { returnedObjCache } = live();
    if (returnedObjCache.has(obj)) return returnedObjCache.get(obj);

    let id;
    if (preStoredId !== undefined) {
      // Constructor-created objects are stored before crossing the boundary, so
      // storing them again would replace their identity inside QuickJS.
      id = preStoredId;
    } else {
      id = nextTempId();
      live().sbHelpers.tempSet(id, obj);
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
        live();
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
              return maybeWrapResult(live().sbHelpers.tempCall(id, key, ...args));
            });
          }
          return fnCache.get(key);
        }
        if (shouldWrapReturned(value)) {
          return maybeWrapResult(value);
        }
        if (!propGetterCache.has(key)) {
          propGetterCache.set(key, () => live().sbHelpers.tempGet(id, key));
        }
        return propGetterCache.get(key)();
      },
      /** Stores a host override and invalidates any cached method wrapper. */
      set(target, key, value) {
        live();
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

  return {
    bindSandboxExport,
    maybeWrapResult,
    wrapReturned,
    nextTempId,
    /** Releases the Arena, helpers, caches, and counter held by this membrane. */
    dispose: () => {
      owner = null;
    },
  };
}
