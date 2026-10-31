# Webpack Sandbox Plugin: Current Technical Specification

**Status:** Canonical description of the implementation on `main`.

This document describes what the prototype implements. Historical rationale is recorded in [architectural-decisions.md](architectural-decisions.md), and the versioned architecture diagrams are indexed in [../README.md](../README.md).

## 1. Scope and security objective

The plugin isolates configured browser-side npm libraries inside QuickJS contexts compiled to WebAssembly. Its objective is to prevent a library from automatically inheriting the host page's global authority while retaining enough API compatibility for evaluated applications.

The prototype protects the host realm through two controls:

1. **Execution isolation:** library code and its globals execute in a per-library QuickJS context rather than the host JavaScript realm.
2. **Capability selection:** the runtime exposes only host globals listed for that library in `.sandbox/sandbox.config.js`.

This boundary does not make every object safe. A host object passed as a function argument is itself a capability and may expose further reachable authority. The current compatibility-first treatment of such arguments is documented in [host-argument-capability-limitation.md](host-argument-capability-limitation.md).

## 2. Public configuration

### 2.1 Plugin option

The Webpack-facing API is:

```ts
export interface SandboxPluginOptions {
  configPath: string;
  proxyDirectory?: string;
}
```

Use it in a Webpack configuration:

```js
new WebpackSandboxPlugin({
  configPath: "./.sandbox/sandbox.config.js",
});
```

`configPath` is resolved from `compiler.context`. The configuration module may expose its object directly or as a default export. The build fails if the policy file is missing or cannot be loaded, if it does not export a library-keyed object, or if a configured package cannot be resolved from the compiler context.

`proxyDirectory` is optional and selects where generated proxy modules are written. It is resolved from the process working directory and defaults to `.sandbox/proxys`. Generated proxies import `../core/sandbox-manager.js` and read `../../dist/<library>.bundle.js` relative to themselves, so only the default location works with the repository runtime. Tests use a temporary directory so compilation leaves the working tree unchanged.

### 2.2 Library policy

The configuration object is keyed by package request:

```js
export default {
  "example-library": {
    permissions: ["Intl"],
    workloads: {
      example: {
        entry: "performance-harness/browser/workloads/example/workload.js",
        exports: ["runExample"],
      },
    },
  },
};
```

| Field | Required | Meaning |
|---|---|---|
| `<library>.permissions` | Optional | Host global names made available to this library. Omission normalizes to `[]`; malformed values fail validation. |
| `<library>.workloads` | No | Coarse-grained adapters that execute inside the same sandbox as the library. |
| `workloads.<name>.entry` | Yes for a workload | Repository-relative JavaScript entry bundled by a child compiler. |
| `workloads.<name>.exports` | Yes for a workload | Functions exposed by the generated workload proxy. |

The plugin treats every top-level key as a library to bundle and redirect. The shared policy loader validates file presence, module and per-library object shapes, permission lists, and package resolution before compilation. Other library options retain their existing contract.

### Optional capability preparation

`npm run sandbox:suggest` is a separate Node command. Its analysis plugin shares policy loading and isolated library child compilation with the runtime plugin, retains selected Webpack resolution/loader settings, and excludes the host entry and runtime proxy generation. It gathers transformed installed/transitive module evidence without evaluating emitted dependency code, asks pinned SubQ Snap (`subq-snap-1.1`) typed System One questions, and writes an editable draft and reports under an ignored result directory. Local host modules and workloads are excluded from remote evidence; incomplete, sensitive and unvalidated capability results require review. The developer edits and transfers reviewed permissions to the active policy before a normal build. See the [advisor operational guide](../../capability-advisor/README.md) for the maintained catalogue, budgets, API/cache contracts and validation limits. Preparation adds no runtime model dependency.

## 3. Build-time architecture

### 3.1 Configuration and proxy generation

`WebpackSandboxPlugin.apply()` performs these steps during Webpack setup:

