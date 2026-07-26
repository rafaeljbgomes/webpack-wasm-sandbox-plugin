/**
 * Copies RegExp source and flags across the boundary so each realm receives a
 * real RegExp with the internal slots required by native methods.
 */

/**
 * Creates a RegExp marshaller bound to a specific QJS VM.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createRegExpMarshaller(vm) {
  const isRegExpInVM = vm.unwrapResult(
    vm.evalCode("(h) => h instanceof RegExp"),
  );
  let creator = null;
  let getSource = null;
  let getFlags = null;

  return {
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
      const isRE = ctx.dump(result);
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
      if (ctx.typeof(handle) !== "object") return undefined;
      const checkResult = ctx.unwrapResult(
        ctx.callFunction(isRegExpInVM, ctx.undefined, handle),
      );
      const isRE = ctx.dump(checkResult);
      checkResult.dispose();
      if (!isRE) return undefined;

      // Compile property readers only after the first matching handle.
      if (!getSource) {
        getSource = ctx.unwrapResult(ctx.evalCode("(h) => h.source"));
        getFlags = ctx.unwrapResult(ctx.evalCode("(h) => h.flags"));
      }

      const srcHandle = ctx.unwrapResult(
        ctx.callFunction(getSource, ctx.undefined, handle),
      );
      const flagsHandle = ctx.unwrapResult(
        ctx.callFunction(getFlags, ctx.undefined, handle),
      );
      const source = ctx.getString(srcHandle);
      const flags = ctx.getString(flagsHandle);
      srcHandle.dispose();
      flagsHandle.dispose();
      return new RegExp(source, flags);
    },

    /** Releases compiled QuickJS helper functions. */
    dispose() {
      if (isRegExpInVM.alive) isRegExpInVM.dispose();
      if (creator && creator.alive) creator.dispose();
      if (getSource && getSource.alive) getSource.dispose();
      if (getFlags && getFlags.alive) getFlags.dispose();
    },
  };
}
