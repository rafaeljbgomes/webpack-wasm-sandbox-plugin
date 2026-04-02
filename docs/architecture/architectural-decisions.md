# Architectural Decisions & Implementation Notes

This document records the key design decisions, constraints, and non-obvious fixes made during the spike. It is intended as a reference for the thesis write-up.

---

## 1. Per-library QuickJS context (no shared VM)

**Decision:** Each sandboxed library receives its own `newQuickJSAsyncWASMModule()` instance and context, rather than sharing a single WASM module.

**Rationale:** Sharing a context between libraries would allow cross-library object graph access, breaking isolation. A separate WASM module per library provides a hard memory boundary: one library cannot reach into another's heap even through the Arena bridge.

**Trade-off:** Higher memory footprint and initialisation time. Acceptable for a spike; a production implementation could explore context-level isolation within a shared module if WASM memory limits become a concern.

---

## 2. Custom TypedArray marshallers

**Problem:** The Arena bridge (`quickjs-emscripten-sync`) marshals plain objects and primitives automatically, but has no built-in support for `TypedArray` / `ArrayBuffer`. When a host function returns a `Uint8Array` (e.g. from `image-js`), the Arena wrapped it in a sync `Proxy`. Inside QuickJS, `ArrayBuffer.isView(proxy)` returns `false`, so typed-array operations on the result failed silently or threw.

**Solution:** The Arena exposes `customMarshaller` and `customUnmarshaller` hooks.

- **customMarshaller (host → QJS):** Detects `TypedArray` views via `ArrayBuffer.isView && !(x instanceof DataView)`. Slices only the view's own bytes (respecting `byteOffset`) into a new `ArrayBuffer`, then calls a cached QJS constructor function `(buf) => new Uint8Array(buf)` inside the VM.
- **customUnmarshaller (QJS → host):** Runs a small helper inside QJS to check `ArrayBuffer.isView && !DataView`, extracts the constructor name (e.g. `"Uint8Array"`), copies the bytes out via `ctx.getArrayBuffer()` + `.slice()` (the slice is critical — `.value` is a view into transient WASM memory), then constructs the matching host TypedArray.
- **`isWrappable` guard (host → QJS):** Excludes host TypedArrays from the Arena's sync-Proxy path so they always go through the custom marshaller.
- **`isHandleWrappable` guard (QJS → host):** Mirrors the above for the reverse direction. Without it, `_wrapHandle()` inside the Arena converts a QJS TypedArray handle into a QJS proxy-function before handing it to `customUnmarshaller`. The unmarshaller then sees `ctx.typeof(handle) === "function"` instead of `"object"` and exits early, leaving the proxy-function to reach the host as a non-TypedArray. Setting `isHandleWrappable` to return `false` for QJS TypedArrays bypasses `_wrapHandle` entirely, so the raw QJS handle reaches `customUnmarshaller` unchanged. A dedicated `isTypedArrayInVM` QJS function is pre-created before Arena construction and cached for the lifetime of the sandbox.

All QJS helper functions (constructors, `isTypedArray`, `getTypeName`, `toExactBuffer`, `isTypedArrayInVM`) are created once per sandbox and cached in `Map`/object to avoid repeated `evalCode` calls.

---

## 3. `bindWebApi` Membrane — wrapping host objects before Arena exposure

**Problem:** The Arena's `arena.sync()` call wraps a host value in a sync `Proxy` so QuickJS can call it. This works for plain functions, but fails for host objects whose methods rely on internal slots (e.g. `Intl.DateTimeFormat`, `TextEncoder`). When Arena creates a Proxy over such an object, method calls throw because `this` is the Proxy, not the real instance; the engine's slot check rejects it.

**Solution:** Before passing any WebAPI object through `arena.sync()`, it is first wrapped by `bindWebApi()`:

1. Walks the full prototype chain of the API object, collecting property names at each level via `Object.getOwnPropertyNames` (captures non-enumerable properties that `for…in` would miss). The walk stops at `Object.prototype`. This is necessary because Node.js/browser built-in API methods (e.g. `Crypto.prototype.getRandomValues`, `Intl.ListFormat.prototype.format`) live on the prototype, not as own properties of the instance — `Object.getOwnPropertyNames(instance)` alone would miss them entirely.
2. Replaces each function with a closure that calls `Reflect.apply(fn, apiObject, args)` — permanently binding `this` to the real host object.
3. Recursively wraps nested objects (lazy `get` trap) with the same pattern, caching via a `WeakMap` to avoid infinite recursion on circular references.
4. TypedArrays are excluded from this path (they are handled by the custom marshaller).

