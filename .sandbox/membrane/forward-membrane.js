import { isTypedArrayView, REQUIRES_NEW_RE, sandboxDisposedError } from "../core/sb-utils.js";
import { isPlainJsonGraph } from "../core/json-transfer.js";

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
 * @returns {{makeCallable: Function, bindWebApi: Function, dispose: () => void}}
 *   Membrane operations and the disposer that releases its wrapper cache.
 */
export function createForwardMembrane({ offerJsonTransfer } = {}) {
  // Dropped on disposal so the sandbox stops retaining wrappers for host
  // objects that outlive it.
  let wrapperCache = new WeakMap();

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
            /** Applies an allowed assignment to the underlying host object. */
            set: (val) => {
              liveCache();
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
    /** Releases the wrapper cache; later membrane use throws. */
    dispose: () => {
      wrapperCache = null;
    },
  };
}
