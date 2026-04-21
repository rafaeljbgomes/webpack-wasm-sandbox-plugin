// Arena configuration factory: composes per-type marshallers into the full
// set of Arena options for a given VM.
//
// To add support for a new type:
//   1. Create .sandbox/marshallers/<type>.js exporting create<Type>Marshaller(vm)
//      with { isWrappable, isHandleWrappable, marshal, unmarshal, dispose }.
//   2. Import it here and add it to the marshallers array below.

import { createTypedArrayMarshaller } from "./typed-array.js";
import { createRegExpMarshaller } from "./regexp.js";
import { createArgumentsMarshaller } from "./arguments.js";
import { createErrorMarshaller } from "./error.js";
import {
  recordMarshal,
  recordUnmarshal,
} from "../../performance-harness/runtime-metrics.js";

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Builds the Arena options object and a paired dispose() for a given VM.
 * Returns { arenaOptions, dispose }.
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

    // A value is wrappable only if no marshaller claims it.
    isWrappable: (value) => marshallers.every((m) => m.isWrappable(value)),

    // A QJS handle is wrappable only if no marshaller claims it.
    // Returning false tells Arena to skip _wrapHandle so the raw handle
    // reaches customUnmarshaller unchanged.
    isHandleWrappable: (handle, ctx) =>
      marshallers.every((m) => m.isHandleWrappable(handle, ctx)),

    customMarshaller: marshallers.map((m) => (value, ctx) => {
      const startedAt = nowMs();
      const result = m.marshal(value, ctx);
      if (result !== undefined) {
        recordMarshal(nowMs() - startedAt, "host_to_vm", value);
      }
      return result;
    }),

    customUnmarshaller: marshallers.map((m) => (handle, ctx) => {
      const startedAt = nowMs();
      const result = m.unmarshal(handle, ctx);
      if (result !== undefined) {
        recordUnmarshal(nowMs() - startedAt, "vm_to_host", result);
      }
      return result;
    }),
  };

  function dispose() {
    for (const m of marshallers) m.dispose();
  }

  return { arenaOptions, dispose };
}
