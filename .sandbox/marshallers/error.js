// Error custom marshaller: preserves Error subclass identity across the host↔QJS
// boundary. Without this, QJS errors can surface as generic proxies/objects on
// the host and fail `instanceof TypeError` / `assert.raises(..., TypeError)`.

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

function getHostErrorCtor(name) {
  return ERROR_CTORS.get(name) || Error;
}

function isErrorLike(value) {
  return value instanceof Error;
}

export function createErrorMarshaller(vm) {
  const isErrorInVM = vm.unwrapResult(
    vm.evalCode("(h) => h instanceof Error"),
  );

  let creator = null;
  let getName = null;
  let getMessage = null;
  let getStack = null;

  return {
    isWrappable(value) {
      return !isErrorLike(value);
    },

    isHandleWrappable(handle, ctx) {
      if (ctx.typeof(handle) !== "object") return true;
      const result = ctx.unwrapResult(
        ctx.callFunction(isErrorInVM, ctx.undefined, handle),
      );
      const isErr = ctx.dump(result);
      result.dispose();
      return !isErr;
    },

    marshal(value, ctx) {
      if (!isErrorLike(value)) return undefined;

      if (!creator) {
        creator = ctx.unwrapResult(
          ctx.evalCode(`
            (name, message, stack) => {
              const ErrorCtor = globalThis[name] instanceof Function ? globalThis[name] : Error;
              const err = new ErrorCtor(message);
              if (typeof stack === "string" && stack.length > 0) {
                try { err.stack = stack; } catch (_e) {}
              }
              if (typeof name === "string" && name.length > 0) {
                try { err.name = name; } catch (_e) {}
              }
              return err;
            }
          `),
        );
      }

      const nameHandle = ctx.newString(value.name || value.constructor?.name || "Error");
      const messageHandle = ctx.newString(value.message || "");
      const stackHandle = ctx.newString(value.stack || "");
      const result = ctx.unwrapResult(
        ctx.callFunction(creator, ctx.undefined, nameHandle, messageHandle, stackHandle),
      );
      nameHandle.dispose();
      messageHandle.dispose();
      stackHandle.dispose();
      return result;
    },

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

      const name = ctx.dump(nameHandle) || "Error";
      const message = ctx.dump(messageHandle) || "";
      const stack = ctx.dump(stackHandle) || "";
      nameHandle.dispose();
      messageHandle.dispose();
      stackHandle.dispose();

      const ErrorCtor = getHostErrorCtor(name);
      const error =
        name === "AggregateError" && typeof AggregateError === "function" && ErrorCtor === AggregateError
          ? new ErrorCtor([], message)
          : new ErrorCtor(message);

      try { error.name = name; } catch (_e) {}
      if (typeof stack === "string" && stack.length > 0) {
        try { error.stack = stack; } catch (_e) {}
      }
      return error;
    },

    dispose() {
      if (isErrorInVM.alive) isErrorInVM.dispose();
      if (creator && creator.alive) creator.dispose();
      if (getName && getName.alive) getName.dispose();
      if (getMessage && getMessage.alive) getMessage.dispose();
      if (getStack && getStack.alive) getStack.dispose();
    },
  };
}
