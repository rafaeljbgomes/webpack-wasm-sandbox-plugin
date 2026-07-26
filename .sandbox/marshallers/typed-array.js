/**
 * Copies TypedArray bytes across the boundary so each realm receives a real
 * view instead of a Proxy that fails TypedArray internal-slot checks.
 */

import { isTypedArrayView } from "../core/sb-utils.js";

/**
 * Creates a TypedArray marshaller bound to a specific QJS VM.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createTypedArrayMarshaller(vm) {
  const isTypedArrayInVM = vm.unwrapResult(
    vm.evalCode("(h) => ArrayBuffer.isView(h) && !(h instanceof DataView)"),
  );
  const creators = new Map();
  let getTypeName = null;
  let toExactBuffer = null;

  return {
    /** Prevents Arena from proxy-wrapping host TypedArray views. */
    isWrappable(value) {
      return !isTypedArrayView(value);
    },

    /** Routes QuickJS TypedArray handles to the custom unmarshaller. */
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isTypedArrayInVM, ctx.undefined, handle),
      );
      const isTA = ctx.dump(result);
      result.dispose();
      return !isTA;
    },

    /** Copies the visible bytes of a host TypedArray into QuickJS. */
    marshal(value, ctx) {
      if (!isTypedArrayView(value)) return undefined;
      const typeName = value.constructor.name;
      const slicedBuffer = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
      const bufHandle = ctx.newArrayBuffer(slicedBuffer);
      if (!creators.has(typeName)) {
        creators.set(
          typeName,
          ctx.unwrapResult(ctx.evalCode(`(buf) => new ${typeName}(buf)`)),
        );
      }
      const result = ctx.unwrapResult(
        ctx.callFunction(creators.get(typeName), ctx.undefined, bufHandle),
      );
      bufHandle.dispose();
      return result;
    },

    /** Copies a QuickJS TypedArray out of WASM memory into a host view. */
    unmarshal(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return undefined;
      const checkResult = ctx.unwrapResult(
        ctx.callFunction(isTypedArrayInVM, ctx.undefined, handle),
      );
      const isTA = ctx.dump(checkResult);
      checkResult.dispose();
      if (!isTA) return undefined;

      // Compile metadata readers only after the first matching handle.
      if (!getTypeName) {
        getTypeName = ctx.unwrapResult(
          ctx.evalCode("(h) => h.constructor.name"),
        );
        toExactBuffer = ctx.unwrapResult(
          ctx.evalCode(
            "(h) => h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)",
          ),
        );
      }

      const typeNameHandle = ctx.unwrapResult(
        ctx.callFunction(getTypeName, ctx.undefined, handle),
      );
      const typeName = ctx.getString(typeNameHandle);
      typeNameHandle.dispose();

      const exactBufHandle = ctx.unwrapResult(
        ctx.callFunction(toExactBuffer, ctx.undefined, handle),
      );
      // The returned view aliases WASM memory, so copy before disposing it.
      const rawBytesLifetime = ctx.getArrayBuffer(exactBufHandle);
      exactBufHandle.dispose();
      const rawBytes = rawBytesLifetime.value.slice();
      rawBytesLifetime.dispose();

      const TypedArrayCtor = globalThis[typeName];
      if (!TypedArrayCtor) return undefined;
      return new TypedArrayCtor(rawBytes.buffer);
    },

    /** Releases compiled QuickJS helper functions. */
    dispose() {
      if (isTypedArrayInVM.alive) isTypedArrayInVM.dispose();
      if (getTypeName && getTypeName.alive) getTypeName.dispose();
      if (toExactBuffer && toExactBuffer.alive) toExactBuffer.dispose();
      for (const fn of creators.values()) {
        if (fn.alive) fn.dispose();
      }
    },
  };
}