The result is a plain `{}` object that the Arena can safely wrap without touching internal slots.

---

## 4. Constructor call detection in `makeCallable`

**Problem:** The Arena always calls host functions with `Reflect.apply` (no `new`). Some WebAPIs (e.g. `Intl.DateTimeFormat`, `TextDecoder`) are constructors that throw `TypeError: … requires 'new' …` when called as plain functions.

**Solution:** `makeCallable` wraps each function, catches `TypeError`, tests the message against `REQUIRES_NEW_RE` (`/requires 'new'|must be called with new|cannot be invoked without 'new'/i`), and falls back to `Reflect.construct`. The regex covers the phrasing differences across V8, JavaScriptCore, and SpiderMonkey.

Constructor return values that are non-TypedArray objects are recursively wrapped with `bindWebApi` so their methods remain bound (same internal-slot concern as §3).

---

## 5. Async job pump via `setInterval`

**Problem:** QuickJS Async contexts process `Promise` continuations only when explicitly told to do so. Without a driver, `await` inside sandboxed library code would stall forever.

**Solution:** A 1 ms `setInterval` checks `vm.runtime.hasPendingJob()` and calls `arena.executePendingJobs()` to flush the queue. The interval is cleared in `sandbox.dispose()`.

**Note:** 1 ms is the minimum timer resolution; actual scheduling depends on the host event loop. This is sufficient for the spike but a more production-ready approach could tie the pump to microtask scheduling or explicit `await` boundaries in the proxy.

---

## 6. Webpack child compiler for isolated library bundles

**Decision:** Instead of requiring the integrator to pre-bundle each library, the plugin spawns a **child compiler** inside the `make` hook of the parent compilation. The child uses output `library.type: "var"` with `name: "__SANDBOXED_LIB__"`, producing a self-contained IIFE that sets a global variable.

**Why child compiler:** The child compiler participates in the same build graph, so it inherits the parent's resolver configuration and module rules. This avoids a separate `webpack` CLI invocation and makes bundle paths deterministic relative to the parent output directory.

**Constraint:** The `NormalModuleReplacementPlugin` rules must be registered before `make` fires (done in `apply()`), and proxy files must exist before `beforeCompile` completes — the plugin writes them in the `beforeCompile` hook, one step before the child compiler runs in `make`.

---

## 7. `.d.ts`-driven proxy generation (parser only, no type mapping)

**Decision:** The plugin parses a library's `.d.ts` files using the TypeScript compiler API (`ts.createProgram`) solely to obtain the list of exported names (`libraryData.exportedNames`). The proxy generator iterates this list and emits one `export const <name>` per entry.

**What is not used:** The type mapper (`core/mapper.ts`) and the typed domain (`FuncData`, `ClassData`, etc.) were inherited from a WIT-interface generation pipeline. They remain in the codebase but the proxy generator does not use parameter or return-type information — it relies entirely on the Arena's dynamic marshalling at runtime.

**Fallback:** If no `.d.ts` file is found in the package itself, the plugin falls back to `@types/<libraryName>`. If neither exists, a minimal stub proxy is written and a warning is logged.

---

## 8. ESM loader interception strategy for compatibility testing

**Problem:** Running a library's own test suite against the sandboxed proxy requires redirecting imports without modifying any test file. Libraries structure their tests in multiple ways, requiring five distinct interception cases:

| Case | Trigger | Example |
|---|---|---|
| 1 | Bare package import, resolved into `node_modules/<lib>/` | `import 'image-js'` |
| 2 | Subpath export, resolved into `node_modules/<lib>/` | `import 'image-js/filters'` |
| 3 | Relative `../src/…` import from `test-harness/<lib>/`, containing `/src/` in the specifier | `import '../src/Mask.js'` |
| 4 | Relative import from `test-harness/<lib>/` that resolves inside the harness subtree (no `/src/` segment) | sibling-file imports in test suites colocated with source |
| 5 | Relative import from `test-harness/<lib>/` that throws `ERR_MODULE_NOT_FOUND` (source not present locally) | `import '../../src/Mask.js'` |

Cases 1–2 and 4 are caught post-resolution by checking whether the resolved URL starts with the library root URL. Cases 3 and 5 are caught pre-resolution (before `nextResolve`) using the parent URL to identify the originating library.

