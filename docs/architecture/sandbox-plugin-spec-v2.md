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
- **Transparent Marshalling:** Because `{ isMarshalable: true }` is enabled in the runtime `Arena`, the generated code does **not** need to manually marshal or format parameters (like `JSON.stringify`). The proxy simply calls the sandboxed function (`sandbox.exports.functionName(...args)`), and the Arena automatically synchronizes primitives and creates proxies for complex objects seamlessly across the host boundaries.

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

---

## 6. Memory and Lifecycle Management

### 6.1 Disposal Pattern

QuickJS objects in the Wasm heap are not automatically garbage-collected by the browser's V8 engine. The system implements a strict disposal pattern per library:

- The library's `Arena` is disposed first to release the Proxy bridges.
- The library's `QuickJSContext` (VM) is disposed to free its dedicated Wasm memory.
- This is wrapped in `try...finally` blocks to prevent memory leaks in the browser.

### 6.2 Double Security Boundary

Security is enforced on two levels:

1.  **Memory Isolation:** Each library lives in its own QuickJS module and heap. A malicious library cannot "reach out" to the V8 host heap or to another library's Wasm heap.
2.  **Granular WebAPI Access:** The `Arena` only exposes host objects that have been explicitly passed through the Membrane according to the configuration.

---

## 7. Configuration (`sandbox.config.js`)

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
