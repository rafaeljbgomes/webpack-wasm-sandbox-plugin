// WebAPI exposure: reads the sandbox config permissions for a library and
// exposes the corresponding host globals to the Arena under safe wrappers.

import sandboxConfig from "../sandbox.config.js";
import { bindWebApi, makeCallable } from "../membrane/forward-membrane.js";

/**
 * Iterates the permission list for libraryName, wraps each allowed host global
 * via the forward membrane, and exposes it to the arena.
 *
 * Functions (constructors like TextEncoder, Crypto) go through makeCallable so
 * the Arena can invoke them without `new`. Plain objects go through bindWebApi
 * so their methods stay bound to the native host instance.
 */
export function exposeWebAPIs(arena, libraryName) {
  const config = sandboxConfig[libraryName] || { permissions: [] };
  const exposedAPIs = {};

  for (const apiName of config.permissions) {
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
}
