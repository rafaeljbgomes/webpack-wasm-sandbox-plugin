import { getQuickJS, newQuickJSAsyncWASMModule } from "quickjs-emscripten";
import { Arena } from "quickjs-emscripten-sync";
import sandboxConfig from "./sandbox.config.js";

const wrapperCache = new WeakMap();

export function bindWebApi(apiObject) {
  if (typeof apiObject !== "object" || apiObject === null) {
    return apiObject;
  }

  if (wrapperCache.has(apiObject)) {
    return wrapperCache.get(apiObject);
  }

  const boundObject = {};
  wrapperCache.set(apiObject, boundObject);

  let keys = [];
  try {
    for (const key in apiObject) {
      keys.push(key);
    }
  } catch (err) {}

  for (const key of keys) {
    try {
      if (typeof apiObject[key] === "function") {
        boundObject[key] = apiObject[key].bind(apiObject);
      } else {
        Object.defineProperty(boundObject, key, {
          get: () => bindWebApi(apiObject[key]),
          set: (val) => {
            apiObject[key] = val;
          },
        });
      }
    } catch (err) {}
  }

  return boundObject;
}

export class SandboxManager {
  quickJS = null;

  static async createSandbox(libraryName, libraryCode) {
    this.quickJS = await newQuickJSAsyncWASMModule();

    const vm = this.quickJS.newContext();
    const arena = new Arena(vm, { isMarshalable: true });

    // Expose safe WebAPIs dynamically based on config
    const config = sandboxConfig[libraryName] || { permissions: [] };
    const exposedAPIs = {};

    for (const apiName of config.permissions) {
      if (typeof globalThis[apiName] !== "undefined") {
        let rootAPI = globalThis[apiName];
        if (typeof rootAPI === "function") {
          rootAPI = rootAPI.bind(globalThis);
        } else {
          rootAPI = bindWebApi(rootAPI);
        }
        exposedAPIs[apiName] = arena.sync(rootAPI);
      }
    }

    arena.expose(exposedAPIs);

    // Evaluate the library code
    // Assuming libraryCode sets a global __SANDBOXED_LIB__
    const code = `${libraryCode}; __SANDBOXED_LIB__;`;

    const libExports = arena.evalCode(code);

    const pumpInterval = setInterval(() => {
      try {
        if (vm.runtime.hasPendingJob()) {
          arena.executePendingJobs();
        }
      } catch (err) {
        console.error("Sandbox async execution error:", err);
      }
    }, 1);

    return {
      vm,
      arena,
      exports: libExports,
      dispose: () => {
        clearInterval(pumpInterval);
        arena.dispose();
        vm.dispose();
      },
    };
  }
}
