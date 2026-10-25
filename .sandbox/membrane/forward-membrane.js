import { isTypedArrayView, REQUIRES_NEW_RE } from "../core/sb-utils.js";
import { isPlainJsonGraph, offerJsonTransfer } from "../core/json-transfer.js";

const wrapperCache = new WeakMap();

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
export function makeCallable(fn, thisArg) {
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
    // Native instances must keep their real receivers; TypedArrays instead use
    // copy-based custom marshalling.
    if (result !== null && typeof result === "object" && !isTypedArrayView(result)) {
      // A fresh array or plain-object result (for example formatToParts()) has
      // no internal slots, so QuickJS receives a real copy instead of a wrapper
      // with one host accessor or method per property.
      if (isPlainJsonGraph(result)) {
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
 * Uses a WeakMap cache to handle circular references and preserve identity.
 *
 * @param {unknown} apiObject Host value permitted by the sandbox policy.
 * @returns {unknown} Primitive input unchanged or an identity-cached wrapper.
 */
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
            apiObject[key] = val;
          },
        });
      }
    } catch (err) {}
  }

  return boundObject;
}
