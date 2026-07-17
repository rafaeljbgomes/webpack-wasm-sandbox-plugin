// WebAPI exposure: reads the sandbox config permissions for a library and
// exposes the corresponding host globals to the Arena under safe wrappers.

import sandboxConfig from "../sandbox.config.js";
import { bindWebApi, makeCallable } from "../membrane/forward-membrane.js";
import {
  incrementCounter,
  recordDuration,
} from "../../performance-harness/runtime-metrics.js";

const INTEGER_TYPED_ARRAY_NAMES = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function createCryptoCapability(arena) {
  if (
    typeof globalThis.crypto !== "object" ||
    globalThis.crypto === null ||
    typeof globalThis.crypto.getRandomValues !== "function"
  ) {
    return null;
  }

  const getRandomBytes = (byteLength) => {
    const length = Number(byteLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError("byteLength must be a non-negative safe integer");
    }

    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  };

  const exposed = {
    __sandboxCryptoGetRandomBytes: arena.sync(getRandomBytes),
  };

  if (typeof globalThis.crypto.randomUUID === "function") {
    exposed.__sandboxCryptoRandomUUID = arena.sync(() =>
      globalThis.crypto.randomUUID(),
    );
  }

  return {
    exposed,
    install: `
      (() => {
        const getRandomBytes = globalThis.__sandboxCryptoGetRandomBytes;
        const randomUUID = globalThis.__sandboxCryptoRandomUUID;
        const integerTypedArrayNames = new Set(${JSON.stringify([...INTEGER_TYPED_ARRAY_NAMES])});

        const makeQuotaExceededError = () => {
          const error = new Error("The requested length exceeds 65,536 bytes.");
          error.name = "QuotaExceededError";
          return error;
        };

        const cryptoCapability = Object.create(null);
        Object.defineProperty(cryptoCapability, "getRandomValues", {
          enumerable: true,
          configurable: true,
          value(target) {
            if (
              target === null ||
              typeof target !== "object" ||
              !ArrayBuffer.isView(target) ||
              target instanceof DataView ||
              !integerTypedArrayNames.has(target.constructor && target.constructor.name)
            ) {
              throw new TypeError("Expected an integer TypedArray");
            }

            if (target.byteLength > 65536) {
              throw makeQuotaExceededError();
            }

            const bytes = getRandomBytes(target.byteLength);
            new Uint8Array(target.buffer, target.byteOffset, target.byteLength).set(bytes);
            return target;
          },
        });

        if (typeof randomUUID === "function") {
          Object.defineProperty(cryptoCapability, "randomUUID", {
            enumerable: true,
            configurable: true,
            value() {
              return randomUUID();
            },
          });
        }

        globalThis.crypto = cryptoCapability;
        if (typeof globalThis.self === "undefined") {
          globalThis.self = globalThis;
        } else {
          globalThis.self.crypto = cryptoCapability;
        }

        try { delete globalThis.__sandboxCryptoGetRandomBytes; } catch (_err) {}
        try { delete globalThis.__sandboxCryptoRandomUUID; } catch (_err) {}
      })();
    `,
  };
}

/**
 * Iterates the permission list for libraryName, wraps each allowed host global
 * via the forward membrane, and exposes it to the arena.
 *
 * Functions (constructors like TextEncoder, Crypto) go through makeCallable so
 * the Arena can invoke them without `new`. Plain objects go through bindWebApi
 * so their methods stay bound to the native host instance.
 */
export function exposeWebAPIs(arena, libraryName) {
  const startedAt = nowMs();
  const config = sandboxConfig[libraryName] || { permissions: [] };
  const exposedAPIs = {};
  const installers = [];
  let exposedCount = 0;

  for (const apiName of config.permissions) {
    if (apiName === "crypto") {
      const cryptoCapability = createCryptoCapability(arena);
      if (cryptoCapability) {
        Object.assign(exposedAPIs, cryptoCapability.exposed);
        installers.push(cryptoCapability.install);
        exposedCount += 1;
      }
      continue;
    }

    if (globalThis[apiName] !== "undefined") {
      let rootAPI = globalThis[apiName];
      if (typeof rootAPI === "function") {
        rootAPI = makeCallable(rootAPI, globalThis);
      } else {
        rootAPI = bindWebApi(rootAPI);
      }
      exposedAPIs[apiName] = arena.sync(rootAPI);
      exposedCount += 1;
    }
  }

  arena.expose(exposedAPIs);
  for (const install of installers) {
    arena.evalCode(install);
  }
  incrementCounter("webapi_exposed_count", exposedCount);
  recordDuration("webapi_expose_ms", nowMs() - startedAt);
}