1. Resolve and load the configuration.
2. Collect configured libraries and workload definitions.
3. Search `node_modules/<library>` recursively for `.d.ts` files. If none exist, search `node_modules/@types/<library>`.
4. Parse declaration roots with the TypeScript compiler API.
5. Generate `.sandbox/proxys/<library>-proxy.js` and optional workload proxies.
6. Install `NormalModuleReplacementPlugin` rules for exact library requests and `sandbox-workload/<library>/<workload>` requests.

The library rule is intentionally exact in the current implementation. A configured root request does not redirect package subpaths; the resulting coverage limitation and future direction are documented in [isolation-coverage-and-cache-limitations.md](isolation-coverage-and-cache-limitations.md).

The declaration parser records named exports and detects TypeScript `export = identifier` patterns used by callable singleton packages such as Lodash. It does not map TypeScript types into runtime validation rules. If no declarations are available, the plugin writes a minimal proxy whose default function throws `Sandbox Proxy Generation Failed`.

### 3.2 Isolated library bundles

During the compiler's asynchronous `make` hook, the plugin creates a Webpack child compiler for each configured library. Each child compiler:

- resolves the package entry from the parent compiler context;
- uses `EntryPlugin` for that entry;
- enables Webpack's `var` library output;
- writes `dist/<library>.bundle.js`;
- assigns the package export to the QuickJS-side global `__SANDBOXED_LIB__`.

The entry is resolved with Node.js resolution, so a package-level `browser` entry is not bundled. Modules inside the package are resolved by the inherited Webpack resolver, so for a web target a `browser` map of internal files still selects the browser file. This known limitation is recorded as a `todo` case in the unit suite.

Webpack documents a child compiler as a second compiler with its own settings created within the parent compilation. In this prototype, child compilation separates the library asset from the host application bundle; runtime execution in QuickJS creates the actual isolation boundary.

### 3.3 Workload bundles

Each configured workload is compiled to:

```text
dist/<library>.<workload>.workload.bundle.js
```

`ExternalsPlugin` maps `sandbox-real/<library>` to `__SANDBOXED_LIB__`, allowing adapter code to call the already-loaded library without bundling a second copy. A missing workload entry produces a warning and skips that workload bundle; it does not fail normal library compilation.

The generated workload proxy is imported as:

```js
import { runExample } from "sandbox-workload/example-library/example";
```

Workload proxies share their library sandbox. `disposeWorkload()` is intentionally a no-op; callers dispose the owning library through `disposeLibrary()`.

## 4. Generated library proxies

Generated proxies use top-level await and run in both Node.js and browsers.

1. In Node.js, read `dist/<library>.bundle.js` from disk.
2. In a browser, fetch `/dist/<library>.bundle.js`.
3. Call `SandboxManager.createSandbox(libraryName, libraryCode, options)`.
4. In Node.js, call `unrefPump()` after initialization so the job-pump timer alone does not keep the process alive.
5. Export wrappers derived from the declarations.

Named functions route calls through a precompiled QuickJS call expression. Classes use `librarySandbox.createInstance()` so construction and instance identity remain inside QuickJS before the returned proxy is created. Callable singleton exports receive `apply`, `get`, and `construct` traps. The `construct` trap calls the value without `new`, so an `export =` class cannot currently be constructed through its proxy. Other named values are read from `librarySandbox.exports`.

The parser also reports interfaces and type aliases as export names. Their generated bindings are `undefined`, and a type name can be chosen as the default-export constructor fallback. Both limitations are recorded as `todo` cases in the unit suite.

Every generated library proxy exposes `disposeLibrary()`. Applications that create and discard sandboxes dynamically must call it; otherwise the QuickJS context, Arena, helper functions, and job-pump interval remain allocated.

## 5. Runtime lifecycle

`SandboxManager` supports synchronous and asynchronous context acquisition:

- `createSandboxSync()` uses `getQuickJSSync()`;
- `createSandbox()` uses `newQuickJSWASMModule()`, which instantiates a dedicated WebAssembly module with its own linear memory for each call.

