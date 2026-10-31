/**
 * By-value transfer of fresh host call results that are plain JSON data.
 *
 * Arena normally marshals host objects as identity-tracked QuickJS objects,
 * which costs several boundary crossings per object and keeps every object
 * registered for the lifetime of the sandbox. A host Web API call result that
 * consists only of arrays, plain objects, and JSON primitives has no internal
 * slots or identity to preserve, so it is copied with one JSON crossing.
 */

/** Upper bound on visited values before falling back to Arena marshalling. */
const MAX_JSON_NODES = 10000;

/**
 * Tests whether a value round-trips through JSON without observable loss.
 *
 * Rejects functions, symbols, `undefined`, bigints, non-finite numbers, `-0`,
 * accessors, non-enumerable or symbol keys, array holes or extra array
 * properties, non-plain prototypes, and shared or cyclic references.
 *
 * @param {unknown} root Candidate value.
 * @returns {boolean} Whether JSON copying is lossless for the value.
 */
export function isPlainJsonGraph(root) {
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (value === null) continue;
    switch (typeof value) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(value) || Object.is(value, -0)) return false;
        continue;
      case "object":
        break;
      default:
        return false;
    }
    if (seen.has(value) || seen.size >= MAX_JSON_NODES) return false;
    seen.add(value);

    const isArray = Array.isArray(value);
    const proto = Object.getPrototypeOf(value);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    // Arrays own their indices plus `length`; anything else is a hole or extra.
    if (isArray && keys.length !== value.length + 1) return false;
    for (const key of keys) {
      if (typeof key !== "string") return false;
      if (isArray && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!("value" in descriptor) || !descriptor.enumerable) return false;
      pending.push(descriptor.value);
    }
  }
  return true;
}

/**
 * Creates the offer set that links one sandbox's forward membrane to the
 * Arena marshalling of the same sandbox.
 *
 * Offers are scoped to the sandbox so a result produced for one QuickJS
 * context can never change how another context's Arena marshals it.
 *
 * @returns {{offer: (result: object) => void, take: (value: unknown) => boolean}}
 *   `offer` marks a fresh host call result as eligible for by-value transfer;
 *   `take` consumes an offer and confirms the value is still plain JSON data.
 */
export function createJsonTransfer() {
  // Results offered by the forward membrane; each entry is consumed once.
  const offeredResults = new WeakSet();
  return {
    /** Marks a fresh host call result as eligible for by-value transfer. */
    offer: (result) => {
      offeredResults.add(result);
    },
    /** Consumes an offer and re-checks that the value is still plain JSON data. */
    take: (value) => {
      if ((typeof value !== "object" || value === null) || !offeredResults.has(value)) {
        return false;
      }
      offeredResults.delete(value);
      return isPlainJsonGraph(value);
    },
  };
}
