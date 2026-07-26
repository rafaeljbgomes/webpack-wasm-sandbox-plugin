/**
 * Preserves Error subclass identity and selected structured fields across the
 * boundary instead of exposing errors as generic proxied objects.
 */

const ERROR_CTORS = new Map([
  ["Error", Error],
  ["EvalError", EvalError],
  ["RangeError", RangeError],
  ["ReferenceError", ReferenceError],
  ["SyntaxError", SyntaxError],
  ["TypeError", TypeError],
  ["URIError", URIError],
  ["AggregateError", typeof AggregateError === "function" ? AggregateError : Error],
]);

/**
 * Resolves a supported host Error constructor by name.
 *
 * @param {string} name Error subclass name from QuickJS.
 * @returns {ErrorConstructor} Matching constructor or the base Error class.
 */
function getHostErrorCtor(name) {
  return ERROR_CTORS.get(name) || Error;
}

/**
 * Tests whether a host value should use the Error marshaller.
 *
 * @param {unknown} value Value to inspect.
 * @returns {boolean} Whether the value inherits from Error.
 */
function isErrorLike(value) {
  return value instanceof Error;
}

const EXTRA_ERROR_FIELDS = [
  "errors",
  "inner",
  "path",
  "type",
  "value",
  "params",
  "issues",
];

/**
 * Produces a bounded, cycle-safe representation of an error field.
 *
 * @param {unknown} value Field value to copy.
 * @param {number} [depth=0] Current traversal depth.
 * @param {Set<object>} [seen] Objects already visited during this copy.
 * @returns {unknown} JSON-compatible value, or undefined when unsupported.
 */
function copyJsonSafe(value, depth = 0, seen = new Set()) {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") return value;
  if (valueType === "bigint") return String(value);
  if (valueType === "symbol" || valueType === "function") return undefined;
  if (depth > 4 || seen.has(value)) return undefined;

  seen.add(value);
  if (value instanceof Error) {
    return copyErrorPayload(value, depth + 1, seen);
  }
  if (value instanceof Set) {
    return Array.from(value, (entry) => copyJsonSafe(entry, depth + 1, seen)).slice(0, 100);
  }
  if (value instanceof Map) {
    return Array.from(value, ([key, entry]) => [
      copyJsonSafe(key, depth + 1, seen),
      copyJsonSafe(entry, depth + 1, seen),
    ]).slice(0, 100);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => copyJsonSafe(entry, depth + 1, seen)).slice(0, 100);
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return String(value);
  }

  const output = {};
  for (const key of Object.keys(value).slice(0, 50)) {
    const copied = copyJsonSafe(value[key], depth + 1, seen);
    if (copied !== undefined) output[key] = copied;
  }
  return output;
}

/**
 * Extracts standard Error data and supported library-specific fields.
 *
 * @param {Error} error Error to serialize.
 * @param {number} [depth=0] Current traversal depth.
 * @param {Set<object>} [seen] Objects already visited during this copy.
 * @returns {object} Bounded JSON-compatible error payload.
 */
function copyErrorPayload(error, depth = 0, seen = new Set()) {
  const payload = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  for (const key of EXTRA_ERROR_FIELDS) {
    if (key in error) {
      const copied = copyJsonSafe(error[key], depth + 1, seen);
      if (copied !== undefined) payload[key] = copied;
    }
  }
  return payload;
}

/**
 * Applies deserialized fields to a reconstructed host Error.
 *
 * @param {Error} error Target error instance.
 * @param {unknown} payload Deserialized structured fields.
 * @returns {Error} The enriched target instance.
 */
function applyErrorPayload(error, payload) {
  if (!payload || typeof payload !== "object") return error;
  for (const [key, value] of Object.entries(payload)) {
    try {
      error[key] = value;
    } catch (_e) {}
  }
  return error;
}

/**
 * Creates an Error marshaller bound to a specific QuickJS context.
 *
 * @param {import("quickjs-emscripten").QuickJSContext} vm Owning QuickJS context.
 * @returns {object} Arena marshalling hooks and their disposer.
 */
