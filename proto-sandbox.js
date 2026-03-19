import { getQuickJS } from "quickjs-emscripten";
import { Arena } from "quickjs-emscripten-sync";

function appendToOutput(text) {
  const output = document.getElementById("output");
  if (output) {
    output.innerText += text + "\\n";
  }
}

const wrapperCache = new WeakMap();

function bindWebApi(apiObject) {
  // Only wrap non-null objects
  if (typeof apiObject !== "object" || apiObject === null) {
    return apiObject;
  }

  // Return the existing wrapper if we've already wrapped this object
  // This prevents infinite loops with circular references (e.g., node.ownerDocument)
  // and preserves object identity inside the sandbox!
  if (wrapperCache.has(apiObject)) {
    return wrapperCache.get(apiObject);
  }

  const boundObject = {};
  wrapperCache.set(apiObject, boundObject);

  // Iterate over all properties in the object and its prototype chain
  let keys = [];
  try {
    for (const key in apiObject) {
      keys.push(key);
    }
  } catch (err) {
    // Catch DOM security errors (e.g. cross-origin properties)
  }

  for (const key of keys) {
    try {
      if (typeof apiObject[key] === "function") {
        // Bind the function to the original native object
        boundObject[key] = apiObject[key].bind(apiObject);
      } else {
        // Create a getter/setter for properties
        Object.defineProperty(boundObject, key, {
          get: () => {
            const val = apiObject[key];
            // Lazily wrap the returned value.
            // This is what allows `document.body.style.backgroundColor` to work safely!
            return bindWebApi(val);
          },
          set: (val) => {
            apiObject[key] = val;
          },
        });
      }
    } catch (err) {
      // Ignore properties that throw errors upon access
    }
  }

  return boundObject;
}

async function main() {
  // Initialize the QuickJS module
  const QuickJS = await getQuickJS();

  // Create a new context (VM environment)
  const vm = QuickJS.newContext();

  // Initialize the Arena to sync JS and QuickJS objects easily
  const arena = new Arena(vm, { isMarshalable: true });

  try {
    const wrappedConsole = window.console;

    // Web APIs like localStorage enforce `this` to be the actual Storage object.
    // quickjs-emscripten-sync will wrap it in a Proxy, which causes "Illegal invocation".
    // We bind the methods to window.localStorage to bypass this.
    /* const wrapperLocalStorage = {
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
      removeItem: (key) => window.localStorage.removeItem(key),
      clear: () => window.localStorage.clear(),
      get length() {
        return window.localStorage.length;
      },
      key: (index) => window.localStorage.key(index),
    }; */

    const wrapperLocalStorage = bindWebApi(window.localStorage);

    const wrappedDocument = bindWebApi(window.document);

    console.log("Exposing localStorage", wrapperLocalStorage);

    const syncedLocalStorage = arena.sync(wrapperLocalStorage);
    const syncedDocument = arena.sync(wrappedDocument);

    // Expose the global console object to the QuickJS execution context
    arena.expose({
      console: wrappedConsole,
      localStorage: syncedLocalStorage,
      document: syncedDocument,
    });

    console.log("Host: Executing script inside QuickJS Sandbox...");
    appendToOutput("Host: Executing script inside QuickJS Sandbox...");

    localStorage.setItem("rafael", "rafael");
    console.log(localStorage.length);

    // Evaluate some JavaScript code inside QuickJS that uses the exposed WebAPI
    const code = `
      console.log("Sandbox: Hello World! I'm running inside QuickJS.");
      console.warn("Sandbox: This is a warning from the Wasm module.");
      console.error("Sandbox: And this is an error!");
      localStorage.setItem("test", "test");
      console.log(localStorage.getItem("rafael"));
      console.log(document.body);
      console.log(document.getElementById("output"));
      document.body.style.backgroundColor = "red";
    `;

    arena.evalCode(code);

    console.log("Host: Getting key test");
    console.log(localStorage.getItem("test"));

    console.log("Host: Execution finished successfully.");
    appendToOutput("Host: Execution finished successfully.");
  } catch (err) {
    console.error("Host Engine Error:", err);
    appendToOutput("Host Engine Error: " + err);
  } finally {
    // Always dispose of the arena and vm to prevent memory leaks
    console.log("Host: Disposing arena and vm...");
    try {
      arena.dispose();
    } catch (gcErr) {
      console.warn("Host: arena.dispose() threw a GC error, ignoring:", gcErr);
    }
    try {
      vm.dispose();
    } catch (gcErr) {
      console.warn(
        "Host: vm.dispose() skipped due to strict GC assertions with circular Proxy references:",
        gcErr,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  appendToOutput("Global Error: " + err);
});
