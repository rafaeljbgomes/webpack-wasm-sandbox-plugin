// RegExp custom marshaller: copies RegExp values across the host↔QJS boundary.
// Without this, Arena wraps a host RegExp in a sync-Proxy, and methods like
// RegExp.prototype.exec throw "incompatible receiver" inside QJS because they
// require a real RegExp internal slot.

/**
 * Creates a RegExp marshaller bound to a specific QJS VM.
 * Returns { isWrappable, isHandleWrappable, marshal, unmarshal, dispose }.
 *
 * State held per-sandbox:
 *   isRegExpInVM  – pre-compiled QJS detector, shared by isHandleWrappable
 *                   and unmarshal (avoids compiling the same code twice)
 *   creator       – lazily compiled QJS constructor helper (marshal path)
 *   getSource     – lazily compiled, only created on first unmarshal hit
 *   getFlags      – same
 */
export function createRegExpMarshaller(vm) {
  const isRegExpInVM = vm.unwrapResult(
    vm.evalCode("(h) => h instanceof RegExp"),
  );
  let creator = null;
  let getSource = null;
  let getFlags = null;

  return {
    // host-side guard: skip proxy wrapping for RegExp instances
    isWrappable(value) {
      return !(value instanceof RegExp);
    },

    // QJS-side guard: skip _wrapHandle so the raw handle reaches unmarshal
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isRegExpInVM, ctx.undefined, handle),
      );
      const isRE = ctx.dump(result);
      result.dispose();
      return !isRE;
    },

    // host RegExp → QJS RegExp (preserves source + flags)
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

    // QJS RegExp → host RegExp (copy source + flags out of QJS)
    unmarshal(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return undefined;
      const checkResult = ctx.unwrapResult(
        ctx.callFunction(isRegExpInVM, ctx.undefined, handle),
      );
      const isRE = ctx.dump(checkResult);
      checkResult.dispose();
      if (!isRE) return undefined;

      // Init lazily: only needed when we actually encounter a QJS RegExp
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

    dispose() {
      if (isRegExpInVM.alive) isRegExpInVM.dispose();
      if (creator && creator.alive) creator.dispose();
      if (getSource && getSource.alive) getSource.dispose();
      if (getFlags && getFlags.alive) getFlags.dispose();
    },
  };
}
