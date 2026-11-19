import { isTypedArrayView, REQUIRES_NEW_RE, sandboxDisposedError } from "../core/sb-utils.js";
import { isPlainJsonGraph } from "../core/json-transfer.js";

/**
 * Rejects a value that QuickJS may not store in a host property.
 *
 * A granted host object is one object for every sandbox that receives it, so
 * whatever one sandbox writes into it is read by the others. A function or an
 * object written from QuickJS is an Arena handle (or the writer's own wrapper)
 * that runs the writer's code when a sibling calls it or reads through it.
 * Primitives carry no behaviour and no live reference, so only they write
 * through.
 *
 * @param {unknown} value Value assigned inside QuickJS.
 * @param {string} key Host property being assigned.
 * @returns {void}
 * @throws {TypeError} When the value is a function or an object.
 */
function assertInertHostValue(value, key) {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    throw new TypeError(`Sandboxed code can only assign primitive values to host property "${key}"`);
  }
}

/**
 * Creates the forward membrane owned by one sandbox.
 *
 * Wrappers are cached per sandbox, not per process. A wrapper is a mutable host
 * object that its Arena synchronizes with QuickJS, so a wrapper shared by two
 * sandboxes would let one context replace a method that the other context
 * later calls (issue #3). Within one sandbox the cache still preserves identity
 * for repeated references and cycles.
 *
 * @param {object} [options] Sandbox-scoped collaborators.
 * @param {(result: object) => void} [options.offerJsonTransfer] Marks a fresh
 *   plain-data call result for by-value transfer by the same sandbox's Arena.
 *   Without it, every object result is wrapped.
 * @returns {{makeCallable: Function, bindWebApi: Function, allowWrites: Function, dispose: () => void}}
 *   Membrane operations and the disposer that releases its wrapper cache.
 */
export function createForwardMembrane({ offerJsonTransfer } = {}) {
  // Dropped on disposal so the sandbox stops retaining wrappers for host
  // objects that outlive it.
  let wrapperCache = new WeakMap();
  // Host properties this sandbox may assign, per host object. Grants are
  // read-only unless the policy lists a property under `writable`; the set is
  // resolved once, from the granted root, when the grant is installed. Objects
  // reached later (call results, replaced sub-objects) are never writable.
  const writableKeys = new WeakMap();

  /**
   * Marks the properties named by dotted paths from a granted root writable.
   *
   * @param {object} root Granted host object.
   * @param {string} apiName Name of the grant, for error messages.
   * @param {string[]} paths Dotted property paths from the root.
   * @returns {void}
   * @throws {TypeError} When a path does not name an existing property of a host object.
   */
  function allowWrites(root, apiName, paths) {
    for (const dotted of paths) {
      const parts = dotted.split(".");
      let target = root;
      for (const part of parts.slice(0, -1)) {
        target = target?.[part];
      }
      const key = parts[parts.length - 1];
      if (target === null || typeof target !== "object" || !(key in target)) {
        throw new TypeError(`Writable path ${apiName}.${dotted} does not name an existing property of a host object`);
      }
      if (!writableKeys.has(target)) writableKeys.set(target, new Set());
      writableKeys.get(target).add(key);
    }
  }

  /**
   * Returns the live wrapper cache or rejects use after disposal.
   *
   * @returns {WeakMap<object, object>} Wrapper cache of this sandbox.
   */
  function liveCache() {
    if (wrapperCache === null) throw sandboxDisposedError();
    return wrapperCache;
  }

  /**
   * Wraps a host function so the Arena bridge (which always calls without `new`)
   * can still invoke constructors correctly.
   * Fresh results that are plain JSON data are copied by value; other
   * non-TypedArray objects are wrapped with bindWebApi to preserve internal-slot
   * safety.
   *
   * @param {Function} fn Host function or constructor to expose.
   * @param {unknown} thisArg Native receiver used for ordinary calls.
   * @returns {Function} Boundary-safe callable wrapper.
   */
  function makeCallable(fn, thisArg) {
    return (...args) => {
      liveCache();
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
      // Native instances must keep their real receivers; TypedArrays instead use
      // copy-based custom marshalling.
      if (result !== null && typeof result === "object" && !isTypedArrayView(result)) {
        // A fresh array or plain-object result (for example formatToParts()) has
        // no internal slots, so QuickJS receives a real copy instead of a wrapper
        // with one host accessor or method per property.
        if (offerJsonTransfer && isPlainJsonGraph(result)) {
          offerJsonTransfer(result);
          return result;
        }
        return bindWebApi(result);
      }
      return result;
    };
  }

  /**
   * Wraps a host WebAPI object before passing it through arena.sync().
   * Walks the full prototype chain (stopping before Object.prototype) and:
   *  - Binds each function to its native owner (preserves internal slots)
   *  - Lazily wraps nested objects via a get accessor
   * Uses this sandbox's WeakMap cache to handle circular references and
   * preserve identity.
   *
   * @param {unknown} apiObject Host value permitted by the sandbox policy.
   * @returns {unknown} Primitive input unchanged or an identity-cached wrapper.
   */
  function bindWebApi(apiObject) {
    if (typeof apiObject !== "object" || apiObject === null) {
      return apiObject;
    }

    const cache = liveCache();
    if (cache.has(apiObject)) {
      return cache.get(apiObject);
    }

    const boundObject = {};
    cache.set(apiObject, boundObject);

    let keys = [];
    try {
      // Built-in methods are commonly non-enumerable and live on prototypes.
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
            /** Reads and recursively wraps the current host property value. */
            get: () => bindWebApi(apiObject[key]),
            /**
             * Writes a primitive through to the host object when the policy
             * made this property writable; every other assignment fails.
             */
            set: (val) => {
              liveCache();
              if (!writableKeys.get(apiObject)?.has(key)) {
                throw new TypeError(`Sandboxed code may not assign host property "${key}": the grant is read-only`);
              }
              assertInertHostValue(val, key);
              apiObject[key] = val;
            },
          });
        }
      } catch (err) {}
    }

    return boundObject;
  }

  return {
    makeCallable,
    bindWebApi,
    allowWrites,
    /** Releases the wrapper cache; later membrane use throws. */
    dispose: () => {
      wrapperCache = null;
    },
  };
}
