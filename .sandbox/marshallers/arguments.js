/**
 * Preserves Arguments semantics by representing the value as a tagged QuickJS
 * array and reconstructing Arguments identity when it returns to the host.
 */

const ARG_TAG = "__qjsArguments__";

const ARGS_TOSTRING = "[object Arguments]";

// Values whose tag is being read. A host copy of a QuickJS prototype can carry
// a Symbol.toStringTag accessor that calls back into QuickJS with the same
// value as receiver, which asks this marshaller about the value again.
const tagChecksInProgress = new Set();

/**
 * Tests whether a host value has Arguments identity.
 *
 * @param {unknown} value Value to inspect.
 * @returns {boolean} Whether the value is an Arguments object.
 */
function isArguments(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return false;
  }
  // Re-entry means the tag accessor is running, so the value is not a native
  // Arguments object (whose tag comes from an internal slot, not an accessor).
  if (tagChecksInProgress.has(value)) return false;
  tagChecksInProgress.add(value);
  try {
    return Object.prototype.toString.call(value) === ARGS_TOSTRING;
  } finally {
    tagChecksInProgress.delete(value);
  }
}

/**
 * Creates an Arguments marshaller bound to a specific QJS VM.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createArgumentsMarshaller(vm) {
  // The detector is shared by classification and unmarshalling.
  const isArgTagInVM = vm.unwrapResult(
    vm.evalCode(`(h) => Array.isArray(h) && h.${ARG_TAG} === true`),
  );

  // Compile the constructor lazily because this marshaller may never be used.
  let creator = null;

  /**
   * Reconstructs host Arguments from a handle already known to be tagged.
   *
   * @param {import("quickjs-emscripten").QuickJSHandle} handle Tagged QuickJS array.
   * @param {import("quickjs-emscripten").QuickJSContext} ctx Owning context.
   * @returns {IArguments} Host Arguments object.
   */
  function copyOut(handle, ctx) {
    const dumped = ctx.dump(handle);
    const elems = Array.isArray(dumped) ? dumped : [];
    return (function () {
      return arguments;
    }.apply(undefined, elems));
  }

  return {
    /** QuickJS expression over `h` used by the combined Arena classifier. */
    handleTest: `Array.isArray(h) && h.${ARG_TAG} === true`,

    /** Prevents Arena from proxy-wrapping host Arguments objects. */
    isWrappable(value) {
      return !isArguments(value);
    },

    /** Routes tagged QuickJS arrays to the custom unmarshaller. */
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isArgTagInVM, ctx.undefined, handle),
      );
      const isArg = ctx.getNumber(result) !== 0;
      result.dispose();
      return !isArg;
    },

    /** Copies host Arguments into a tagged QuickJS array. */
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
      // JSON-compatible copying intentionally does not preserve functions or symbols.
      const jsonHandle = ctx.newString(JSON.stringify(elems));
      const result = ctx.unwrapResult(
        ctx.callFunction(creator, ctx.undefined, jsonHandle),
      );
      jsonHandle.dispose();
      return result;
    },

    /** Reconstructs host Arguments from a tagged QuickJS array. */
    unmarshal(handle, ctx) {
      if (this.isHandleWrappable(handle, ctx)) return undefined;
      return copyOut(handle, ctx);
    },

    /** Reconstructs a handle that the combined classifier already claimed. */
    unmarshalClaimed: copyOut,

    /** Releases compiled QuickJS helper functions. */
    dispose() {
      if (isArgTagInVM.alive) isArgTagInVM.dispose();
      if (creator && creator.alive) creator.dispose();
    },
  };
}