**Package aliases:** `quickjs-emscripten-sync` ships a broken `exports` map that causes Node ESM resolution to fail. The loader includes a `PACKAGE_ALIASES` map (mirroring `webpack.config.cjs` `resolve.alias`) to redirect it to the correct `.js` build.

---

## 9. `bindSandboxExport` — reverse membrane for QJS→host exports

**Problem:** The Arena's `ue()` function (in `quickjs-emscripten-sync`) wraps QJS functions as host callables by re-marshalling `this` on every call. When you call `mime.getType(ext)`, the host-side `this` (an Arena proxy) gets marshalled back to QJS as a **new** object — not the original Mime instance. This new object lacks the WeakMap entries for ES2022 private fields (`#field`), causing `TypeError: Cannot read private member from an object whose class did not declare it`. The same mechanism breaks any library whose internal methods depend on object identity (`this`), including class instances with internal slots.

**Solution:** `bindSandboxExport(arena, obj, accessPath)` creates a Proxy over the Arena-returned exports that intercepts property access. For each method, it creates a **QJS-side bound closure** via `arena.evalCode()`:

```js
arena.evalCode(`(...args) => __SANDBOXED_LIB__["getType"](...args)`)
```

This closure runs entirely inside QuickJS with the correct `this` — the re-marshalling of `this` is bypassed entirely. For classes with static methods (e.g. `DateTime.now()`), `bindSandboxFunction` creates a Proxy that intercepts both `apply` (for direct calls) and `get` (for static method access).

For **objects returned from method calls** (e.g. `DateTime.now()` returning a new DateTime instance), `wrapReturned(arena, obj)` stores the QJS-side result in a temporary `Map` (`globalThis.__SANDBOX_TEMP__`) and binds methods from that reference, recursively wrapping non-primitive returns. A `WeakMap` cache prevents re-wrapping and handles circular references.

All bound closures are cached per property name to avoid repeated `evalCode` calls.

---

## 10. Promise pump lifecycle — ref during init, unref after

**Problem:** The async job pump (`setInterval(1ms)`) had `.unref()` applied immediately, allowing Node.js to exit before the sandbox's top-level `await` initialization completed. This caused nanoid and other libraries to fail with `Promise resolution is still pending but the event loop has already resolved`.

**Solution:** The pump is created without `.unref()`, keeping Node.js alive during initialization. The returned sandbox object exposes an `unrefPump()` method. The generated proxy calls `unrefPump()` after the `await SandboxManager.createSandbox()` completes, only in Node.js environments:

```js
if (typeof process !== 'undefined' && process.versions?.node) {
  librarySandbox.unrefPump();
}
```

In browser contexts, `setInterval` does not keep the page alive (there is no equivalent of `.unref()`), so the call is skipped.

---

## 11. Node entry points for child compiler bundles

**Problem:** Libraries like nanoid ship separate browser and Node.js entry points. The `browser` field in `package.json` remaps `./index.cjs` → `./index.browser.cjs`. Webpack's default `target: 'web'` picks up this mapping, producing browser-variant bundles. The browser variant may have subtle differences (e.g. different termination checks, different crypto usage) that break inside QuickJS.

**Solution:** A `NormalModuleReplacementPlugin` is applied to each child compiler to rewrite `.browser.(cjs|mjs|js)` imports back to their Node equivalents. An externals mapping `{ "node:crypto": "crypto" }` ensures that `require('node:crypto')` resolves to the global `crypto` object, which is injected by the sandbox permissions membrane when the library's config includes the `"crypto"` permission.

**Note:** Child compilers inherit the parent's compiled resolver, so setting `resolve.aliasFields` or `resolve.mainFields` after `createChildCompiler()` is too late — the resolver is already initialized. The `NormalModuleReplacementPlugin` approach works because it operates at the module-request level, after resolution.

---

## 12. Proxy default export when the library default is a singleton, not a class

**Problem:** Some libraries (e.g. `mime`) export two things that serve different roles:

- A **default export** that is a pre-built singleton instance — e.g. `new Mime(standardTypes, otherTypes)`.
- A **named class export** (e.g. `Mime`) so consumers can create fresh instances.

The ESM loader intercepts *all* imports from a sandboxed library — including subpath imports like `import Mime from '../dist/src/Mime.js'` — and redirects them to the single generated proxy module. The proxy generator creates one `export default` based on `proxyExports.default`. Its template is:

```js
export default typeof proxyExports.default === "function"
  ? new Proxy(proxyExports.default, { construct(target, args) { ... } })
  : proxyExports.default;
```

For `mime`, `proxyExports.default` is the singleton object (not a function), so the ternary resolves to the bare object. Any test that does `import Mime from '...'` followed by `new Mime(...)` receives the singleton and gets `TypeError: Mime is not a constructor`.

**Root cause:** The proxy module conflates all subpath imports of a library into one module. The generated default export handled only the case where `default` is itself a constructor.

**Solution:** The proxy generator now tries a two-step fallback for the default export target:

1. If `proxyExports.default` is a function, use it as the Proxy target (original behaviour).
2. Otherwise, use the **first named function export** in `proxyExports` as the Proxy target (typically the class — e.g. `proxyExports.Mime`).

A `get` trap is added to the default Proxy so that property accesses that are not found on the class target fall through to `proxyExports.default` (the singleton). This preserves singleton-style usage (`mime.getType('html')`) when the import is used as an instance rather than a constructor.

```js
const _defaultProxyTarget = typeof proxyExports.default === "function"
  ? proxyExports.default
  : (typeof proxyExports.<firstNamedExport> === "function"
      ? proxyExports.<firstNamedExport> : null);
const _defaultSingleton = typeof proxyExports.default !== "function"
  ? proxyExports.default : null;

export default _defaultProxyTarget
  ? new Proxy(_defaultProxyTarget, {
      construct(target, args) {
        const ctorKey = /* "default" or firstNamedExport */;
        defaultConstructor ??= librarySandbox.arena.evalCode(
          `(...args) => new __SANDBOXED_LIB__["${ctorKey}"](...args)`
        );
        return librarySandbox.wrapResult(defaultConstructor(...args));
      },
      get(target, key, receiver) {
        if (typeof key === "symbol") return Reflect.get(target, key, receiver);
        const val = Reflect.get(target, key, receiver);
        if (val !== undefined) return val;
        return _defaultSingleton?.[key];   // fall through to singleton
      }
    })
  : proxyExports.default;
```

**Trade-off:** The heuristic of "first named function export" works well for the common single-class pattern but is not a substitute for per-subpath proxy modules. If a library exports multiple unrelated classes as named exports, the fallback picks whichever happens to be first in `exportedNames`. This is acceptable for compatibility testing but would need explicit configuration in a production tool.

---

## 13. `createInstance` — Arena-bypass constructor for WeakMap-private-field classes

