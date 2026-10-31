# Architectural Decisions & Implementation Notes

**Status:** Living historical record. Decisions describe the implementation state at the time they were made. The current consolidated behaviour is defined by [sandbox-plugin-spec-v2.md](sandbox-plugin-spec-v2.md); later decisions and source code supersede conflicting earlier examples.

Performance measurements and instrumented membrane code are maintained on `feat/sandbox-benchmarking`. The workload-adapter contract remains implemented on `main`, but this branch declares no workloads; the benchmark workloads and measurement tooling are branch-specific.

This document records the key design decisions, constraints, and non-obvious fixes made during development. It provides historical context for contributors; the current implementation contract is defined by [sandbox-plugin-spec-v2.md](sandbox-plugin-spec-v2.md).

---

## 1. Per-library QuickJS context (no shared VM)

**Decision:** Each sandboxed library receives its own `newQuickJSAsyncWASMModule()` instance and context, rather than sharing a single WASM module.

**Rationale:** Sharing a context between libraries would allow cross-library object graph access, breaking isolation. A separate WASM module per library provides a hard memory boundary: one library cannot reach into another's heap even through the Arena bridge.

**Trade-off:** Higher memory footprint and initialisation time. Acceptable for a spike; a production implementation could explore context-level isolation within a shared module if WASM memory limits become a concern.