`createSandbox()` uses the synchronous (non-asyncify) QuickJS build. The runtime never suspends QuickJS on a host promise, and asyncify instrumentation adds a generator round trip to every boundary call. The synchronous build also aborts in `JS_FreeRuntime` when a QuickJS object leaks, which turns handle-ownership mistakes into deterministic disposal failures instead of silent leaks.

Both paths delegate to `buildSandbox()` and create a new QuickJS context for the library. QuickJS contexts have isolated global objects. The module API used here creates a corresponding runtime whose lifecycle is tied to the context.

`buildSandbox()`:

1. memoizes `vm.typeof()` per handle, because a handle's QuickJS type cannot change;
2. removes the QuickJS context reference from errors raised by `vm.unwrapResult()`, so error serializers cannot reach the WebAssembly heap;
3. installs the job pump's observers on the context entry points `callFunction`, `evalCode`, `getProp`, and `setProp`;
4. creates this sandbox's by-value transfer offers and forward membrane (§6.2);
5. creates the registered Arena marshaller configuration, connected to the same transfer offers;
6. creates an Arena for the QuickJS context;
7. exposes configured host capabilities through the sandbox's forward membrane;
8. evaluates the library bundle and reads `__SANDBOXED_LIB__`;
9. precompiles helpers for temporary-object storage, method calls, property reads, and construction;
10. creates this sandbox's reverse membrane over the Arena and helpers;
11. evaluates and binds a workload bundle when its generated workload proxy first requests it;
12. wraps the library exports through the reverse membrane;
13. starts the job pump's 10 ms fallback interval.

The job pump exists because Promise reactions queued inside QuickJS do not run automatically from the host event loop. After any observed context entry, the pump schedules one host microtask that calls `arena.executePendingJobs()` when `vm.runtime.hasPendingJob()` is true, so sandboxed `async` code settles before host timers run and an awaited sandbox Promise needs no live timer handle. The fallback interval covers uninstrumented entry points. It remains referenced during top-level-await initialization and is unreferenced afterwards only in Node-generated proxies.

Disposal stops the job pump, releases the reverse and forward membrane state, disposes all registered marshallers and precompiled helpers, then disposes the Arena and QuickJS context. Releasing the membranes first means a host wrapper that outlives the sandbox fails with `The sandbox has been disposed` instead of reaching the released context, and the sandbox no longer retains wrappers for host values that outlive it. Any new handle or helper introduced by a runtime change must participate in this lifecycle.

### 5.1 Patched Arena boundary

