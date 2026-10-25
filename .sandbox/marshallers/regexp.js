/**
 * Copies RegExp source and flags across the boundary so each realm receives a
 * real RegExp with the internal slots required by native methods.
 */

/** QuickJS predicate used by both the standalone check and the classifier. */
const REGEXP_TEST = "h instanceof RegExp";

/**
 * Creates a RegExp marshaller bound to a specific QJS VM.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createRegExpMarshaller(vm) {
  const isRegExpInVM = vm.unwrapResult(
    vm.evalCode(`(h) => ${REGEXP_TEST}`),
  );
  let creator = null;
  let getPattern = null;

  /**
   * Recreates a handle already known to be a QuickJS RegExp on the host.
   *
   * @param {import("quickjs-emscripten").QuickJSHandle} handle QuickJS RegExp.
   * @param {import("quickjs-emscripten").QuickJSContext} ctx Owning context.
   * @returns {RegExp} Host RegExp with the same source and flags.
   */
  function copyOut(handle, ctx) {
    // Read source then flags in one crossing, length-prefixing the source so
    // the two strings can be separated without a delimiter.
    getPattern ??= ctx.unwrapResult(
      ctx.evalCode('(h) => { const s = "" + h.source; const f = "" + h.flags; return s.length + ":" + s + f; }'),
    );
    const patternHandle = ctx.unwrapResult(
      ctx.callFunction(getPattern, ctx.undefined, handle),
    );
    const encoded = ctx.getString(patternHandle);
    patternHandle.dispose();
    const separator = encoded.indexOf(":");
    const sourceEnd = separator + 1 + Number(encoded.slice(0, separator));
    return new RegExp(encoded.slice(separator + 1, sourceEnd), encoded.slice(sourceEnd));
  }

  return {
    /** QuickJS expression over `h` used by the combined Arena classifier. */
    handleTest: REGEXP_TEST,

    /** Prevents Arena from proxy-wrapping host RegExp instances. */
    isWrappable(value) {
      return !(value instanceof RegExp);
    },

    /** Routes QuickJS RegExp handles to the custom unmarshaller. */
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isRegExpInVM, ctx.undefined, handle),
      );
      const isRE = ctx.getNumber(result) !== 0;
      result.dispose();
      return !isRE;
    },

    /** Copies a host RegExp into QuickJS using its source and flags. */
    marshal(value, ctx) {
      if (!(value instanceof RegExp)) return undefined;
      const sourceHandle = ctx.newString(value.source);
      const flagsHandle = ctx.newString(value.flags);
      if (!creator) {
        creator = ctx.unwrapResult(
          ctx.evalCode("(src, flags) => new RegExp(src, flags)"),
        );
      }
      const result = ctx.unwrapResult(
        ctx.callFunction(creator, ctx.undefined, sourceHandle, flagsHandle),
      );
      sourceHandle.dispose();
      flagsHandle.dispose();
      return result;
    },

    /** Copies a QuickJS RegExp into a new host RegExp. */
    unmarshal(handle, ctx) {
      if (this.isHandleWrappable(handle, ctx)) return undefined;
      return copyOut(handle, ctx);
    },

    /** Copies a handle that the combined classifier already claimed. */
    unmarshalClaimed: copyOut,

    /** Releases compiled QuickJS helper functions. */
    dispose() {
      if (isRegExpInVM.alive) isRegExpInVM.dispose();
      if (creator && creator.alive) creator.dispose();
      if (getPattern && getPattern.alive) getPattern.dispose();
    },
  };
}