**Problem:** The `wrapReturned` mechanism (AD#9) stores a newly constructed QJS instance in `globalThis.__SANDBOX_TEMP__` by passing the host-side Arena proxy back into QJS via a setter closure:

```js
const setter = arena.evalCode(`(v) => globalThis.__SANDBOX_TEMP__.set(${id}, v)`);
setter(obj); // obj = Arena proxy of the QJS instance
```

This involves a **host→QJS round-trip**: the Arena receives the host proxy and marshals it back to QJS. However, the Arena does not recognise the proxy as a previously-seen QJS handle — it creates a **new plain QJS object** from the proxy's enumerable properties. This new object was never initialised by the class constructor, so module-level WeakMaps used for TypeScript-compiled private field emulation (`__classPrivateFieldGet`) contain no entry for it. Any subsequent method call that touches a private field throws:

```
TypeError: Cannot read private member from an object whose class did not declare it
```

The failure manifested when running `mime`'s `getAllExtensions()` test against the sandboxed proxy: `mime` compiles ES2022 private fields to WeakMaps (`_Mime_extensionToType`, `_Mime_typeToExtension`, `_Mime_typeToExtensions`). A freshly constructed `new Mime(…)` instance stored via the setter round-trip was a different object than the one whose WeakMap entries were set in the constructor, making every method access fail.

**Root cause in depth:** `wrapReturned` was designed for objects *returned* from QJS method calls, where the object is marshalled host→QJS as a function argument. For direct constructor results the same code path is used (`wrapResult(Ctor(...args))`), but `Ctor(...args)` already crosses the QJS→host boundary once; the subsequent `setter(obj)` crosses it again in the opposite direction. The Arena's marshal table maps *host object identity* to QJS handles, but the table entry for a QJS-originated proxy may not be stable across the two crossings (the proxy wrapper is a new JS object each time), so the round-trip silently creates a second, unrelated QJS object.

**Solution:** `SandboxManager.createSandbox` now returns a `createInstance(ctorKey, constructorArgs)` helper that **never lets the instance cross the host boundary before it is stored**:

```js
createInstance: (ctorKey, constructorArgs) => {
  const id = tempIdCounter++;
  arena.evalCode(`if (!globalThis.__SANDBOX_TEMP__) globalThis.__SANDBOX_TEMP__ = new Map();`);
  const ctor = arena.evalCode(
    `(...args) => { const _i = new __SANDBOXED_LIB__["${ctorKey}"](...args);
                    globalThis.__SANDBOX_TEMP__.set(${id}, _i);
                    return _i; }`
  );
  const result = ctor(...constructorArgs);
  return wrapReturned(arena, result, id);   // preStoredId skips the setter
}
```

Inside QJS, the constructor creates the instance and immediately stores it in `__SANDBOX_TEMP__` under a pre-allocated `id`. `wrapReturned` is then called with `preStoredId = id`, which skips the `setter(obj)` round-trip entirely — `__SANDBOX_TEMP__.get(id)` is guaranteed to be the object that was initialised by the class constructor, with all WeakMap entries intact.

`wrapReturned` gains an optional third parameter `preStoredId`; when provided the setter step is unconditionally bypassed.

All proxy construct traps are updated to use `createInstance` instead of `wrapResult(Ctor(...args))`, and the proxy generator template is updated accordingly so future generated proxies are correct by default.

---

## 14. `wrapReturned` — reading primitive properties directly from the live QJS object

**Problem:** In `wrapReturned`, the `get` trap of the returned Proxy read `target[key]` for all non-function, non-object values, where `target` is the Arena sync-proxy of the QJS object. The Arena materialises each QJS object via `ctx.dump()`, which performs a shallow JSON-style dump of the object's **own enumerable properties**. Class getter accessors (e.g. `get year()`, `get month()`, `get day()` on Luxon's `DateTime`) are defined on the **prototype**, not as own data properties — they are invisible to `ctx.dump()` and therefore absent from the materialised snapshot. Accessing `dt.year` on a `wrapReturned` proxy returned `NaN` (or `undefined`) instead of the actual year, causing 126 test failures across Luxon's datetime test suite.

**Root cause in depth:** The Arena's `ue()` / sync-proxy mechanism serialises a QJS object once into a host plain object. Prototype-based getter properties are invoked the first time they are accessed on the live QJS object, and their results may be cached internally on the QJS instance. A JSON dump of the instance never calls those getters; it only sees data properties written directly to the object's own slot. For Luxon `DateTime` this means all computed calendar fields (`year`, `month`, `day`, `hour`, `minute`, `second`, `millisecond`, `weekNumber`, etc.) read as `NaN` from the Arena proxy.

**Solution:** The `wrapReturned` proxy's `get` trap now reads **primitive-valued properties directly from the live QJS object** stored in `globalThis.__SANDBOX_TEMP__` under the instance's pre-allocated `id`, using the same `arena.evalCode()` pattern already used for method calls. Each key gets a cached property-getter function to avoid repeated `evalCode` calls:

```js
const propGetterCache = new Map();

// inside the Proxy get trap, after the function / object branches:
if (!propGetterCache.has(key)) {
  propGetterCache.set(
    key,
    arena.evalCode(
      `() => globalThis.__SANDBOX_TEMP__.get(${id})["${key}"]`,
    ),
  );
}
return propGetterCache.get(key)();
```

This ensures that QJS prototype getters are always invoked inside the VM with the correct `this`, and their results are returned to the host as plain host primitives via Arena's normal dump path.

**Impact:** After the fix, `dst.test.js` (the primary affected file) went from 0/28 to 28/28 passing tests. Overall Luxon compatibility improved from 211 to 327 passing tests (out of 367 total). The remaining 40 failures are pre-existing issues unrelated to this fix: locale-dependent `Intl` output differences between the host node process and the QuickJS VM (whose ICU data may use different default locale), object reference identity assertions across the membrane, and an unrelated circular-JSON serialisation error in Jest's worker IPC when test modules expose raw QuickJS context objects.

**Trade-off:** Every new primitive property key incurs one `evalCode` call the first time it is accessed, after which the result is served from `propGetterCache`. This is consistent with the cost already paid for method bindings and is negligible compared to the WASM call overhead.