export function createErrorMarshaller(vm) {
  const isErrorInVM = vm.unwrapResult(
    vm.evalCode("(h) => h instanceof Error"),
  );

  let creator = null;
  let getName = null;
  let getMessage = null;
  let getStack = null;
  let getPayload = null;

  return {
    /** Prevents Arena from proxy-wrapping host Error instances. */
    isWrappable(value) {
      return !isErrorLike(value);
    },

    /** Routes QuickJS Error handles to the custom unmarshaller. */
    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isErrorInVM, ctx.undefined, handle),
      );
      const isErr = ctx.dump(result);
      result.dispose();
      return !isErr;
    },

    /** Reconstructs a host Error inside QuickJS with supported payload fields. */
    marshal(value, ctx) {
      if (!isErrorLike(value)) return undefined;

      if (!creator) {
        creator = ctx.unwrapResult(
          ctx.evalCode(`
            (name, message, stack, payloadJson) => {
              const ErrorCtor = globalThis[name] instanceof Function ? globalThis[name] : Error;
              const err = new ErrorCtor(message);
              if (typeof stack === "string" && stack.length > 0) {
                try { err.stack = stack; } catch (_e) {}
              }
              if (typeof name === "string" && name.length > 0) {
                try { err.name = name; } catch (_e) {}
              }
              if (typeof payloadJson === "string" && payloadJson.length > 0) {
                try { Object.assign(err, JSON.parse(payloadJson)); } catch (_e) {}
              }
              return err;
            }
          `),
        );
      }

      const nameHandle = ctx.newString(value.name || value.constructor?.name || "Error");
      const messageHandle = ctx.newString(value.message || "");
      const stackHandle = ctx.newString(value.stack || "");
      const payloadHandle = ctx.newString(JSON.stringify(copyErrorPayload(value)) || "{}");
      const result = ctx.unwrapResult(
        ctx.callFunction(creator, ctx.undefined, nameHandle, messageHandle, stackHandle, payloadHandle),
      );
      nameHandle.dispose();
      messageHandle.dispose();
      stackHandle.dispose();
      payloadHandle.dispose();
      return result;
    },

    /** Reconstructs a QuickJS Error as the corresponding host subclass. */
    unmarshal(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return undefined;

      const checkResult = ctx.unwrapResult(
        ctx.callFunction(isErrorInVM, ctx.undefined, handle),
      );
      const isErr = ctx.dump(checkResult);
      checkResult.dispose();
      if (!isErr) return undefined;

      if (!getName) {
        getName = ctx.unwrapResult(ctx.evalCode("(h) => h.name"));
        getMessage = ctx.unwrapResult(ctx.evalCode("(h) => h.message"));
        getStack = ctx.unwrapResult(ctx.evalCode("(h) => h.stack"));
        getPayload = ctx.unwrapResult(ctx.evalCode(`(err) => {
          const fields = ["errors", "inner", "path", "type", "value", "params", "issues"];
          const seen = new Set();
          /** Copies a bounded JSON-compatible field within QuickJS. */
          function copy(value, depth = 0) {
            if (value === null || value === undefined) return value;
            const valueType = typeof value;
            if (valueType === "string" || valueType === "number" || valueType === "boolean") return value;
            if (valueType === "bigint") return String(value);
            if (valueType === "symbol" || valueType === "function") return undefined;
            if (depth > 4 || seen.has(value)) return undefined;
            seen.add(value);
            if (value instanceof Error) return copyError(value, depth + 1);
            if (value instanceof Set) return Array.from(value).slice(0, 100).map((entry) => copy(entry, depth + 1));
            if (value instanceof Map) return Array.from(value).slice(0, 100).map(([key, entry]) => [copy(key, depth + 1), copy(entry, depth + 1)]);
            if (Array.isArray(value)) return value.slice(0, 100).map((entry) => copy(entry, depth + 1));
            const proto = Object.getPrototypeOf(value);
            if (proto !== Object.prototype && proto !== null) return String(value);
            const output = {};
            for (const key of Object.keys(value).slice(0, 50)) {
              const copied = copy(value[key], depth + 1);
              if (copied !== undefined) output[key] = copied;
            }
            return output;
          }
          /** Extracts supported fields from a QuickJS Error. */
          function copyError(error, depth = 0) {
            const output = { name: error.name, message: error.message, stack: error.stack };
            for (const key of fields) {
              if (key in error) {
                const copied = copy(error[key], depth + 1);
                if (copied !== undefined) output[key] = copied;
              }
            }
            return output;
          }
          return copyError(err);
        }`));
      }

      const nameHandle = ctx.unwrapResult(
        ctx.callFunction(getName, ctx.undefined, handle),
      );
      const messageHandle = ctx.unwrapResult(
        ctx.callFunction(getMessage, ctx.undefined, handle),
      );
      const stackHandle = ctx.unwrapResult(
        ctx.callFunction(getStack, ctx.undefined, handle),
      );
      const payloadHandle = ctx.unwrapResult(
        ctx.callFunction(getPayload, ctx.undefined, handle),
      );

      const name = ctx.dump(nameHandle) || "Error";
      const message = ctx.dump(messageHandle) || "";
      const stack = ctx.dump(stackHandle) || "";
      const payload = ctx.dump(payloadHandle) || {};
      nameHandle.dispose();
      messageHandle.dispose();
      stackHandle.dispose();
      payloadHandle.dispose();

      const ErrorCtor = getHostErrorCtor(name);
      const error =
        name === "AggregateError" && typeof AggregateError === "function" && ErrorCtor === AggregateError
          ? new ErrorCtor([], message)
          : new ErrorCtor(message);

      try { error.name = name; } catch (_e) {}
      if (typeof stack === "string" && stack.length > 0) {
        try { error.stack = stack; } catch (_e) {}
      }
      return applyErrorPayload(error, payload);
    },

    /** Releases every QuickJS detector, constructor, and property reader. */
    dispose() {
      if (isErrorInVM.alive) isErrorInVM.dispose();
      if (creator && creator.alive) creator.dispose();
      if (getName && getName.alive) getName.dispose();
      if (getMessage && getMessage.alive) getMessage.dispose();
      if (getStack && getStack.alive) getStack.dispose();
      if (getPayload && getPayload.alive) getPayload.dispose();
    },
  };
}
