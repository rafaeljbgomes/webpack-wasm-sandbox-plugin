# webpack-sandbox-plugin: Technical and Architectural Specification (v2)

**Version:** 0.3.0  
**Status:** Updated Draft  
**Date:** 2026-03-07

---

## 1. Introduction

The `webpack-sandbox-plugin` provides a robust, runtime-enforced security boundary for untrusted or third-party npm libraries. By leveraging **QuickJS compiled to WebAssembly** and the **`quickjs-emscripten-sync`** (Arena) synchronization layer, the plugin isolates each sandboxed library into its own separate Wasm heap.

This document details the architecture of the system, from the build-time interception to the runtime "Membrane" that safely bridges host WebAPIs into the sandbox.

---

## 2. System Architecture Overview

The system operates across two distinct phases: **Build-time** (Webpack Plugin) and **Runtime** (Browser Sandbox). Crucially, the system ensures **complete memory isolation** by assigning a dedicated QuickJS instance and Arena to each sandboxed library.

### 2.1 High-Level Component Diagram

```text
[ Application Code ]
       │
       ▼ (Import redirected)
[ Library Proxy (Generated) ]
       │
       ▼ (Through dedicated Arena Bridge)
[ Sandbox Runtime Manager ] ──▶ [ Library A's QuickJS Wasm Context ]
       │                      │
       │                      ▼
       │                      [ Library B's QuickJS Wasm Context ]
       │
       │ (Controlled Access per Library)
       ▼
[ WebAPI Membrane ] ─────────────▶ [ Exposed Browser APIs ]
       │
       ▼
[ Native Browser APIs (window.localStorage, document, etc.) ]
```

---

## 3. Build-time: The Webpack Plugin

The plugin is responsible for identifying dependencies that need sandboxing and transparently rerouting imports.

### 3.1 Import Interception

The plugin hooks into Webpack’s `NormalModuleFactory` using the `resolve` hook. When a module matches a pattern defined in `sandbox.config.js`:

- The resolver redirects the request from the actual `node_modules` path to a **Virtual Module Path** (e.g., `sandbox-proxy/lodash`).

