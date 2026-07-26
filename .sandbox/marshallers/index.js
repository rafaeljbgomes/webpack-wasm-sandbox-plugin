/** Composes the registered type marshallers into one Arena configuration. */

import { createTypedArrayMarshaller } from "./typed-array.js";
import { createRegExpMarshaller } from "./regexp.js";
import { createArgumentsMarshaller } from "./arguments.js";
import { createErrorMarshaller } from "./error.js";

/**
 * Builds the Arena options object and a paired dispose() for a given VM.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {{arenaOptions: object, dispose: Function}} Arena hooks and their disposer.
 */
export function createArenaConfig(vm) {
  const marshallers = [
    createTypedArrayMarshaller(vm),
    createRegExpMarshaller(vm),
    createArgumentsMarshaller(vm),
    createErrorMarshaller(vm),
  ];

  const arenaOptions = {
    isMarshalable: true,

    /** Allows default host wrapping only when no custom marshaller claims the value. */
    isWrappable: (value) => marshallers.every((m) => m.isWrappable(value)),

    /** Routes claimed QuickJS handles to custom unmarshalling before Arena wraps them. */
    isHandleWrappable: (handle, ctx) =>
      marshallers.every((m) => m.isHandleWrappable(handle, ctx)),

    /** Attempts host-to-QuickJS conversion with each registered marshaller. */
    customMarshaller: marshallers.map((m) => (value, ctx) => m.marshal(value, ctx)),

    /** Attempts QuickJS-to-host conversion with each registered marshaller. */
    customUnmarshaller: marshallers.map((m) => (handle, ctx) => m.unmarshal(handle, ctx)),
  };

  /** Releases every handle cached by the registered marshallers. */
  function dispose() {
    for (const m of marshallers) m.dispose();
  }

  return { arenaOptions, dispose };
}
