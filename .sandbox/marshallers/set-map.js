/**
 * Copies Set and Map instances by value across the boundary.
 *
 * Neither Set nor Map survives the Arena's default marshalling: a host Set
 * passed into the VM becomes a plain object (its methods throw "incompatible
 * receiver"), and a VM Set returned to the host becomes an empty, non-iterable
 * proxy whose methods throw "Set object expected". The second case also makes
 * test runners crash while pretty-printing a failed value, which aborts the
 * rest of the file. Claiming Set and Map here copies their contents in one
 * crossing in each direction.
 *
 * Only Set and Map whose whole reachable graph is transferable (see
 * value-transfer.js) are claimed; keys and values that are themselves objects
 * are copied by value, so object identity and non-data keys are not preserved.
 * A Set or Map with a non-transferable member is left to the default path.
 */

import {
  transferTest,
  SERIALIZER_SRC,
  VM_DECODER_SRC,
  decode,
  serializeHost,
} from "./value-transfer.js";

const ROOT_TEST = "(h instanceof Set || h instanceof Map)";
const HANDLE_TEST = transferTest(ROOT_TEST);

/**
 * Creates the Set/Map marshaller bound to one QuickJS context.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createSetMapMarshaller(vm) {
  const tester = vm.unwrapResult(vm.evalCode(`(h) => ${HANDLE_TEST}`));
  const serializer = vm.unwrapResult(vm.evalCode(SERIALIZER_SRC));
  const builder = vm.unwrapResult(vm.evalCode(VM_DECODER_SRC));

  /** Whether the handle is a Set or Map with a transferable graph. */
  function claims(handle, ctx) {
    if (ctx.typeof(handle) !== "object") return false;
    const result = ctx.unwrapResult(ctx.callFunction(tester, ctx.undefined, handle));
    const yes = ctx.dump(result) === true;
    result.dispose();
    return yes;
  }

  /** Copies a claimed VM Set or Map to a fresh host Set or Map. */
  function copyOut(handle, ctx) {
    const strHandle = ctx.unwrapResult(ctx.callFunction(serializer, ctx.undefined, handle));
    const encoded = ctx.getString(strHandle);
    strHandle.dispose();
    return decode(JSON.parse(encoded));
  }

  return {
    /** QuickJS expression over `h` used by the combined Arena classifier. */
    handleTest: HANDLE_TEST,

    /** Prevents Arena from proxy-wrapping host Set and Map instances. */
    isWrappable(value) {
      if (!(value instanceof Set) && !(value instanceof Map)) return true;
      try {
        serializeHost(value);
        return false;
      } catch {
        // Not transferable (e.g. an object member); leave it to the default path.
        return true;
      }
    },

    /** Claims matching QuickJS Set/Map so the Arena copies them by value. */
    isHandleWrappable(handle, ctx) {
      return !claims(handle, ctx);
    },

    /** Copies a host Set or Map into a real QuickJS Set or Map. */
    marshal(value, ctx) {
      if (!(value instanceof Set) && !(value instanceof Map)) return undefined;
      let encoded;
      try {
        encoded = serializeHost(value);
      } catch {
        return undefined;
      }
      const strHandle = ctx.newString(encoded);
      const result = ctx.unwrapResult(ctx.callFunction(builder, ctx.undefined, strHandle));
      strHandle.dispose();
      return result;
    },

    /** Copies a claimed VM Set or Map to the host. */
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
      if (builder.alive) builder.dispose();
    },
  };
}