2.  A **Virtual Module Plugin** (e.g., using Webpack 5's experimental `VirtualUrlPlugin` or `webpack-virtual-modules`) provides the source code for this proxy module on-the-fly.
3.  **Child Compiler:** Concurrently, the plugin uses a Webpack child compiler to bundle the _actual_ untrusted library into an isolated asset (e.g., an IIFE or UMD string) that can be loaded into the sandbox runtime without contaminating the main application bundle.

### 3.2 Library Proxy Generation

For each sandboxed library, the plugin generates a "Proxy Module" facade. The generated code is highly standardized and follows a boilerplate pattern, making automatic generation straightforward (e.g., via analyzing the `.d.ts` definitions):

- Imports the `SandboxManager`.
- Lazily fetches the isolated library bundle and creates the sandbox environment (`SandboxManager.createSandbox(libraryCode)`).
- Re-exports the library's API functions.
- **Semi-Transparent Marshalling & Reverse Membrane:** While `{ isMarshalable: true }` allows primitives and simple objects to cross seamlessly, the proxy generator wraps exports in a **Reverse Membrane** to preserve object identity and prototype chains. The proxy intercepts function calls (`apply` trap), constructor calls (`construct` trap, routed through a dedicated `createInstance` helper), and property accesses (`get` trap) to ensure all operations are seamlessly forwarded to the QuickJS VM. Returned objects are wrapped so they execute their methods in-place within the QuickJS VM.

---

## 4. Runtime: Context Creation and Isolation

The sandbox uses `quickjs-emscripten` for the VM and `quickjs-emscripten-sync` for the bridge.

### 4.1 The Sandbox Runtime Manager

To minimize overhead while maintaining strict isolation, the runtime manager coordinates resources uniformly:

1.  **Initialization:** Loading the `quickjs.wasm` binary exactly once.
2.  **Per-Library Isolation:** For _each_ sandboxed library, the manager instantiates a new, dedicated `QuickJSContext` (VM) and a corresponding `Arena`. This guarantees that malicious Library A cannot access the memory space of Library B.
3.  **Generic Architecture:** The core sandbox setup code remains identical for every library. The only custom per-library injection needed is configuring the Membrane rules to expose the specific WebAPIs assigned to that library in `sandbox.config.js`.

### 4.2 Optimized Code Injection

Evaluating massive strings of raw JavaScript via `arena.evalCode(source)` at runtime is a severe performance bottleneck for Time-To-Interactive (TTI) and complicates export extraction. The system utilizes optimized injection patterns:

1.  **The UMD/Global Pattern (Default):**
    The Webpack child compiler outputs the library wrapped in an IIFE or UMD format that assigns its exports to a specific global variable.

    ```javascript
    // Inside the Library's QuickJS Context
    arena.evalCode(`
      // Webpack generated isolated bundle:
      var __SANDBOXED_LIB__ = (function() { /* lib code */ return { foo: function(){} } })();
    `);

    // Retrieve the exported interface:
    const libExports = arena.evalCode(`__SANDBOXED_LIB__`);
    ```

2.  **Bytecode Compilation (Advanced):**
    To drastically improve startup times, the plugin can utilize QuickJS's `qjsc` to pre-compile the untrusted library into QuickJS bytecode during the Webpack build phase. The runtime manager then loads the bytecode buffer directly into the VM, bypassing the parsing overhead entirely.

---

## 5. WebAPI Access: The Membrane Pattern

The most critical challenge in sandboxing is allowing libraries to use browser APIs (like `localStorage`) without giving them full, uncontrolled access.

### 5.1 The "Illegal Invocation" Problem

Many native browser APIs (DOM, Storage, etc.) verify that `this` is a native instance. Because `quickjs-emscripten-sync` wraps objects in a `Proxy` to sync them across heaps, calling `proxy.getItem('key')` on a `localStorage` proxy results in an `Illegal Invocation` error.

### 5.2 The Membrane Implementation (`bindWebApi`)

To solve this, the runtime uses a **Membrane utility** before exposing APIs to the `Arena`:

1.  **Function Binding:** Every function in the API is bound to its original native host (e.g., `apiObject[key].bind(apiObject)`).
2.  **Identity Preservation:** A `WeakMap` is used to cache wrapped objects. This ensures that `sandbox.document.body` always refers to the same object inside the sandbox, preserving referential integrity.
3.  **Lazy Wrapping:** When a property is accessed (e.g., `document.body`), the membrane lazily wraps the result. This avoids eagerly traversing and wrapping massive objects like the entire DOM tree, which would crash the browser.
4.  **Circular Reference Handling:** The `WeakMap` prevents infinite recursion when traversing circular structures like `element.parentElement`.

### 5.3 Arena Exposure

Once wrapped by the membrane, the "safe" version of the API is synced to the specific library's `Arena`:

```javascript
const safeLocalStorage = bindWebApi(window.localStorage);
const syncedStorage = libraryArena.sync(safeLocalStorage);
libraryArena.expose({ localStorage: syncedStorage });
```

### 5.4 Edge Cases: Callbacks and DOM Events

_Note: While the Membrane handles property access and standard invocations cleanly, callbacks (e.g., `element.addEventListener('click', myCallback)`) require special handling. The Membrane must detect functions crossing the boundary from QuickJS into the V8 host and wrap them in a reverse-proxy to ensure the host can call back into the correct Arena. This bridging protocol for events and promises is deferred for future optimization._

### 5.5 VM-to-Host Exports: The Reverse Membrane

While `quickjs-emscripten-sync` excels at projecting Host APIs into the VM, its default state-synchronization model is lossy when exporting complex Object-Oriented libraries (e.g., Luxon, Mime) from the **VM to the Host**. It strips prototype getters and breaks object identity, which destroys ES2022 private fields (`#field`).

To achieve transparent API compatibility, the sandbox implements a **Reverse RPC Membrane** (`bindSandboxExport` / `wrapReturned`):
1.  **Identity Preservation:** Objects exported from the VM are temporarily pinned in a VM-global Map (`__SANDBOX_TEMP__`).
2.  **In-Place Execution:** Instead of marshaling the state to the host, the Membrane generates host-side Proxies that route all method calls and property accesses back into the VM via `arena.evalCode(...)`, ensuring they execute with their original `this` context.
3.  **TypedArrays:** A custom marshaller gracefully handles raw byte transfers (e.g., `Uint8Array`) across the boundary without proxying.

---

## 6. Proxy Membrane Compatibility Limitations

The sandbox exposes sandboxed library functions and objects to the host through a layered proxy membrane (Arena sync proxies + `bindSandboxExport` / `wrapReturned`). While this makes the vast majority of library APIs transparently usable, there is a category of observable behaviour that **cannot be preserved** across the VM–host boundary. These are not bugs in the implementation; they are fundamental constraints of any cross-VM proxy membrane.

### 6.1 Object Reference Identity

The membrane never returns the same JavaScript object twice for the same QJS value. Each crossing of the boundary may produce a new proxy wrapper. As a result:

- **`===` identity comparisons** between values obtained in separate calls always fail, even when they logically refer to the same underlying QJS object.
- **`assert.strictEqual(cache.get(key), key)`** fails when `key` is an object — the value stored in the sandbox and retrieved back is a new proxy, not the same host reference.
- This affects any test or application code that uses referential equality to track object identity across calls.

### 6.2 `instanceof` Checks on Proxied Objects

An Arena sync proxy (created by `ae()`) has a plain `{}` or `[]` as its host shell. Its prototype chain is set to a sync proxy of the QJS prototype, but not to the real host constructor's prototype. Therefore:

- `proxiedDate instanceof Date` → `false` (the proxy is not a real `Date`)
- `proxiedArray instanceof Array` → depends on depth; `Array.isArray(proxy)` works for one level of Proxy, but `instanceof` does not
- Test assertions that gate on `instanceof` (e.g. `assert.ok(result instanceof Date)`) will fail even when the underlying QJS value is the correct type

### 6.3 Symbol Identity

JavaScript `Symbol` values have unique identity by design. Symbols do not survive the QJS↔host round-trip with their identity intact: a Symbol created or stored inside QJS is marshalled out as a new host Symbol each time. Consequently:

- A Symbol used as a Map key inside the sandbox cannot be used as the same key on the host side
- `cache.has(sym)` where `sym` was passed in from the host may return `false` if the QJS side stored a marshalled copy under a different identity
- `assert.strictEqual(returned_symbol, original_symbol)` always fails

### 6.4 `null` vs. `undefined` Marshalling

In some cases the Arena marshals QJS `null` as host `undefined`. Assertions of the form `assert.strictEqual(cache.get(absent_key), null)` may receive `undefined` instead, causing failures even when the semantic intent (absence of a value) is correct.

### 6.5 `arguments` Objects

Host `arguments` objects passed into the sandbox are marshalled as plain QJS objects. They lose their special `arguments` identity (`Array.isArray` remains false, but lodash's `isArguments` check — which inspects `Object.prototype.toString` or the `callee` property — fails on the proxy representation). Library functions that branch on `isArguments` to decide whether to flatten or iterate may treat these values as opaque objects rather than array-like collections.

### 6.6 Host Built-ins with Internal Slots (e.g. `Date`)

Native host constructors like `Date`, `Map`, `Set`, and `RegExp` carry internal slots that are inaccessible through a Proxy. When a host `Date` constructor is passed into the sandbox (e.g. via `_.bind(Date, null)`) and the resulting bound function is invoked with `new`, the constructed object crosses back to the host as an Arena sync proxy. Native methods such as `Date.prototype.toString` and `Date.prototype.valueOf` perform an internal slot check (`[[DateValue]]`) on their receiver and throw `TypeError: Method Date.prototype.toString called on incompatible receiver` when invoked on the proxy.

This limitation applies to any built-in that validates its receiver via internal slots rather than prototype chain inspection.

### 6.7 Function Source Text

Arena-wrapped functions have a `toString()` that reflects the wrapper machinery, not the original function body. Test assertions that compare `fn.toString()` (a common pattern in lodash's own test suite to verify aliasing) will always fail for sandboxed functions.

### 6.8 Practical Impact

These limitations affect the **library's own test suite** when that suite is run through the sandbox via the ESM loader interception strategy. They do not affect the library's **runtime behaviour** for normal usage patterns — calling functions, transforming data, and consuming return values — which is the primary use case the sandbox is designed for. Applications that do not assert on object identity, symbol equality, or native built-in slot access will be unaffected.

---

## 7. Memory and Lifecycle Management

### 7.1 Disposal Pattern

QuickJS objects in the Wasm heap are not automatically garbage-collected by the browser's V8 engine. The system implements a strict disposal pattern per library:

- The library's `Arena` is disposed first to release the Proxy bridges.
- The library's `QuickJSContext` (VM) is disposed to free its dedicated Wasm memory.
- This is wrapped in `try...finally` blocks to prevent memory leaks in the browser.

**Note on Reverse Membrane GC:** Because the Reverse Membrane pins VM objects in `__SANDBOX_TEMP__` to preserve identity, those objects persist as long as the VM lives. In a long-lived production scenario, a `FinalizationRegistry` on the host side should be utilized to detect when the host Proxy is garbage collected, subsequently triggering a cleanup of the pinned object inside the VM.

### 7.2 Double Security Boundary

Security is enforced on three levels:

1.  **Memory Isolation:** Each library lives in its own QuickJS module and heap. A malicious library cannot "reach out" to the V8 host heap or to another library's Wasm heap.
2.  **Granular WebAPI Access:** The `Arena` only exposes host objects that have been explicitly passed through the Membrane according to the configuration.
3.  **Prototype Pollution Prevention:** The host environment is structurally immune to prototype pollution attacks originating from the sandboxed library. Global prototype mutations (e.g., `Object.prototype.polluted = true`) only affect the isolated Wasm heap. Furthermore, the Forward Membrane (`bindWebApi`) intentionally halts prototype chain traversal before reaching `Object.prototype`, acting as a structural firewall that prevents the VM from mutating shared host prototypes even on explicitly exposed APIs.

---

## 8. Configuration (`sandbox.config.js`)

Developers define the permissions per library in a central configuration file. This file is dynamically imported by the `SandboxManager` at runtime so the exact same Manager code can handle multiple different libraries.

```javascript
export default {
  "untrusted-sdk": {
    permissions: ["console", "localStorage"],
  },
  "strip-ansi": {
    permissions: ["console"], // Block everything else
  },
};
```

When a generated proxy calls `SandboxManager.createSandbox('strip-ansi', libraryCode)`, the Manager:

1. Performs a lookup in the configuration for the specified `libraryName`.
2. Iterates over the `permissions` array.
3. Automatically maps each permitted string to its corresponding `window` object API.
4. Wraps it via the `bindWebApi` Membrane and syncs it to that specific library's `Arena`.

Any attempt to access an API not listed in the array (e.g., `localStorage` for `strip-ansi`) will throw a `ReferenceError` or `TypeError` inside the sandbox, guaranteeing robust execution restrictions via a simple, declarative configuration pattern.