**Update (AD#27):** `createSandbox()` now instantiates the synchronous build through `newQuickJSWASMModule()`. Each call still creates a separate WebAssembly module and linear memory, so the per-library memory boundary is unchanged.

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

**Superseded by AD#27:** pending jobs now drain in a host microtask after each observed context entry; a 10 ms interval remains only as a fallback.

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

**Update (AD#27):** `unrefPump()` now unreferences only the fallback interval. Because pending jobs drain in a microtask after each boundary call, awaiting a sandbox Promise no longer needs another live handle.

---

## 11. Node entry points for child compiler bundles

**Problem:** Libraries like nanoid ship separate browser and Node.js entry points. The `browser` field in `package.json` remaps `./index.cjs` → `./index.browser.cjs`. Webpack's default `target: 'web'` picks up this mapping, producing browser-variant bundles. The browser variant may have subtle differences (e.g. different termination checks, different crypto usage) that break inside QuickJS.

**Solution:** A `NormalModuleReplacementPlugin` is applied to each child compiler to rewrite `.browser.(cjs|mjs|js)` imports back to their Node equivalents. An externals mapping `{ "node:crypto": "crypto" }` ensures that `require('node:crypto')` resolves to the global `crypto` object, which is injected by the sandbox permissions membrane when the library's config includes the `"crypto"` permission.

**Note:** Child compilers inherit the parent's compiled resolver, so setting `resolve.aliasFields` or `resolve.mainFields` after `createChildCompiler()` is too late — the resolver is already initialized. The `NormalModuleReplacementPlugin` approach works because it operates at the module-request level, after resolution.

**Note (24/10/2026):** The current `compileLibrary()` resolves the package entry with Node.js resolution, which covers a package-level `browser` entry. It does not apply the `.browser.` replacement described above, so a `browser` map of internal modules still selects the browser file for a web target. The unit suite guards the entry case in `webpack-sandbox-plugin/test/import-redirection.test.mjs` and records the internal-map case there as a `todo`.

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

## 4/04/2026 - 13. `createInstance` — Arena-bypass constructor for WeakMap-private-field classes

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
  const result = sbHelpers.tempCreate(ctorKey, id, ...constructorArgs);
  return wrapReturned(arena, result, id, sbHelpers);
}
```

`sbHelpers.tempCreate` is a QJS function pre-compiled at sandbox startup (see AD#19) that constructs the instance and stores it in `__SANDBOX_TEMP__` **entirely inside QJS** before returning:

```js
// Compiled once; called many times with no further parse/compile cost.
(ctorKey, id, ...args) => {
  const inst = new __SANDBOXED_LIB__[ctorKey](...args);
  globalThis.__SANDBOX_TEMP__.set(id, inst);
  return inst;
}
```

Inside QJS, the constructor creates the instance and immediately stores it in `__SANDBOX_TEMP__` under a pre-allocated `id`. `wrapReturned` is then called with `preStoredId = id`, which skips the host-side setter round-trip entirely — `__SANDBOX_TEMP__.get(id)` is guaranteed to be the object that was initialised by the class constructor, with all WeakMap entries intact.

`wrapReturned` gains an optional third parameter `preStoredId`; when provided the setter step is unconditionally bypassed.

All proxy construct traps are updated to use `createInstance` instead of `wrapResult(Ctor(...args))`, and the proxy generator template is updated accordingly so future generated proxies are correct by default.

---

## 4/04/2026 - 14. `wrapReturned` — reading primitive properties directly from the live QJS object

**Problem:** In `wrapReturned`, the `get` trap of the returned Proxy read `target[key]` for all non-function, non-object values, where `target` is the Arena sync-proxy of the QJS object. The Arena materialises each QJS object via `ctx.dump()`, which performs a shallow JSON-style dump of the object's **own enumerable properties**. Class getter accessors (e.g. `get year()`, `get month()`, `get day()` on Luxon's `DateTime`) are defined on the **prototype**, not as own data properties — they are invisible to `ctx.dump()` and therefore absent from the materialised snapshot. Accessing `dt.year` on a `wrapReturned` proxy returned `NaN` (or `undefined`) instead of the actual year, causing 126 test failures across Luxon's datetime test suite.

**Root cause in depth:** The Arena's `ue()` / sync-proxy mechanism serialises a QJS object once into a host plain object. Prototype-based getter properties are invoked the first time they are accessed on the live QJS object, and their results may be cached internally on the QJS instance. A JSON dump of the instance never calls those getters; it only sees data properties written directly to the object's own slot. For Luxon `DateTime` this means all computed calendar fields (`year`, `month`, `day`, `hour`, `minute`, `second`, `millisecond`, `weekNumber`, etc.) read as `NaN` from the Arena proxy.

**Solution:** The `wrapReturned` proxy's `get` trap now reads **primitive-valued properties directly from the live QJS object** stored in `globalThis.__SANDBOX_TEMP__` under the instance's pre-allocated `id`. Each key gets a cached host-side closure (backed by a pre-compiled QJS helper — see AD#19) to avoid repeated `evalCode` calls:

```js
const propGetterCache = new Map();

// inside the Proxy get trap, after the function / object branches:
if (!propGetterCache.has(key)) {
  propGetterCache.set(key, () => sbHelpers.tempGet(id, key));
}
return propGetterCache.get(key)();
```

`sbHelpers.tempGet` is a QJS function compiled once at sandbox startup — `(id, key) => globalThis.__SANDBOX_TEMP__.get(id)[key]` — so the first access of a new property key pays only the cost of a QJS function call, not a parse+compile cycle. This ensures that QJS prototype getters are always invoked inside the VM with the correct `this`, and their results are returned to the host as plain host primitives via Arena's normal dump path.

**Impact:** After the fix, `dst.test.js` (the primary affected file) went from 0/28 to 28/28 passing tests. Overall Luxon compatibility improved from 211 to 327 passing tests (out of 367 total). The remaining 40 failures are pre-existing issues unrelated to this fix: locale-dependent `Intl` output differences between the host node process and the QuickJS VM (whose ICU data may use different default locale), object reference identity assertions across the membrane, and an unrelated circular-JSON serialisation error in Jest's worker IPC when test modules expose raw QuickJS context objects.

**Trade-off:** Every new primitive property key incurs one pre-compiled QJS call the first time it is accessed, after which the result is served from `propGetterCache`. This is consistent with the cost already paid for method bindings and is negligible compared to the WASM call overhead.

---

## 03/04/2026 - 15. State Sync vs. RPC Membrane (`quickjs-emscripten-sync` assessment)

**Decision:** Adopted `quickjs-emscripten-sync` (the Arena) as the core boundary synchronization layer, despite its friction with object identity preservation on VM-to-Host exports.

**Rationale:** Building a robust membrane for projecting complex host graphs (like the DOM or `localStorage`) into WebAssembly is extremely complex. `quickjs-emscripten-sync` handles the **Host → VM** projection, creating synchronized proxies and marshaling operations automatically. This supports granular, policy-driven Web API exposure with minimal custom infrastructure.

**Trade-off:** The library's state-synchronization model is lossy when moving complex object graphs from the **VM → Host** (stripping prototypes, class getters, and breaking object identity/private fields). 

**Implementation Note:** To achieve transparent API compatibility for the host application (allowing it to consume sandboxed OOP libraries seamlessly), the system implements a custom "Reverse RPC Membrane" (`bindSandboxExport`, `wrapReturned`, `createInstance`). This bypasses the Arena's default `ctx.dump()` mechanism, forcing methods to execute in-place within QJS, thus preserving encapsulation and prototype behaviors.

**Future Work (Productionization):** The current reverse-membrane pins QJS object identities in a global `__SANDBOX_TEMP__` Map to prevent identity loss. In a production environment, this introduces a memory leak. A host-side `FinalizationRegistry` attached to the host Proxies should be implemented to evaluate `globalThis.__SANDBOX_TEMP__.delete(id)` when the host proxy is garbage collected.

---

## 03/04/2026 - 16. Patching `ue()` in `quickjs-emscripten-sync` — `new.target` identity loss

**Problem:** `quickjs-emscripten-sync`'s Arena wraps QJS functions as host callables via an internal function `ue()`. When such a callable is invoked with `new` (the `new.target` branch), the original code was:

```js
if (new.target) {
  const [h] = r(y(n, "(Cls, ...args) => new Cls(...args)", p, e, ...l));
  return Object.defineProperties(this, Object.getOwnPropertyDescriptors(h)), this;
}
```

`h` is the Arena sync proxy registered in the Arena's bidirectional identity map (`_map`). However, the function returns `this` — a fresh object created by the JavaScript engine as the implicit receiver of the `new` call. `this` is **not** registered in the Arena's map.

The consequence: every subsequent method call on the constructed instance (e.g. `largeStack.set(key, value)`) fails to find the instance in the Arena's map via `_marshalFind`. The Arena then re-marshals the host object by copying its enumerable properties into a **new, temporary QJS object** for each call. This temporary object is a structurally equivalent copy but a distinct object — it is not the original QJS instance.

This breaks any operation that requires **state persistence across calls**. The most concrete manifestation was lodash's `Stack.set()`: over 199 calls, the QJS ListCache accumulates 199 key–value pairs via in-place mutation. On the 200th call, lodash's internal `stackSet` upgrades the backing store by reassigning `this.__data__ = new MapCache(pairs)`. With the unregistered `this` producing a fresh temporary QJS object on each call, this assignment is discarded; the next call still sees the old ListCache with 199 entries, perpetually re-attempting the failed upgrade.

Eventually the QJS Stack and its ListCache — held only transitively by `h`, which was discarded as a local variable after `ue()` returned `this` — are garbage-collected by the QJS runtime. Arena's map retains the now-freed handle. Any call that dereferences it inside QJS evaluates to `undefined`, producing the terminal error:

```
QuickJSUnwrapError [TypeError]: cannot read property 'set' of undefined at stackSet (<input>:2409:11)
```

**Solution:** Return `h` directly instead of `this`. In JavaScript, when a constructor explicitly returns an object, `new` evaluates to that returned object and discards the implicit `this`. Since `h` is the properly registered Arena sync proxy, all subsequent `_marshalFind` lookups succeed and the actual QJS instance is used consistently across calls.

```js
// Before (original library code):
return Object.defineProperties(this, Object.getOwnPropertyDescriptors(h)), this;

// After (patched):
return h;
```

**Maintenance:** The library is patched via `patch-package`. The patch file is committed at `patches/quickjs-emscripten-sync+1.8.1.patch` and is re-applied automatically via the `postinstall` script (`"postinstall": "patch-package"` in `package.json`). The diff originally was a single-line change to `node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js`; AD#27 extends the same patch file with the boundary fast path and handle-ownership fixes.

**Scope:** The patch affects all `new arenaProxy(args)` call sites — i.e. any host code that obtains an Arena sync proxy of a QJS constructor and invokes it with `new`. The existing `createInstance` helper (AD#13) was already immune to this bug because it constructs and stores the instance entirely inside QJS without crossing the `new.target` branch. The patch makes raw Arena proxies used as constructors consistent with `createInstance`'s behaviour.

---

## 04/04/2026 - 17. Proxying Exported Functions: The `apply` Trap

**Problem:** When testing libraries that heavily rely on exported functions that return chainable objects (e.g., `zod` with `z.string().min(3)`), the generated sandbox proxies were returning `undefined` for the initial function call. This caused a `TypeError: Cannot read properties of undefined` on the subsequent chained method. The proxy generator was creating a `new Proxy` over a dummy target function (`function _target() {}`) to satisfy the JavaScript requirement that a proxy target must be callable to be invoked as a function. However, it only implemented the `construct` and `get` traps, omitting the `apply` trap. As a result, direct function calls on the proxy fell through to the empty dummy target, which returned `undefined`.

**Solution:** The proxy generator was updated to include an `apply` trap for both default and named exports. 

```javascript
apply(_target, _thisArg, args) {
  return proxyExports["${name}"](...args);
}
```

This ensures that when an exported function is invoked (e.g., `z.string()`), the call is correctly intercepted and forwarded to the Arena-wrapped `proxyExports` (which internally delegates to `arena.evalCode`), preserving the execution context and returning the actual result from within the QuickJS VM.

---

## 04/04/2026 - 18. Performance Limitations of "Chatty" APIs (The Boundary Crossing Problem)

**Problem:** Testing heavily chained APIs (like `zod` with `z.string().min(3).optional()`) revealed a significant performance degradation (7x-9x slower than native execution). Every single method call in the chain creates a new object and forces a round-trip across the WebAssembly membrane, incurring massive overhead for argument marshalling, VM execution, result marshalling, and Reverse Membrane proxy allocation.

**Root Cause in depth:** The system suffers from the "Chatty vs. Chunky" IPC (Inter-Process Communication) problem. The Reverse Membrane pattern prioritizes perfect API transparency and object identity preservation. To maintain this, it cannot generically defer execution or batch chained calls because it has no way of knowing which calls are intermediate builders (e.g., `.min(3)`) and which are terminal executors (e.g., `.parse()`). As a result, every property access or method invocation pays the cost of a full boundary context switch.

**Conclusion:** This performance penalty for high-frequency chained operations is an assumed and fundamental architectural trade-off of the zero-trust WebAssembly membrane. Perfect memory isolation and transparent programmatic access come at the cost of serialization and boundary-crossing latency.

**Mitigation Strategy:** For libraries heavily reliant on Object-Oriented Builder patterns or immutable method chaining, the host application should shift the boundary by moving business logic into the sandbox. Instead of the host building the schema incrementally via the proxy, a small adapter module containing the schema definition should be bundled alongside the library inside the QuickJS VM. The host then makes one "chunky" call (e.g., `sandbox.validateMyData(data)`), moving the execution entirely into the Wasm heap at native QuickJS speeds. Alternatively, libraries with data-driven APIs (e.g., JSON schemas) avoid this issue entirely since the Arena can marshal plain configuration objects in a single pass.

---

## 04/04/2026 - 19. Pre-compiled QJS Helper Functions — eliminating per-call `evalCode` overhead

**Problem:** The reverse membrane functions `wrapReturned` (AD#9, AD#14) and `createInstance` (AD#13) used `arena.evalCode()` at the point of use to create QJS-side closures:

- One per wrapped object (setter: `(v) => __SANDBOX_TEMP__.set(${id}, v)`)
- One per unique `(object, methodName)` pair (method dispatch: `(...args) => __SANDBOX_TEMP__.get(${id})["${key}"](...args)`)
- One per unique `(object, propertyName)` pair (primitive getter: `() => __SANDBOX_TEMP__.get(${id})["${key}"]`)
- One per `createInstance` call (constructor: `(...args) => { const _i = new ...[ctorKey](...); __SANDBOX_TEMP__.set(${id}, _i); return _i; }`)

Each `arena.evalCode()` call triggers a full **parse → compile → execute** cycle inside QuickJS. For libraries that return many objects with multiple properties and methods (e.g. a Luxon `DateTime` instance exposes ~20 numeric getter properties and ~30 methods), initialising a single returned instance could issue dozens of `evalCode` calls. At scale this adds hundreds of unnecessary compile passes to steady-state execution.

Additionally, the `__SANDBOX_TEMP__` Map was initialised by a guard (`if (!globalThis.__SANDBOX_TEMP__) …`) that was re-evaluated — and therefore re-compiled — on every single `wrapReturned` call, even though the condition is trivially true after the first call.

**Solution:** Four generic QJS helper functions are compiled **once** at sandbox creation time, immediately after the library bundle is loaded into the VM:

```js
// Initialise storage unconditionally — no per-call guard needed.
arena.evalCode("globalThis.__SANDBOX_TEMP__ = new Map();");

const sbHelpers = {
  // (id, value) → void  — store an object by id
  tempSet:    arena.evalCode("(id, v) => globalThis.__SANDBOX_TEMP__.set(id, v)"),
  // (id, key, ...args) → result  — call a stored object's method
  tempCall:   arena.evalCode("(id, key, ...args) => globalThis.__SANDBOX_TEMP__.get(id)[key](...args)"),
  // (id, key) → value  — read a stored object's property
  tempGet:    arena.evalCode("(id, key) => globalThis.__SANDBOX_TEMP__.get(id)[key]"),
  // (ctorKey, id, ...args) → instance  — construct, store, and return
  tempCreate: arena.evalCode(
    "(ctorKey, id, ...args) => { const inst = new __SANDBOXED_LIB__[ctorKey](...args); globalThis.__SANDBOX_TEMP__.set(id, inst); return inst; }"
  ),
};
```

`sbHelpers` is threaded as an explicit parameter through `wrapReturned`, `maybeWrapResult`, `bindSandboxFunction`, and `bindSandboxExport`. The call sites become:

| Operation | Old (per-use `evalCode`) | New (pre-compiled call) |
|---|---|---|
| Store returned object | `const s = arena.evalCode(\`(v) => …set(${id}, v)\`); s(obj)` | `sbHelpers.tempSet(id, obj)` |
| Method dispatch | `arena.evalCode(\`(...args) => …get(${id})["${key}"](...args)\`)` | host closure: `(...args) => sbHelpers.tempCall(id, key, ...args)` |
| Primitive getter | `arena.evalCode(\`() => …get(${id})["${key}"]\`)` | host closure: `() => sbHelpers.tempGet(id, key)` |
| Construct instance | `arena.evalCode(\`(...) => { new …[ctorKey](); …set(${id}, _i); }\`)` | `sbHelpers.tempCreate(ctorKey, id, ...args)` |

After this change, the only `evalCode` calls that remain on the hot path are in `bindSandboxFunction` — one per unique export access path (e.g. `(...args) => __SANDBOXED_LIB__["parse"](...args)`). These are bounded by the library's public API surface, already cached after the first property access, and do not grow with the number of returned objects.

**Scope of change:** The optimisation is entirely internal to `sandbox-manager.js`. The public interface of `createSandbox` (`exports`, `wrapResult`, `createInstance`, `dispose`) is unchanged.

**Disposal:** The four `sbHelpers` handles are QJS function objects that must be freed with the sandbox. They are added to the `dispose()` routine alongside the existing pre-compiled handles (`isTypedArrayInVM`, `typedArrayCreators`, `unmarshalHelpers`):

```js
for (const fn of Object.values(sbHelpers)) {
  if (fn.alive) fn.dispose();
}
```

---

## 04/04/2026 - 20. Date objects must not be wrapped by `wrapReturned`

**Problem:** Functions from date-processing libraries (e.g. `date-fns`) return `Date` objects. These results passed through `maybeWrapResult`, which checks `typeof result === "object"` and routes non-TypedArray objects into `wrapReturned`. `wrapReturned` then creates a `Proxy` over the host `Date`.

This Proxy is transparent for `instanceof Date` (JavaScript's `instanceof` delegates `[[GetPrototypeOf]]` through Proxy, so the prototype chain is correctly resolved to `Date.prototype`). Tests using `toBeInstanceOf(Date)` therefore pass. However, `Object.prototype.toString.call(proxy)` returns `"[object Object]"` instead of `"[object Date]"`, because the `[[DateValue]]` internal slot check performed by `Object.prototype.toString` is **not** delegated through a Proxy.

Vitest's `toEqual` uses `Object.prototype.toString` to determine whether two values are Dates before comparing their timestamps. When the result is a `wrapReturned` Proxy, `toString` returns `"[object Object]"`, so `toEqual` falls through to generic deep-object comparison, finds the Arena-dumped Date shell to be `{}` (Date has no own enumerable properties), and fails with `expected <Anonymous Class>{} to deeply equal 2014-12-01T22:59:59.999Z`.

**Root cause:** `wrapReturned` was designed for OOP objects whose state lives in QJS private fields or prototype getters (e.g. Luxon `DateTime`, Mime). Applying it to plain value-type objects like `Date` is incorrect: the value is fully captured in a single primitive (the timestamp) that the Arena already extracts correctly.

**Why the Arena already handles Dates:** `quickjs-emscripten-sync` has a built-in Date marshaller/unmarshaller pair:
- **Host → QJS** (line 158 of the Arena source): `n instanceof Date ? new Date(d)` — converts a host Date to a QJS Date via its timestamp.
- **QJS → Host** (function `fe`, line 394): checks `a instanceof Date` inside QJS and returns `new Date(timestamp)` — converts a QJS Date back to a proper host Date before any sync-proxy is created.

By the time `maybeWrapResult` receives the result of a sandboxed call, it is already a proper host `Date` instance. Wrapping it in `wrapReturned` is both redundant and destructive.

**Solution:** Add `!(result instanceof Date)` guards in the three places where `wrapReturned` is invoked with an object-typed value:

1. **`maybeWrapResult`** — prevents wrapping Date objects returned directly from `bindSandboxFunction`'s `apply` trap.
2. **`wrapReturned` → `fnCache` handler** — prevents wrapping Date objects returned from method calls dispatched via `sbHelpers.tempCall`.
3. **`wrapReturned` → `get` trap object branch** — prevents wrapping Date-valued properties accessed on a `wrapReturned` Proxy.

```js
// maybeWrapResult
if (result !== null && typeof result === "object" && !isTypedArrayView(result) && !(result instanceof Date)) { ... }

// wrapReturned fnCache handler
if (result !== null && typeof result === "object" && !isTypedArrayView(result) && !(result instanceof Date)) { ... }

// wrapReturned get trap — object property branch
if (typeof value === "object" && value !== null && !isTypedArrayView(value) && !(value instanceof Date)) { ... }
```

**Impact:** Resolves the `<Anonymous Class>{}` pattern for Date-returning library functions (e.g. `endOfHour`, `setSeconds`, `endOfMinute` in date-fns). `toEqual(new Date(...))` assertions now pass because the result is a genuine host `Date` instance with correct `Object.prototype.toString` semantics.

**Note on Date subclasses (`UTCDate`, `TZDate`):** Libraries that use Date subclasses (e.g. `@date-fns/utc`, `@date-fns/tz`) inside the sandbox will still not satisfy `instanceof UTCDate` or `instanceof TZDate` on the host, because the Arena's built-in Date unmarshaller always produces `new Date(timestamp)` — a plain Date. The subclass type information is lost at the QJS→host boundary. Tests asserting on Date subclass identity remain expected failures under the membrane constraints documented in §6.

---

## 29/04/2026 - 21. Explicit workload adapters for coarse-grained performance mode

**Problem:** Transparent sandboxing keeps application imports unchanged, but it exposes every public library call through the host/sandbox membrane. This is acceptable for low-frequency calls and for libraries whose workload is dominated by one large operation, but it is a poor fit for chatty APIs. Lodash collection pipelines and Zod validation workflows can trigger many boundary crossings and large serialized payloads. Browser performance results showed these two scenarios as clear outliers in execution time and heap usage.

**Decision:** Keep transparent import redirection as the default mode, and add an opt-in explicit workload-adapter path for measured hot spots. In this mode, selected developer-written workload modules are bundled into QuickJS alongside the target library. The host calls a coarse-grained workload function instead of driving the fine-grained library API directly.

**Implementation:** `.sandbox/sandbox.config.js` can define workload entries under a configured library:

```js
"zod": {
  permissions: [],
  workloads: {
    validation: {
      entry: "performance-harness/browser/workloads/zod/validation-workload.js",
      exports: ["validateOrders"],
    },
  },
}
```

For each configured workload, `WebpackSandboxPlugin`:

1. Generates `.sandbox/proxys/<library>-<workload>-workload-proxy.js`.
2. Creates a child compiler that emits `dist/<library>.<workload>.workload.bundle.js`.
3. Rewrites host imports of `sandbox-workload/<library>/<workload>` to the generated workload proxy.
4. Compiles `sandbox-real/<library>` as an external reference to the already-loaded `__SANDBOXED_LIB__` global, so the workload bundle does not include a second copy of the library and does not recursively import the normal generated library proxy.

The normal generated library proxy owns the QuickJS sandbox. It creates one sandbox for the configured library and exposes the transparent API as before. When a workload proxy is imported, it imports an internal async helper from the library proxy, lazily loads the workload bundle, evaluates it inside the existing library sandbox through `librarySandbox.loadWorkload(...)`, and exports host-callable functions that delegate to those workload exports.

This keeps transparent library-only imports from paying workload evaluation cost, while ensuring that code importing both `lodash` and `sandbox-workload/lodash/collection` shares the same `lodash` sandbox, loaded library instance, permission policy, async-job pump, and disposal lifecycle.

**Proof-of-concept workloads:**

- `lodash/collection` exposes `summarizeOrders(orders)`, keeping Lodash filtering, grouping, chaining, and aggregation inside QuickJS.
- `zod/validation` exposes `validateOrders(orders, invalidOrder)`, keeping schema construction and validation inside QuickJS.

These proof-of-concept workload declarations and their source modules are maintained on `feat/sandbox-benchmarking`; they are intentionally not declared in `main`'s `.sandbox/sandbox.config.js`. The browser harness there includes adapter scenarios for both workloads so native and sandbox adapter-level execution can be measured with the same CSV pipeline as transparent scenarios.

**Security impact:** The third-party library still runs inside the same isolated QuickJS/WebAssembly boundary with the same permission configuration. The optimized path can improve security for hot workflows because selected developer-written adapter code also runs inside the sandbox. The host sends plain input data and receives a deliberately small result object instead of manipulating many intermediate untrusted library objects.

**Trade-off:** The developer must explicitly move performance-sensitive logic into a workload module and configure it. This is less transparent than bare import redirection, but it is still a small, inspectable change and avoids broad application rewrites. The transparent mode remains the default compatibility story.

**Future work:** Annotation-based lifting could reduce the manual work by letting the developer mark a function for sandbox execution and letting the webpack plugin generate the workload bundle and proxy automatically. This should remain conservative: captured values must be serializable or explicitly supported, DOM references and mutable host state should be rejected by default, and the plugin should fail closed with clear diagnostics.

---

## 17/07/2026 - 22. Structured errors are active boundary values

**Problem:** Arena's generic conversion could surface QuickJS exceptions as bridge-specific wrapper objects. Test runners then observed the wrong host constructor and could recursively format large context graphs instead of reporting the original error.

**Decision:** Register a dedicated error marshaller in `.sandbox/marshallers/index.js`. It recreates supported error constructors on the receiving side and transfers `name`, `message`, `stack`, `cause`, and bounded JSON-safe custom fields.

**Consequence:** Error behaviour is closer to the originating realm and diagnostics remain finite. Exact prototypes and arbitrary non-serialisable custom fields are still not guaranteed across the boundary.

**Note (24/10/2026):** The unit suite shows that the implementation does not copy `cause`, and that thrown errors are not reconstructed as host subclasses. The canonical specification (§8) describes the implemented behaviour. Both gaps are recorded as `todo` cases in `.sandbox/test/marshallers.test.mjs`.

**Note (25/10/2026):** Thrown errors still surface as `QuickJSUnwrapError`, but the runtime now removes its QuickJS `context` reference so error serializers cannot reach the WebAssembly heap (AD#27).

---

## 17/07/2026 - 23. Expose a constrained crypto facade

**Problem:** TweetNaCl requires secure random bytes, but exposing the complete host `Crypto` object would grant more authority than the evaluated library needs and introduces native receiver constraints.

**Decision:** Treat the `crypto` permission as a special capability. Host helpers produce random bytes and optional UUIDs; QuickJS receives a null-prototype facade implementing `getRandomValues()` and `randomUUID()` when supported. `getRandomValues()` accepts only integer typed arrays and enforces the browser-compatible 65,536-byte quota.

**Consequence:** The evaluated cryptographic library receives the required entropy without a general live reference to the host `Crypto` object. Other permission names continue through the generic forward membrane.

---

## 19/07/2026 - 24. Recognise browser constructor-only error messages

**Problem:** Arena invokes exposed functions without JavaScript `new` syntax. `makeCallable()` falls back from `Reflect.apply` to `Reflect.construct` only when the thrown `TypeError` matches a known constructor-only message. Chromium's `TextEncoder` reports “use the 'new' operator” / “cannot be called as a function”, which the original matcher missed.

**Decision:** Extend `REQUIRES_NEW_RE` with the Chromium wording while retaining the existing Node and library-specific forms.

**Consequence:** Browser constructors such as `TextEncoder` remain usable through configured permissions, which is required by the Image.js security scenario. Unrelated `TypeError` exceptions continue to propagate instead of being reinterpreted as constructor calls.


## 02/10/2026 - 25. Reviewable Jev capability preparation and explicit runtime policy

**Decision:** Keep Jev in an optional preparation CLI. Share normalized policy loading and isolated child compilation with the runtime build. Collect transformed installed/transitive package evidence, classify bounded capability questions using pinned Jev 1.13.0, and render editable local artifacts. Supported high-probability feature needs may enter the draft; sensitive, unvalidated and incomplete outcomes remain review items. Preserve developer permissions and workload declarations. Never automatically apply a draft.

**Rationale:** Capability selection depends on installed code and optional features. Package names and generated model prose cannot establish a least-authority policy. A separate command allows explicit source transmission, cache/offline operation and human review while keeping normal builds deterministic and free of model credentials or network requests.

**Runtime policy:** Generated proxies pass the compiler-selected permission list through SandboxManager to exposure. Explicit empty policies remain empty; direct callers omitting permissions retain the existing default-module fallback. This corrects the previous mismatch between custom compiler configPath and the hard-coded runtime policy. Missing permission lists normalize to []; malformed lists fail validation.

**Consequences:** The initial catalogue proposes only currently supported exposure semantics. The crypto facade retains its randomness/UUID scope. Model probabilities use an initial 0.90 review threshold, not a demonstrated security guarantee. Incomplete source extraction and unsupported APIs can require manual work; static absence is not proof. Workloads are preserved but excluded from capability analysis. See the [advisor guide](../../capability-advisor/README.md) for maintained operational contracts.


## 22/10/2026 - 26. SubQ Snap replaces Jev as the capability-advisor model

**Decision:** The capability advisor classifies capability questions with SubQ Snap (`subq-snap-1.1`) through SubQ's System One endpoint, `POST https://api.subq.ai/v1/systemone`, authenticated with `SUBQ_API_KEY`. The existing System One SDK remains the transport: it already sends Bearer-authenticated `state`/`questions`/`model` requests to `/v1/systemone`. The base URL is passed explicitly, so SDK environment variables cannot redirect evidence. Prompts, catalogue, 0.90 threshold, draft rules, budgets, retries and cache semantics are unchanged.

**Rationale:** SubQ serves the same typed Choice contract and returns per-option probabilities, which the deterministic draft rules depend on. Retaining the transport keeps the change limited to provider identity and response tolerance.

**Consequences:** The pinned model identifier is part of every request and cache key, so earlier Jev classifications are not reused. SubQ reports `confidence` as optional and `output_tokens` as zero. Missing or null confidence is recorded as `null`, but a reported confidence outside [0, 1] is still rejected. Confidence never influences draft eligibility. Each request's 48 KiB budget keeps batches well below SubQ's 128-question limit. SubQ Snap is a public-preview model. Live accuracy has not been measured; this supersedes only the model choice in decision 25.

---

## 25/10/2026 - 27. Boundary fast path and QuickJS handle ownership

**Problem:** Profiling the ten evaluated libraries showed that sandbox time was dominated by boundary mechanics rather than guest execution. Arena compiled helper source with `evalCode` on routine crossings and read each property descriptor through a new host callback plus six property reads. It asked each of the four marshallers separately whether it claimed a handle, once while wrapping and again while unmarshalling. Every permitted Web API result became an identity-tracked wrapper with one host accessor per property. The asyncify build added a generator round trip to every call, and the 1 ms job pump delayed every sandboxed `await` by at least one timer tick. A Lodash scenario iteration issued about 375,000 context operations and a Luxon iteration about 522,000, 45,840 of them `evalCode` compilations.

**Decision:**

1. Extend `patches/quickjs-emscripten-sync+1.8.1.patch` so Arena compiles its QuickJS helpers once per Arena, before guest code runs, over captured intrinsics. It describes a QuickJS object's prototype and all own descriptors in one JSON crossing, and checks both identity maps in one crossing.
2. Make Arena dispose every unmarshalled handle its identity maps do not own, and return a duplicate when a host function's result is a map-owned handle.
3. Compile the registered marshallers' `handleTest` expressions into one QuickJS classifier, memoized per handle, and route claimed handles to `unmarshalClaimed()`.
4. Copy fresh plain-data Web API call results into QuickJS by value (`.sandbox/core/json-transfer.js`).
5. Use the synchronous QuickJS build for `createSandbox()`, memoize `typeof` per handle, drain pending jobs in a host microtask after each observed context entry with a 10 ms fallback interval, and remove the QuickJS context reference from errors raised by `vm.unwrapResult()`.

**Corrections found while validating:**

- Upstream Arena disposed an unmarshalled handle only when its value was already known. Custom-marshalled values, `Date` values and other unregistered results leaked QuickJS objects until teardown. The asyncify build does not assert on leaked objects, so this was invisible until the synchronous build aborted disposal after any `async` export call.
- quickjs-emscripten disposes the handle a host function returns. Arena returned map-owned handles from host accessors, which released the map's reference; the next read re-marshalled the value into a QuickJS object nothing owned. This leaked on disposal and gave repeated reads through an accessor a different object, the `child.parent` identity gap recorded in the unit suite.
- Arena converted evaluation results through `Lifetime.consume()`, which disposes a handle only when its callback returns. When converting a thrown error failed, for example under a memory limit, the error handle leaked. Upstream's memory-limit test aborted in `JS_FreeRuntime` and now passes.
- quickjs-emscripten attaches the owning context to `QuickJSUnwrapError`, and the context reaches the WebAssembly heap view. A test-runner serializer copying one failing sandbox error walked about 16.8 million keys (2.3 GB); Date-fns sandbox files with several such failures exhausted the Vitest worker heap and the Yup reporter stopped mid-run.
- The typed-array marshaller resolved the guest-reported `constructor.name` through `globalThis[typeName]`, so guest code could make the host construct an arbitrary host global with a copied buffer. Names now select only from a fixed list of typed-array constructors.
- `isArguments()` recursed without bound on a host copy of a QuickJS prototype with a `Symbol.toStringTag` accessor, such as `Object.getPrototypeOf(new Uint8Array(1))`. A re-entry guard treats such values as non-Arguments.

**Measured effect (Node.js 24, Windows, one machine, same day, one sandbox per process; median of the steady-state scenario iterations).** The scenario harness and counters were local diagnostics and are not part of the repository; the uninstrumented runtime was measured.

| Library | Before (ms) | After (ms) | Speed-up | Context operations per iteration |
|---|---:|---:|---:|---|
| luxon | 2,907 | 16.6 | ~175x | 522,210 to 3,731 |
| zod | 1,279 | 130 | ~9.8x | 396,665 to 44,058 |
| lodash | 494 | 68.5 | ~7.2x | 375,100 to 8,635 |
| date-fns | 23.4 | 3.4 | ~6.8x | |
| yup | 420 | 69.0 | ~6.1x | |
| image-js | 58.7 | 21.8 | ~2.7x | |
| marked | 200 | 76.3 | ~2.6x | |
| strip-ansi | 1.20 | 0.51 | ~2.3x | |
| mime | 0.24 | 0.11 | ~2.2x | |
| tweetnacl | 820 | 382 | ~2.1x | |

Sandbox initialisation also fell for every library (date-fns from 1,490 ms to 370 ms). Steady-state `evalCode` compilations dropped to zero. Keeping the asyncify build roughly halves the gain for compute-bound libraries (tweetnacl 833 ms, marked 190 ms). These numbers come from one machine and are indicative, not a substitute for the methodology on `feat/sandbox-benchmarking`.

**Consequences:**

- Receivers, `new.target` handling (AD#16) and deny-by-default exposure are unchanged; identity is now consistent across repeated accessor reads. Upstream Arena's `edge.test.ts` "getter" case expected a host object returned repeatedly by a raw-Arena getter to arrive with fresh values each time, which relied on the released handle. Exposed host objects reach QuickJS through `bindWebApi`, whose accessors read live host state, so sandbox code still sees host mutations.
- A plain-data Web API result inside QuickJS is a copy: mutations are not reflected on the host value, and repeated calls return distinct objects, as they already did natively.
- An awaited sandbox Promise now settles without a live timer handle after `unrefPump()` (AD#10).
- The patch is now a substantial diff over a bundled upstream file. Upgrading `quickjs-emscripten-sync` requires regenerating and re-validating it.
- A leaked QuickJS object now fails disposal deterministically. `.sandbox/test/boundary-runtime.test.mjs` holds a focused regression for each change and correction above.

---

## 30/10/2026 - 28. Declaration export names are untrusted input to code generation

**Problem:** The proxy generator copied export names reported by the TypeScript compiler into the generated host module as raw source text: inside string literals (`proxyExports["${name}"]`), in a comment, in the export clause, and as a property access for the default-constructor fallback (`proxyExports.${name}`). Those names come from the `.d.ts` files of the package being isolated. TypeScript accepts arbitrary string export names (`export { x as "..." }`), so a hostile declaration such as `export { x as "x\"]; <host code> //" }` produced a proxy that ran `<host code>` in the host realm at import time, outside QuickJS and outside the permission policy. Separately, sanitising names to identifiers mapped `a-b` and `a_b` to the same alias, which declared one binding twice. The reverse membrane had the same pattern on the QuickJS side: it built call expressions as `` `${accessPath}["${key}"]` ``, so a key containing a quote or line terminator produced invalid QuickJS source and the export could not be called.

**Decision:**

1. Treat every name embedded in generated source as data. `webpack-sandbox-plugin/src/utils/source-literals.ts` serialises names as JSON string literals, also escaping U+2028 and U+2029, which JSON leaves raw but JavaScript treats as line terminators.
2. Keep identifier export names (including reserved words) in identifier form with an `_export_<name>` alias. Export other names in the ES2022 string form with a positional `_exportString<n>` alias. Webpack 5 and Node.js accept string export names.
3. Fail generation for names that are not well-formed Unicode, which a module cannot export.
4. Escape library and workload names from the policy the same way. They are developer-controlled, but the generator should not depend on that.
5. Build reverse-membrane access paths with escaped keys (`memberAccessPath()`).

**Consequences:** A package's declarations can no longer add code to the host proxy. Unusual but legitimate export names become usable instead of breaking the generated module. Identifier export names keep their previous aliases, so generated proxies for the evaluated libraries change only in how the default-constructor fallback is read (`proxyExports["Mime"]` instead of `proxyExports.Mime`). This closes one build-time injection path; it is not a review of all generated code, and the parser still reports type-only names as runtime exports. Regressions live in `webpack-sandbox-plugin/test/source-literals.test.mjs`, `proxy-generator.test.mjs`, `generated-proxy.test.mjs` (hostile names imported end to end) and `.sandbox/test/reverse-membrane.test.mjs`.

---

## 31/10/2026 - 29. Membrane state is owned by each sandbox

**Problem:** The forward wrapper cache, the reverse export and returned-object caches, the by-value transfer offers and the `__SANDBOX_TEMP__` identifier counter were module-scoped, so every sandbox in a process shared them (issue #3). Two concrete failures followed:

1. A forward wrapper is a mutable host object that its Arena synchronizes with QuickJS. When sandbox A replaced `TestShared.describe` on a granted host object, the replacement was stored on the shared wrapper. Sandbox B, created later with the same permission, received that wrapper, so its call to `TestShared.describe(secret)` ran A's QuickJS function with B's arguments.
2. `sandbox.wrapResult(value)` returned the cached reverse wrapper of whichever sandbox wrapped `value` first. Calls through B's result therefore ran in A's context and failed with `Lifetime not alive` once A was disposed.

The module-scoped caches also kept wrappers for long-lived host values after their sandbox was disposed, and those wrappers kept the disposed Arena, and through it the WebAssembly module, reachable. Identifiers in `__SANDBOX_TEMP__` are visible to guest code and revealed how many objects other sandboxes had pinned.

**Decision:** `buildSandbox()` creates the membrane state for its sandbox through three factories: `createJsonTransfer()`, `createForwardMembrane({ offerJsonTransfer })` and `createReverseMembrane(arena, sbHelpers)`. The membrane modules keep no mutable module-scoped state. `exposeWebAPIs()` and `createArenaConfig()` receive the sandbox's forward membrane and transfer offers explicitly, and `createArenaConfig()` without offers transfers nothing by value. Sandbox disposal releases both membranes before the marshallers, helpers, Arena and context. After that, every wrapper and boundary helper of the sandbox throws `The sandbox has been disposed` rather than reaching the released context.

**Consequences:**

- Identity is preserved for repeated references and cycles within a sandbox, not across sandboxes. A replaced method or added property on one sandbox's wrapper is invisible to its siblings.
- Separate wrappers do not copy host state. Writes to existing data properties of a granted host object still go through to the host, so a function one library writes there remains callable by another library granted the same object. This is recorded as a `todo` case and in [isolation-coverage-and-cache-limitations.md](isolation-coverage-and-cache-limitations.md).
- A call through a disposed sandbox now throws a plain `Error` with that message instead of `QuickJSUseAfterFree`; `generated-proxy.test.mjs` pins the new message for `disposeLibrary()`. A second `dispose()` still throws `QuickJSUseAfterFree` from the Arena.
- Per-sandbox closures add no boundary crossings, and steady-state calls still compile no QuickJS source (`boundary-runtime.test.mjs`).
- `.sandbox/test/membrane-ownership.test.mjs` reproduces both failures above and checks, in a child process with `--expose-gc`, that disposal releases wrappers and the Arena while wrapped host values stay alive.