`quickjs-emscripten-sync@1.8.1` is patched through `patches/quickjs-emscripten-sync+1.8.1.patch`. Besides the `new.target` correction ([AD#16](architectural-decisions.md)), the patch changes how Arena crosses the boundary without changing its identity model:

- QuickJS helper source is compiled once per Arena, before guest code runs, instead of per call. Helpers capture the original intrinsics, so guest replacement of `JSON`, `Object`, or `Reflect` members does not reach them.
- QuickJS-to-host conversion reads an object's prototype and every own property descriptor in one crossing. Primitives travel inline as JSON, values already in the Arena maps travel as map ids, and only unseen values return as handles.
- One crossing checks both Arena maps for an existing identity.
- Unmarshalled handles are disposed unless an Arena map owns them, and a host function that returns a map-owned handle returns a duplicate. Upstream code disposed only already-known values, and quickjs-emscripten disposes the handle a host function returns; together these leaked QuickJS objects and broke identity on repeated reads through host accessors.

A handle leak in this layer aborts disposal under the synchronous build, so `.sandbox/test/boundary-runtime.test.mjs` disposes sandboxes and bare Arenas after async, accessor, custom-marshalled, and memory-limit crossings ([AD#27](architectural-decisions.md)).

## 6. Capability exposure and forward membrane

Generated proxies serialize the compiler-selected permissions into `SandboxManager.createSandbox(libraryName, libraryCode, { permissions })`. Both synchronous and asynchronous runtime paths forward an explicit list to `exposeWebAPIs()`. An explicit empty list never falls back to another policy. Direct runtime callers omitting `options.permissions` retain the default policy-module fallback. Ordinary globals are obtained from `globalThis`, wrapped, synchronized through Arena, and exposed under the same name; absent host globals are skipped.

The forward membrane in `forward-membrane.js` protects host receiver semantics:

- `bindWebApi()` walks own properties and the prototype chain up to `Object.prototype`;
- functions are rebound to their real owner through `makeCallable()`;
- nested values are wrapped lazily through accessors;
- a `WeakMap` owned by the sandbox preserves repeated references and handles cycles;
- constructor-only host functions first receive `Reflect.apply`; recognized constructor errors trigger `Reflect.construct`;
- a fresh call result that is plain JSON data (arrays, plain or null-prototype objects, strings, booleans, finite numbers other than `-0`, and `null`, without accessors, holes, shared references, or more than 10,000 nodes) is copied into QuickJS by value instead of being wrapped. `formatToParts()` and `resolvedOptions()` results are typical examples.

This handling is required for APIs with native internal slots, including `Intl` objects and browser constructors such as `TextEncoder`. The by-value copy applies only to values the same sandbox's `makeCallable()` offered for transfer (`.sandbox/core/json-transfer.js`) and is re-checked when that sandbox's Arena consumes the offer, so host objects reached any other way keep the wrapped, identity-tracked path.

### 6.1 Constrained crypto capability

The `crypto` permission is special. The runtime does not expose the complete host `Crypto` object. It installs a null-prototype QuickJS facade containing:

- `getRandomValues()` for integer typed arrays, enforcing the 65,536-byte limit;
- `randomUUID()` when the host implements it.

Random bytes and UUIDs are produced by host functions synchronized into Arena and hidden after the QuickJS facade is installed.

### 6.2 Membrane ownership

All mutable membrane state belongs to one sandbox. `buildSandbox()` creates it with `createForwardMembrane()`, `createReverseMembrane()`, and `createJsonTransfer()`; the membrane modules keep no module-scoped caches, offers, or counters. This state comprises:

- the forward wrapper cache;
- the reverse export and returned-object wrapper caches;
- the by-value transfer offers;
- the `__SANDBOX_TEMP__` identifier counter.

A forward wrapper is a mutable host object that its Arena synchronizes with QuickJS: guest code can add properties to it or replace its methods. Two sandboxes granted the same host object therefore each receive their own wrapper, so a method one library replaces is never called by another, and arguments passed by one library never reach a function defined by another. A reverse wrapper routes every call through its own sandbox's Arena and helpers, even when two sandboxes wrap the same host value. Identity is preserved within a sandbox, not across sandboxes. `__SANDBOX_TEMP__` identifiers are visible to guest code and start at zero in each sandbox, so they reveal nothing about other sandboxes.

Separate wrappers do not copy host state. A host object granted to several libraries remains one object: an assignment to one of its existing data properties goes through to the host and is visible to every grantee, including a function value written by one library and later called by another. Granting one mutable host object to several untrusted libraries is therefore still a shared channel ([limitations](isolation-coverage-and-cache-limitations.md)).

## 7. Reverse membrane

The reverse membrane makes QuickJS exports usable by the host without treating an Arena dump as the authoritative object.

- `bindSandboxExport()` wraps exported objects and functions, caches wrappers per sandbox, and routes method access back to QuickJS-side closures.
- `bindSandboxFunction()` implements direct calls, construction delegation, and static-property access.
- `wrapReturned()` pins stateful QuickJS objects in `globalThis.__SANDBOX_TEMP__` and routes later methods and getters to the original object.
- `createInstance()` constructs in QuickJS before crossing the boundary, preserving WeakMap/private-field identity.
- host-side method overrides are retained for test mocking and marshalled back on later calls.
- after disposal, every wrapper and boundary helper of the sandbox throws `The sandbox has been disposed` (§5).

Values that already have supported value semantics—arrays, typed arrays, `ArrayBuffer`, `Date`, `RegExp`, `Error`, `Map`, `Set`, `arguments`, primitives, and plain objects—are not all pinned through `wrapReturned`. Their fidelity depends on Arena and the registered marshallers.

## 8. Registered marshallers

`.sandbox/marshallers/index.js` registers four marshallers in order:

| Marshaller | Purpose |
|---|---|
| `typed-array.js` | Copies typed-array view bytes and preserves the concrete typed-array constructor. The QuickJS-reported constructor name selects only from a fixed list of host typed-array constructors. Raw `ArrayBuffer` is not claimed by this custom marshaller. |
| `regexp.js` | Preserves pattern source and flags. |
| `arguments.js` | Tags and recreates arguments-like values. |
| `error.js` | Recreates supported host/QuickJS error constructors for returned and argument errors. It copies `name`, `message`, `stack` and bounded JSON-safe values of `errors`, `inner`, `path`, `type`, `value`, `params` and `issues`. `cause` and other custom fields are not copied. Thrown QuickJS errors reach the host as Arena unwrap errors that carry these fields but are not instances of the host subclass; the runtime removes their QuickJS `context` reference (§5). |

Each marshaller implements `handleTest`, `isWrappable`, `isHandleWrappable`, `marshal`, `unmarshal`, `unmarshalClaimed`, and `dispose`. `handleTest` is a QuickJS expression over `h`. `index.js` compiles the registered tests, in registration order, into one QuickJS classifier and memoizes its answer per handle. Arena's `isHandleWrappable` and custom unmarshallers then consult that single answer, and only the claiming marshaller's `unmarshalClaimed()` runs. `isHandleWrappable` and `unmarshal` remain self-contained for direct use. A marshaller file that is not imported and registered in `index.js` is inactive.

The repository contains no active generic collection marshaller. `Map`, `Set`, `DataView`, boxed primitives, and other internal-slot types therefore remain known compatibility boundaries rather than documented supported conversions.

## 9. Security properties

The implemented boundary provides:

- separate QuickJS globals and heaps for each configured library;
- no ambient host globals unless configuration exposes them or host arguments convey them;
- membrane-mediated access to explicitly exposed host objects, with membrane wrappers, caches, and transfer offers owned by each sandbox (§6.2);
- isolation of QuickJS prototype/global mutations from the host realm;
- deterministic host import replacement for evaluated package requests.

It does not provide:

- process, browser, CPU, memory, or execution-time quotas;
- validation of arbitrary package safety or integrity;
- revocation of capabilities supplied through arguments;
- complete JavaScript cross-realm observational equivalence;
- a guarantee that every possible host global is safe when named in `permissions`;
- isolation of host state shared by granting the same mutable host object to several libraries, including values written into its existing data properties (§6.2);
- production packaging, versioned public APIs, or long-term compatibility guarantees.

## 10. Compatibility limitations

Cross-runtime membranes cannot transparently preserve every observable property:

- strict object identity and aliasing may differ after copying or wrapping;
- host and QuickJS prototype chains are different, affecting `instanceof` and prototype equality;
- symbols with equal descriptions do not have equal identity across runtimes;
- functions expose wrapper source rather than the original `toString()` result;
- native internal-slot methods may reject a proxy receiver;
- copied objects do not preserve every non-enumerable descriptor, accessor, or mutation;
- `null`/`undefined`, errors, and unusual test-runner values depend on the bridge path;
- deeply nested or retained object graphs can increase memory pressure.

These are evaluated per library through the automated compatibility harness. They must be reported as limitations, not silently reclassified as successful compatibility.

## 11. Extension points

To add a library, update the sandbox configuration, ensure declarations exist, build the bundles/proxy, add deterministic test redirection, register the library in the compatibility manifest, and run native and sandbox campaigns.

To add a host capability, test both allowed behaviour and denied reachability.

To add a marshaller, implement the complete marshaller lifecycle, register it in `index.js`, and test values in both directions, including disposal and error paths.

To change the boundary or proxy semantics, update this specification and [architectural-decisions.md](architectural-decisions.md) in the same change.

Current import-coverage, cache-scope, and dynamic helper-generation limitations are recorded in [isolation-coverage-and-cache-limitations.md](isolation-coverage-and-cache-limitations.md). Future work must preserve the evaluated compatibility contract while strengthening those boundaries.
