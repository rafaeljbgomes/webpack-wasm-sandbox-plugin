/**
 * Copies TypedArray bytes across the boundary so each realm receives a real
 * view instead of a Proxy that fails TypedArray internal-slot checks.
 */

import { isTypedArrayView } from "../core/sb-utils.js";

/** QuickJS predicate used by both the standalone check and the classifier. */
const TYPED_ARRAY_TEST = "ArrayBuffer.isView(h) && !(h instanceof DataView)";

/**
 * Host constructors that a QuickJS-reported typed-array name may select. The
 * name is guest-controlled (`h.constructor.name`), so it must never resolve to
 * an arbitrary host global.
 */
const TYPED_ARRAY_CONSTRUCTORS = new Map(
  [
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ]
    .filter((name) => typeof globalThis[name] === "function")
    .map((name) => [name, globalThis[name]]),
);

/**
 * Creates a TypedArray marshaller bound to a specific QJS VM.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createTypedArrayMarshaller(vm) {
  const isTypedArrayInVM = vm.unwrapResult(vm.evalCode(`(h) => ${TYPED_ARRAY_TEST}`));
  const creators = new Map();
  let getTypeName = null;
  let toExactBuffer = null;

  /**
   * Copies a handle already known to be a QuickJS TypedArray into a host view.
   *
   * @param {import("quickjs-emscripten").QuickJSHandle} handle QuickJS TypedArray.
   * @param {import("quickjs-emscripten").QuickJSContext} ctx Owning context.
   * @returns {ArrayBufferView|undefined} Host copy, or undefined for unsupported names.
   */
  function copyOut(handle, ctx) {
    // Compile metadata readers only after the first matching handle.
    if (!getTypeName) {
      getTypeName = ctx.unwrapResult(ctx.evalCode("(h) => h.constructor.name"));
      toExactBuffer = ctx.unwrapResult(
        ctx.evalCode("(h) => h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength)"),
      );
    }

    const typeNameHandle = ctx.unwrapResult(
      ctx.callFunction(getTypeName, ctx.undefined, handle),
    );
    const typeName = ctx.typeof(typeNameHandle) === "string" ? ctx.getString(typeNameHandle) : "";
    typeNameHandle.dispose();
    const TypedArrayCtor = TYPED_ARRAY_CONSTRUCTORS.get(typeName);
    if (!TypedArrayCtor) return undefined;

    const exactBufHandle = ctx.unwrapResult(
      ctx.callFunction(toExactBuffer, ctx.undefined, handle),
    );
    // The returned view aliases WASM memory, so copy before disposing it.
    const rawBytesLifetime = ctx.getArrayBuffer(exactBufHandle);
    const rawBytes = rawBytesLifetime.value.slice();
    rawBytesLifetime.dispose();
    exactBufHandle.dispose();

    return new TypedArrayCtor(rawBytes.buffer);
  }

  return {
    /** QuickJS expression over `h` used by the combined Arena classifier. */
    handleTest: TYPED_ARRAY_TEST,

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
      const isTA = ctx.getNumber(result) !== 0;
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
      if (this.isHandleWrappable(handle, ctx)) return undefined;
      return copyOut(handle, ctx);
    },

    /** Copies a handle that the combined classifier already claimed. */
    unmarshalClaimed: copyOut,

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
