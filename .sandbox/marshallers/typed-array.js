// TypedArray custom marshaller: copies TypedArray views across the host↔QJS
// boundary as value copies, bypassing Arena's sync-proxy mechanism.
// Without this, ArrayBuffer.isView(proxy) returns false inside QJS and all
// typed-array operations break.

import { isTypedArrayView } from "../core/sb-utils.js";

/**
 * Creates a TypedArray marshaller bound to a specific QJS VM.
 * Returns { isWrappable, isHandleWrappable, marshal, unmarshal, dispose }.
 *
 * State held per-sandbox:
 *   isTypedArrayInVM  – pre-compiled QJS detector, shared by isHandleWrappable
 *                       and unmarshal (avoids compiling the same code twice)
 *   creators          – one cached QJS constructor fn per TypedArray type name
 *   getTypeName       – lazily compiled, only created on first unmarshal hit
 *   toExactBuffer     – same
 */
export function createTypedArrayMarshaller(vm) {
  const isTypedArrayInVM = vm.unwrapResult(
    vm.evalCode("(h) => ArrayBuffer.isView(h) && !(h instanceof DataView)"),
  );
  const creators = new Map();
  let getTypeName = null;
  let toExactBuffer = null;

  return {
    // host-side guard: skip proxy wrapping for TypedArray views
    isWrappable(value) {
      return !isTypedArrayView(value);
    },

    // QJS-side guard: skip _wrapHandle so the raw handle reaches unmarshal
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isTypedArrayInVM, ctx.undefined, handle),
      );
      const isTA = ctx.dump(result);
      result.dispose();
      return !isTA;
    },

    // host TypedArray → QJS TypedArray (copy-by-value, preserves byteOffset)
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

    // QJS TypedArray → host TypedArray (read from WASM memory, safe copy)
    unmarshal(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return undefined;
      const checkResult = ctx.unwrapResult(
        ctx.callFunction(isTypedArrayInVM, ctx.undefined, handle),
      );
      const isTA = ctx.dump(checkResult);
      checkResult.dispose();
      if (!isTA) return undefined;

      // Init lazily: only needed when we actually encounter a QJS TypedArray
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
      // .value is a view into WASM memory; slice() makes a safe host copy
      const rawBytesLifetime = ctx.getArrayBuffer(exactBufHandle);
      exactBufHandle.dispose();
      const rawBytes = rawBytesLifetime.value.slice();
      rawBytesLifetime.dispose();

      const TypedArrayCtor = globalThis[typeName];
      if (!TypedArrayCtor) return undefined;
      return new TypedArrayCtor(rawBytes.buffer);
    },

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
