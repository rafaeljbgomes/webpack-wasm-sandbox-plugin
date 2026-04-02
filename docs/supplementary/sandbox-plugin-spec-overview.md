# webpack-sandbox-plugin: Technical and Architectural Specification

**Version:** 0.2.0  
**Status:** Updated Draft  
**Date:** 2026-03-05

---

## 1. Introduction

The `webpack-sandbox-plugin` provides a robust, runtime-enforced security boundary for untrusted or third-party npm libraries. By leveraging **QuickJS compiled to WebAssembly** and the **`quickjs-emscripten-sync`** (Arena) synchronization layer, the plugin isolates libraries into a separate Wasm heap. 

This document details the architecture of the system, from the build-time interception to the runtime "Membrane" that safely bridges host WebAPIs into the sandbox.

---

## 2. System Architecture Overview

The system operates across two distinct phases: **Build-time** (Webpack Plugin) and **Runtime** (Browser Sandbox).

### 2.1 High-Level Component Diagram

```text
[ Application Code ]
       │
       ▼ (Import redirected)
[ Library Proxy (Generated) ]
       │
       ▼ (Through Arena Bridge)
[ Sandbox Runtime (Shared) ] ──▶ [ QuickJS Wasm Context ]
       │                                  │
       │ (Controlled Access)              │ (Restricted Code Execution)
       ▼                                  ▼
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
1.  The resolver redirects the request from the actual `node_modules` path to a **Virtual Module Path** (e.g., `sandbox-proxy/lodash`).
2.  A **Virtual Module Plugin** provides the source code for this proxy module on-the-fly.

### 3.2 Library Proxy Generation
For each sandboxed library, the plugin generates a "Proxy Module". This module:
- Imports the `SandboxRuntime` manager.
- Re-exports the library's functions. 
- Every exported function is wrapped in a call that routes through the sandbox's `Arena`.

---

## 4. Runtime: Context Creation and Isolation

The sandbox uses `quickjs-emscripten` for the VM and `quickjs-emscripten-sync` for the bridge.

### 4.1 The Sandbox Runtime Manager
The runtime manager maintains the `QuickJSContext` and the `Arena`. It handles:
1.  **Initialization:** Loading the `quickjs.wasm` binary (asynchronously).
2.  **Context Creation:** Creating a new `QuickJSContext` (VM) for each sandboxed scope.
3.  **Arena Setup:** Creating an `Arena` instance to manage the Marshalling of objects between the V8 heap and the QuickJS heap.

### 4.2 Code Loading
The original library source code is fetched (or bundled as a string) and evaluated inside the VM using `arena.evalCode(source)`. This places the library's internal state entirely within the Wasm memory space.

---

## 5. WebAPI Access: The Membrane Pattern

The most critical challenge in sandboxing is allowing libraries to use browser APIs (like `localStorage`) without giving them full, uncontrolled access.

### 5.1 The "Illegal Invocation" Problem
Many native browser APIs (DOM, Storage, etc.) verify that `this` is a native instance. Because `quickjs-emscripten-sync` wraps objects in a `Proxy` to sync them across heaps, calling `proxy.getItem('key')` on a `localStorage` proxy results in an `Illegal Invocation` error.

### 5.2 The Membrane Implementation (`bindWebApi`)
To solve this, the runtime uses a **Membrane utility** before exposing APIs to the `Arena`:

1.  **Function Binding:** Every function in the API is bound to its original native host (e.g., `apiObject[key].bind(apiObject)`).
2.  **Identity Preservation:** A `WeakMap` is used to cache wrapped objects. This ensures that `sandbox.document.body` always refers to the same object inside the sandbox, preserving referential integrity.
3.  **Lazy Wrapping:** When a property is accessed (e.g., `document.body`), the membrane lazily wraps the result. This allows complex, deeply nested objects like the DOM tree to be accessed safely.
4.  **Circular Reference Handling:** The `WeakMap` prevents infinite recursion when traversing circular structures like `element.parentElement`.

### 5.3 Arena Exposure
Once wrapped by the membrane, the "safe" version of the API is synced to the `Arena`:
```javascript
const safeLocalStorage = bindWebApi(window.localStorage);
const syncedStorage = arena.sync(safeLocalStorage);
arena.expose({ localStorage: syncedStorage });
```

---

## 6. Memory and Lifecycle Management

### 6.1 Disposal Pattern
QuickJS objects in the Wasm heap are not automatically garbage-collected by the browser's V8 engine. The system implements a strict disposal pattern:
- The `Arena` is disposed first to release the Proxy bridges.
- The `QuickJSContext` (VM) is disposed to free the Wasm memory.
- This is wrapped in `try...finally` blocks to prevent memory leaks in the browser.

### 6.2 Security Boundary
The boundary is enforced at the Wasm level. A malicious library can attempt to walk the prototype chain or pollute the global object inside QuickJS, but it cannot "reach out" to the V8 heap because the `Arena` only exposes objects that have been explicitly passed through the Membrane.

---

## 7. Configuration (`sandbox.config.js`)

Developers define the permissions per library:
```javascript
export default {
  "strip-ansi": {
    permissions: ["console"],
  },
}
```

The Membrane uses this configuration to selectively wrap and bind only the permitted parts of the WebAPI.
