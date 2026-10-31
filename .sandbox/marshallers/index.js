/** Composes the registered type marshallers into one Arena configuration. */

import { createTypedArrayMarshaller } from "./typed-array.js";
import { createRegExpMarshaller } from "./regexp.js";
import { createArgumentsMarshaller } from "./arguments.js";
import { createErrorMarshaller } from "./error.js";

/**
 * Compiles one QuickJS predicate that reports which registered marshaller, if
 * any, claims a handle. Each marshaller contributes its `handleTest` source,
 * evaluated in registration order so the first claim wins as before.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @param {object[]} marshallers Registered marshallers in priority order.
 * @returns {import("quickjs-emscripten").QuickJSHandle} Classifier returning an index or -1.
 */
function compileClassifier(vm, marshallers) {
  const tests = marshallers
    .map((m, index) => `if (${m.handleTest}) return ${index};`)
    .join("\n      ");
  return vm.unwrapResult(
    vm.evalCode(`(h) => {
      if (typeof h !== "object" || h === null) return -1;
      ${tests}
      return -1;
    }`),
  );
}

/**
 * Builds the Arena options object and a paired dispose() for a given VM.
 *
 * Arena asks the marshallers whether they claim a handle while wrapping and
 * again while unmarshalling. One classifier call per handle, memoized by handle
 * identity, replaces those repeated per-marshaller boundary calls.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @param {(value: unknown) => boolean} [takeJsonTransfer] Consumes a by-value
 *   transfer offer made by the same sandbox's forward membrane. Without it,
 *   every host object is identity-tracked.
 * @returns {{arenaOptions: object, dispose: Function}} Arena hooks and their disposer.
 */
export function createArenaConfig(vm, takeJsonTransfer = () => false) {
  const marshallers = [
    createTypedArrayMarshaller(vm),
    createRegExpMarshaller(vm),
    createArgumentsMarshaller(vm),
    createErrorMarshaller(vm),
  ];

  // Compiled before library code runs; the predicates keep the original
  // marshaller tests and their registration order.
  const classifier = compileClassifier(vm, marshallers);
  // A handle always refers to the same QuickJS value, so its claim is stable.
  const claims = new WeakMap();

  /**
   * Returns the index of the marshaller that claims a handle, or -1.
   *
   * @param {import("quickjs-emscripten").QuickJSHandle} handle QuickJS value.
   * @param {import("quickjs-emscripten").QuickJSContext} ctx Owning context.
   * @returns {number} Claiming marshaller index.
   */
  function classify(handle, ctx) {
    let claim = claims.get(handle);
    if (claim === undefined) {
      const result = ctx.unwrapResult(ctx.callFunction(classifier, ctx.undefined, handle));
      claim = ctx.getNumber(result);
      result.dispose();
      claims.set(handle, claim);
    }
    return claim;
  }

  const arenaOptions = {
    /** Copies offered plain-data call results by value; tracks everything else. */
    isMarshalable: (target) => (takeJsonTransfer(target) ? "json" : true),

    /** Allows default host wrapping only when no custom marshaller claims the value. */
    isWrappable: (value) => marshallers.every((m) => m.isWrappable(value)),

    /** Routes claimed QuickJS handles to custom unmarshalling before Arena wraps them. */
    isHandleWrappable: (handle, ctx) => classify(handle, ctx) < 0,

    /** Attempts host-to-QuickJS conversion with each registered marshaller. */
    customMarshaller: marshallers.map((m) => (value, ctx) => m.marshal(value, ctx)),

    /** Converts a QuickJS value only with the marshaller that claimed it. */
    customUnmarshaller: marshallers.map((m, index) => (handle, ctx) =>
      classify(handle, ctx) === index ? m.unmarshalClaimed(handle, ctx) : undefined,
    ),
  };

  /** Releases the classifier and every handle cached by the registered marshallers. */
  function dispose() {
    if (classifier.alive) classifier.dispose();
    for (const m of marshallers) m.dispose();
  }

  return { arenaOptions, dispose };
}
