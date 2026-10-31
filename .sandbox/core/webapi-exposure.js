import sandboxConfig from "../sandbox.config.js";

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

/**
 * Creates a constrained crypto facade instead of exposing the host crypto
 * object and its ambient authority directly.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Target sandbox bridge.
 * @returns {{exposed: object, install: string}|null} Host callbacks and QuickJS installer source.
 */
function createCryptoCapability(arena) {
  if (
    typeof globalThis.crypto !== "object" ||
    globalThis.crypto === null ||
    typeof globalThis.crypto.getRandomValues !== "function"
  ) {
    return null;
  }

  /**
   * Generates random bytes after enforcing the Web Crypto length contract.
   *
   * @param {unknown} byteLength Requested byte count.
   * @returns {Uint8Array} Random bytes copied across the boundary.
   */
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

        /** Creates the DOM-compatible error used for oversized requests. */
        const makeQuotaExceededError = () => {
          const error = new Error("The requested length exceeds 65,536 bytes.");
          error.name = "QuotaExceededError";
          return error;
        };

        const cryptoCapability = Object.create(null);
        Object.defineProperty(cryptoCapability, "getRandomValues", {
          enumerable: true,
          configurable: true,
          /** Fills an integer TypedArray without exposing the host crypto object. */
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
            /** Returns a UUID produced by the host capability. */
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
 * Validates explicit caller policy before a QuickJS context is allocated.
 * @param {string[]|undefined} permissions Explicit list or the legacy omission sentinel.
 * @returns {void}
 */
export function validatePermissions(permissions) {
  if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((name) => typeof name !== "string" || !name))) {
    throw new TypeError("Sandbox permissions must be an array of nonempty strings");
  }
}

/**
 * Iterates the permission list for libraryName, wraps each allowed host global
 * via the sandbox's own forward membrane, and exposes it to the arena.
 *
 * Functions (constructors like TextEncoder, Crypto) go through makeCallable so
 * the Arena can invoke them without `new`. Plain objects go through bindWebApi
 * so their methods stay bound to the native host instance.
 *
 * @param {import("quickjs-emscripten-sync").Arena} arena Target sandbox bridge.
 * @param {string} libraryName Policy key whose permissions are applied.
 * @param {string[]|undefined} permissions Explicit compiler policy; omission retains the direct-call fallback.
 * @param {{makeCallable: Function, bindWebApi: Function}} forwardMembrane Wrapper factory owned by the same sandbox as `arena`.
 * @returns {void}
 */
export function exposeWebAPIs(arena, libraryName, permissions, forwardMembrane) {
  const { bindWebApi, makeCallable } = forwardMembrane;
  const selectedPermissions = permissions === undefined
    ? (sandboxConfig[libraryName]?.permissions ?? [])
    : permissions;
  validatePermissions(selectedPermissions);
  const exposedAPIs = {};
  const installers = [];

  for (const apiName of selectedPermissions) {
    if (apiName === "crypto") {
      const cryptoCapability = createCryptoCapability(arena);
      if (cryptoCapability) {
        Object.assign(exposedAPIs, cryptoCapability.exposed);
        installers.push(cryptoCapability.install);
      }
      continue;
    }

    if (typeof globalThis[apiName] !== "undefined") {
      let rootAPI = globalThis[apiName];
      if (typeof rootAPI === "function") {
        rootAPI = makeCallable(rootAPI, globalThis);
      } else {
        rootAPI = bindWebApi(rootAPI);
      }
      exposedAPIs[apiName] = arena.sync(rootAPI);
    }
  }

  arena.expose(exposedAPIs);
  for (const install of installers) {
    arena.evalCode(install);
  }
}
