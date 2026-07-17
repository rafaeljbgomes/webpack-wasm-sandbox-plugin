// Forward membrane: wraps host objects and functions before exposure to the QJS Arena.
// Prevents internal-slot errors by binding methods to their native owner.

import { isTypedArrayView, REQUIRES_NEW_RE } from "../core/sb-utils.js";
import { recordCrossing } from "../../performance-harness/runtime-metrics.js";

const wrapperCache = new WeakMap();

/**
 * Wraps a host function so the Arena bridge (which always calls without `new`)
 * can still invoke constructors correctly.
 * Constructor return values that are non-TypedArray objects are recursively
 * wrapped with bindWebApi to preserve internal-slot safety.
 */
export function makeCallable(fn, thisArg) {
  return (...args) => {
    for (const arg of args) {
      recordCrossing("forward", "vm_to_host", arg);
    }

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
    if (result !== null && typeof result === "object" && !isTypedArrayView(result)) {
      result = bindWebApi(result);
    }

    recordCrossing("forward", "host_to_vm", result);
    return result;
  };
}

/**
 * Wraps a host WebAPI object before passing it through arena.sync().
 * Walks the full prototype chain (stopping before Object.prototype) and:
 *  - Binds each function to its native owner (preserves internal slots)
 *  - Lazily wraps nested objects via a get accessor
 * Uses a WeakMap cache to handle circular references and preserve identity.
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
          get: () => {
            const result = bindWebApi(apiObject[key]);
            recordCrossing("forward", "host_to_vm", result);
            return result;
          },
          set: (val) => {
            recordCrossing("forward", "vm_to_host", val);
            apiObject[key] = val;
          },
        });
      }
    } catch (err) {}
  }

  return boundObject;
}
