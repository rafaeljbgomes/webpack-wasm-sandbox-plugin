// Arguments custom marshaller: preserves the array-like identity of host-side
// Arguments objects across the host↔QJS boundary.
//
// Without this, an Arguments object is marshalled as a plain QJS object
// { 0: ..., 1: ..., length: ... } that:
//   - has Object.prototype.toString → "[object Object]" (not "[object Arguments]")
//   - fails lodash's isArguments() check → isFlattenable() returns false
//   - causes flatten/flattenDeep/flattenDepth to treat it as an opaque value
//
// Strategy:
//   marshal  : convert Arguments → QJS array tagged with __qjsArguments__ = true
//              Lodash sees Array.isArray → true → isFlattenable → true.
//   unmarshal: detect the tag and reconstruct a host Arguments object so that
//              round-tripped values survive deepEqual comparisons.

const ARG_TAG = "__qjsArguments__";

const ARGS_TOSTRING = "[object Arguments]";

function isArguments(value) {
  return Object.prototype.toString.call(value) === ARGS_TOSTRING;
}

/**
 * Creates an Arguments marshaller bound to a specific QJS VM.
 * Returns { isWrappable, isHandleWrappable, marshal, unmarshal, dispose }.
 */
export function createArgumentsMarshaller(vm) {
  // Pre-compile QJS-side tag detector: reused by isHandleWrappable and unmarshal.
  const isArgTagInVM = vm.unwrapResult(
    vm.evalCode(`(h) => Array.isArray(h) && h.${ARG_TAG} === true`),
  );

  // QJS factory: parses a JSON array and stamps the tag on it.
  // Lazily compiled on first marshal hit (ctx may differ from vm in edge cases).
  let creator = null;

  return {
    // host-side guard: intercept Arguments objects before Arena wraps them.
    isWrappable(value) {
      return !isArguments(value);
    },

    // QJS-side guard: intercept tagged arrays so they reach unmarshal instead
    // of Arena's default ctx.dump() path (which would strip the tag).
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isArgTagInVM, ctx.undefined, handle),
      );
      const isArg = ctx.dump(result);
      result.dispose();
      return !isArg;
    },

    // host Arguments → QJS tagged array.
    // Uses JSON serialization which correctly handles primitives, nested arrays,
    // and plain objects — the typical contents of Arguments objects.
    // Non-JSON-serializable elements (functions, symbols) are replaced by null.
    marshal(value, ctx) {
      if (!isArguments(value)) return undefined;

      if (!creator) {
        creator = ctx.unwrapResult(
          ctx.evalCode(
            `(json) => { const arr = JSON.parse(json); arr.${ARG_TAG} = true; return arr; }`,
          ),
        );
      }

      const elems = Array.from(value);
      // JSON.stringify converts non-serializable elements to null; that is
      // acceptable because such Arguments are pathological for QJS anyway.
      const jsonHandle = ctx.newString(JSON.stringify(elems));
      const result = ctx.unwrapResult(
        ctx.callFunction(creator, ctx.undefined, jsonHandle),
      );
      jsonHandle.dispose();
      return result;
    },

    // QJS tagged array → host Arguments object.
    // ctx.dump() returns only indexed values (JSON-like), so the ARG_TAG
    // property is silently dropped — which is exactly what we want here.
    unmarshal(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return undefined;

      const checkResult = ctx.unwrapResult(
        ctx.callFunction(isArgTagInVM, ctx.undefined, handle),
      );
      const isArg = ctx.dump(checkResult);
      checkResult.dispose();
      if (!isArg) return undefined;

      const dumped = ctx.dump(handle); // plain array of indexed values
      const elems = Array.isArray(dumped) ? dumped : [];
      return (function () {
        return arguments;
      }.apply(undefined, elems));
    },

    dispose() {
      if (isArgTagInVM.alive) isArgTagInVM.dispose();
      if (creator && creator.alive) creator.dispose();
    },
  };
}
