/**
 * Copies, by value, arrays that carry extra own-enumerable properties beyond
 * their indices (for example the token list a Markdown lexer returns, which is
 * an array that also holds a `links` map).
 *
 * The Arena's default object unmarshaller registers the host copy of such an
 * array by VM-value identity and reuses it on later crossings. When the array
 * is first seen empty (e.g. a `this.tokens = []` set in a constructor that a
 * later method fills), the host keeps that empty copy even after the VM array
 * is filled, so its elements are lost. Claiming the array here makes the Arena
 * treat it as non-wrappable, which skips that registration: the value is
 * re-copied on every crossing and always reflects the current VM state.
 *
 * Only arrays whose whole reachable graph is transferable (see
 * value-transfer.js) are claimed. Anything else is left to the default path.
 */

import { transferTest, SERIALIZER_SRC, decode } from "./value-transfer.js";

// `h` is an array that has at least one own-enumerable property beyond its
// indices, and whose whole graph is transferable.
const HAS_EXTRA = `Array.isArray(h) && (function () {
  for (var ks = Object.keys(h), i = 0; i < ks.length; i++) {
    var n = +ks[i];
    if (!(Number.isInteger(n) && n >= 0 && n < h.length && String(n) === ks[i])) return true;
  }
  return false;
})()`;
const HANDLE_TEST = transferTest(HAS_EXTRA);

/**
 * Creates the extra-property array marshaller bound to one QuickJS context.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createArrayExtrasMarshaller(vm) {
  const tester = vm.unwrapResult(vm.evalCode(`(h) => ${HANDLE_TEST}`));
  const serializer = vm.unwrapResult(vm.evalCode(SERIALIZER_SRC));

  /** Whether the handle is an extra-property array with a transferable graph. */
  function claims(handle, ctx) {
    if (ctx.typeof(handle) !== "object") return false;
    const result = ctx.unwrapResult(ctx.callFunction(tester, ctx.undefined, handle));
    const yes = ctx.dump(result) === true;
    result.dispose();
    return yes;
  }

  /** Copies a claimed VM array (with its extra properties) to a fresh host array. */
  function copyOut(handle, ctx) {
    const strHandle = ctx.unwrapResult(ctx.callFunction(serializer, ctx.undefined, handle));
    const encoded = ctx.getString(strHandle);
    strHandle.dispose();
    return decode(JSON.parse(encoded));
  }

  return {
    /** QuickJS expression over `h` used by the combined Arena classifier. */
    handleTest: HANDLE_TEST,

    /** Host arrays are marshalled host-to-VM by the default path. */
    isWrappable() {
      return true;
    },

    /** Claims matching QuickJS arrays so the Arena copies them by value. */
    isHandleWrappable(handle, ctx) {
      return !claims(handle, ctx);
    },

    /** This marshaller does not convert host values into QuickJS. */
    marshal() {
      return undefined;
    },

    /** Copies a claimed VM array to the host. */
    unmarshal(handle, ctx) {
      if (!claims(handle, ctx)) return undefined;
      return copyOut(handle, ctx);
    },

    /** Copies a handle that the combined classifier already claimed. */
    unmarshalClaimed: copyOut,

    /** Releases compiled QuickJS helper functions. */
    dispose() {
      if (tester.alive) tester.dispose();
      if (serializer.alive) serializer.dispose();
    },
  };
}
