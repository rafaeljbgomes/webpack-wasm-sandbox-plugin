# Future Work: Fast Unit Regression Suite

**Status:** Partially implemented. Rollout steps 1 (#5: infrastructure, lifecycle and capability exposure), 2 (#6: runtime boundary) and 3 (#7: build-time) are implemented. Steps 4 and 5 (#8, #10) are future work, tracked under #4. The architecture this suite protects is described in [sandbox-plugin-spec-v2.md](sandbox-plugin-spec-v2.md); this document only defines how to test it.

## 1. Problem (state before step 1)

The repository validates the sandbox through three expensive channels:

| Channel | What it protects | Cost and availability |
|---|---|---|
| Compatibility campaigns (`compatibility-harness/`) | Upstream behaviour of ten libraries, native vs sandbox | Requires `npm run build:bundles` and locally obtained upstream suites under `test-harness/`, which are not versioned. Recorded native+sandbox campaigns took about 57 min (date-fns), 33 min (zod, sandbox only), 21 min (tweetnacl), 14 min (yup) and 12 min (luxon). A failure names an upstream assertion, not the boundary rule that broke. |
| Browser security scenarios (`lib-test/security/app/`) | Denied host effects for three libraries | Manual Webpack builds per scenario and mode, separate dependency tree, a browser. |
| Performance branch (`feat/sandbox-benchmarking`) | Crossing cost | Separate branch; not a regression signal. |

The fast suites that exist do not cover the runtime:

| Suite | Tests | Time (local) | Covers |
|---|---|---|---|
| `capability-advisor/test/` (`npm run test:advisor`) | 16 + integration | ~3 s | Advisor only |
| `compatibility-harness/test/parsers.test.mjs` | 10 | ~4 s | Harness planning/parsing; needs upstream suites present |
| `webpack-sandbox-plugin/test/plugin.fail-closed.test.mjs` | 5 | ~17 s | Policy loading and resolution failures |

Observed gaps:

- No test imports anything under `.sandbox/` directly. `sandbox-manager.js`, both membranes, the four marshallers, and `webapi-exposure.js` (about 1,200 lines that carry the security and compatibility properties) are exercised only through compatibility campaigns.
- `Parser` and `ProxyGenerator` have no direct tests.
- There is no root `npm test`, the plugin package's `test` script is a placeholder, and there is no CI workflow.
- `plugin.fail-closed.test.mjs` fails to load under plain `node --test` (Node 24.13: `Cannot use import statement outside a module`, because `webpack-sandbox-plugin` is `"type": "commonjs"`). It passes only with `node --import tsx --test ...`, which is not documented. Its last case compiles the real `date-fns` package (~12 s) and writes `date-fns-proxy.js` into the working tree's `.sandbox/proxys/`, because the plugin derives that directory from `process.cwd()`.
- The rule that every correction must ship a focused regression test (`AGENTS.md`, `CONTRIBUTING.md`) has no fast runtime-level place to put the test. Open issues #1, #2 and #3 each ask for a focused regression test of exactly this kind.

## 2. Goal

A hermetic, fast suite that a contributor runs on every change and CI runs on every push. It should fail with a message that names the broken boundary rule.

Targets:

- whole suite under 60 s on a laptop, no file over 10 s;
- no network, no upstream suites, no `dist/`, no browser, no writes into the working tree;
- real QuickJS and real Arena; the boundary is never mocked;
- zero new dependencies (`node:test`, `node:assert/strict`, existing `tsx`).

Non-goals: replacing compatibility campaigns or browser security validation, or covering performance. Coverage thresholds are deliberately deferred until the suite is complete; step 5 introduces them as a CI gate.

## 3. Feasibility evidence

A throwaway probe built a sandbox directly from an inline fixture bundle, which is the same `var __SANDBOXED_LIB__ = ...` contract that `compileLibrary()` emits, without Webpack. Creating two sandboxes and running every scenario below took about 1 s in total (≈100 ms import, ≈200 ms first context). These results were observed by running it, not inferred from the code:

| Scenario | Observed |
|---|---|
| Call a sandboxed function | Correct result |
| `Uint8Array` in and out | Real host `Uint8Array`, bytes copied |
| Returned `RegExp` | Real host `RegExp`, source and flags preserved |
| Returned `TypeError` with a custom `path` field | `instanceof TypeError`, field preserved |
| Thrown `RangeError` with a custom field | Message and field preserved; **not** `instanceof RangeError` (arrives as `QuickJSUnwrapError` with `name === "RangeError"`) |
| Sandbox `Promise` | Resolves through the job pump |
| Host callback passed in | Invoked, result returned |
| `createInstance()` on a WeakMap-private class | Private state survives repeated method calls |
| `permissions: []` | `fetch`, `process`, `crypto`, `Intl`, `require` all `undefined` inside QuickJS |
| `permissions: ["crypto"]` | Only `crypto` appears |
| `permissions: ["Intl"]` vs `[]` | Formats numbers vs `'Intl' is not defined` |
| `permissions: "crypto"` | Rejected before a context is allocated |
| `Object.prototype` pollution and a global write inside sandbox A | Not visible on the host or in sandbox B; visible in A |
| Returned stateful objects | `__SANDBOX_TEMP__` grows by one per wrapped result and is never pruned (101 entries after 101 calls) |
| `unrefPump()` and then awaiting a sandbox promise with no other handle | Node exits with "unsettled top-level await" (before ADR 27; the promise now settles) |
| `createSandboxSync()` without a prior `await getQuickJS()` | Throws `QuickJS not initialized` |
| Importing `sandbox-manager.js` under plain Node | Fails: `quickjs-emscripten-sync` resolves to a missing `.mjs`; the alias in `test-sandbox-redirect/sandbox-loader.mjs` is required |

Each item in the second half of the table is either a behaviour to pin with a test or a gap to record (section 6).

Implementing step 1 surfaced two more behaviours, both observed by running them:

- An awaited and caught sandbox Promise rejection also emits a host `unhandledRejection`. Without a handler, Node.js then exits with code 1 even though the caller caught the error.
- A second `dispose()` throws `QuickJSUseAfterFree`.

## 4. Design

### 4.1 Layout

Tests follow the existing per-component `test/` convention:

```text
test-sandbox-redirect/
  runtime-aliases.mjs              # alias map shared by sandbox-loader.mjs and the unit-test hook
.sandbox/test/
  helpers/
    register-runtime-aliases.mjs   # registers runtime-alias-hooks.mjs
    runtime-alias-hooks.mjs        # applies only the runtime aliases; no library redirection
    fixture-sandbox.mjs            # fixture bundle builder and auto-disposing sandbox factories
  sandbox-lifecycle.test.mjs
  webapi-exposure.test.mjs
  crypto-capability.test.mjs
  forward-membrane.test.mjs
  reverse-membrane.test.mjs
  marshallers.test.mjs
  isolation.test.mjs
  workloads.test.mjs
  known-gaps.test.mjs
webpack-sandbox-plugin/test/
  plugin.fail-closed.test.mjs      # existing; now uses a temporary fixture package
  policy-loading.test.mjs
  parser.test.mjs
  proxy-generator.test.mjs
  generated-proxy.test.mjs
  import-redirection.test.mjs
```

Plugin tests write their fixture packages and declaration files into `mkdtemp` directories, so there is no checked-in fixture tree.

The alias hook is deliberately separate from `sandbox-loader.mjs`. Unit tests must not redirect configured libraries or depend on the example `.sandbox/sandbox.config.js`. Both hooks import `RUNTIME_PACKAGE_ALIASES` from `test-sandbox-redirect/runtime-aliases.mjs`, so the mapping has one source.

Lifecycle cases that depend on process-wide state run in a fresh child Node.js process: the shared QuickJS module being unloaded, event-loop handles, and `unhandledRejection`. They account for most of the lifecycle file's run time.

### 4.2 Fixture helper

```js
/** Wraps fixture source in the child-bundle global contract. */
export const fixtureBundle = (body) => `var __SANDBOXED_LIB__ = (() => { ${body} })();`;

/**
 * Creates a sandbox that is disposed when the test ends.
 * Permissions default to an explicit empty list so tests never read the example policy.
 */
export async function createFixtureSandbox(t, body, { permissions = [], workloads } = {}) {
  const sandbox = await SandboxManager.createSandbox("fixture", fixtureBundle(body), { permissions, workloads });
  t.after(() => sandbox.dispose());
  return sandbox;
}
```

Rules:

- Always pass `permissions`. Only one test covers the documented fallback to `sandboxConfig[libraryName]` when permissions are omitted.
- Do not call `unrefPump()` except in the test that pins its behaviour. Disposal clears the pump. If a pump leaks, the test process hangs, so the runner uses `--test-timeout` to turn a lifecycle leak into a failure.
- Fixture bodies stay a few lines long and are written inline. Each test should read as one boundary rule.

### 4.3 Generated proxies without source changes

The generated proxy imports `../core/sandbox-manager.js` and reads `<proxyDir>/../../dist/<lib>.bundle.js`. `generated-proxy.test.mjs` builds that layout in a `mkdtemp` directory:

```text
<tmp>/package.json                       # {"type":"module"}, as at the repository root
<tmp>/.sandbox/core/sandbox-manager.js   # export * from "<repo>/.sandbox/core/sandbox-manager.js"
<tmp>/.sandbox/proxys/fixture-proxy.js   # ProxyGenerator.generate(...) output
<tmp>/dist/fixture.bundle.js             # fixtureBundle(...)
```

The test then imports the proxy and runs its named, class, default-singleton and `export =` paths, a workload, and `disposeLibrary()` against the real runtime. For the ADR 10 case, the shim wraps the real `SandboxManager` and records when creation resolves and when `unrefPump()` is called. This needs no change to `ProxyGenerator`.

`import-redirection.test.mjs` compiles a temporary project once and shares the result between its cases. The compiled project has the same layout, so the plugin's own proxies and child bundles also run end to end.

Both the parser tests and that compilation run with the fixture directory as the working directory. TypeScript otherwise loads every `@types` package visible from the repository root, which costs over a second for each parsed library.

### 4.4 Plugin seam

`WebpackSandboxPlugin` writes proxies to `path.resolve(process.cwd(), ".sandbox/proxys")`. Add an optional `proxyDirectory` option that defaults to that path, so `import-redirection.test.mjs` and `plugin.fail-closed.test.mjs` write only into their temporary directory. Swapping `date-fns` for a temporary fixture package removes the 12 s case and the dependency on a devDependency's layout. This is the only production-code change the suite needs. It is backward compatible.

### 4.5 Scripts and CI

```json
"test:unit": "node --import ./.sandbox/test/helpers/register-runtime-aliases.mjs --import tsx --test --test-timeout=30000 \".sandbox/test/*.test.mjs\" \"webpack-sandbox-plugin/test/*.test.mjs\"",
"test": "npm run test:unit && npm run test:advisor"
```

`compatibility-harness/test/parsers.test.mjs` stays outside `npm test` because it needs upstream suites. After step 1, `npm test` ran 62 tests locally (Windows, Node 24.13): 60 passed and 2 were reported as `todo`, in about 40 s wall-clock including the advisor suite. The runtime files take about 15 s, dominated by child-process cases. The plugin file takes about 13 s, dominated by Webpack start-up and one child compilation. With Node's built-in coverage, the step 1 suite executes 79% of lines and 76% of branches in `.sandbox/core`, `.sandbox/membrane`, `.sandbox/marshallers` and `webpack-sandbox-plugin/src`. After step 2, `npm test` runs 132 tests (123 pass, 9 `todo`) in about 30 s. Coverage rises to 85% of lines and 85% of branches, with every runtime file at 90–100% of lines; the remaining gap is the plugin, which step 3 addresses. After step 3, `npm test` runs 182 tests (170 pass, 12 `todo`) in about 40 s; the unit suite accounts for 159 of them (147 pass, 12 `todo`). Coverage rises to 97% of lines and 89% of branches. `plugin.ts` goes from 56% to 94% of lines, `proxy-generator.ts` from 54% to 99.6%, and `parser.ts` from 88% to 99%. The slowest new file is `import-redirection.test.mjs` at about 6 s, almost all of it one Webpack compilation; `parser.test.mjs` takes about 5 s. With ADR 27, `npm test` runs 197 tests (186 pass, 11 `todo`); the unit suite accounts for 174 of them (163 pass, 11 `todo`). Step 4 reports coverage and step 5 enforces it.

A `.github/workflows/unit.yml` runs `npm ci` and `npm test` on push and pull request, using Node 24 on `ubuntu-latest` and `windows-latest`, since contributors and the proxy path logic both run on Windows. Compatibility campaigns and browser scenarios stay manual.

### 4.6 Validation tiers

| Change touches | Required before PR |
|---|---|
| Anything | `npm test` (tier 0) |
| `.sandbox/membrane/`, `.sandbox/marshallers/`, `sandbox-manager.js` | tier 0 + `run-compat --library <affected>` for at least one library that exercises the path (tier 1) |
| `webapi-exposure.js`, permissions, policy loading | tier 0 + matching browser security scenario |
| Release or dissertation evidence | full campaigns + all security scenarios (tier 2) |

## 5. Coverage matrix

Most cases come from failures that compatibility campaigns already found and that the architectural decisions record. Each test turns one of those findings into a check that runs in seconds.

| Test file | Case | Source |
|---|---|---|
| sandbox-lifecycle | async and sync creation (sync after `getQuickJS()`) produce working exports | Spec §5 |
| sandbox-lifecycle | `dispose()` clears the pump, disposes helpers/Arena/context; repeated `dispose()` behaviour is pinned once decided | Spec §5 |
| sandbox-lifecycle | Promise result resolves through the referenced pump | ADR 5, 10 |
| sandbox-lifecycle | after `unrefPump()`, an awaited sandbox Promise settles without another live handle (child process) | ADR 10, 27 |
| boundary-runtime | steady-state crossings compile no QuickJS source; guest-replaced intrinsics do not reach bridge helpers | ADR 27 |
| boundary-runtime | bulk unmarshalling keeps special numbers, long strings, descriptors, symbols, cycles and identity | ADR 27 |
| boundary-runtime | plain Web API results arrive as real QuickJS data; only lossless JSON graphs qualify | ADR 27 |
| boundary-runtime | promise reactions drain before host timers; accessor reads keep identity and live host state | ADR 27 |
| boundary-runtime | disposal succeeds after async, accessor, custom-marshalled and memory-limit crossings | ADR 27 |
| boundary-runtime | sandbox errors do not reach the QuickJS context; forged typed-array names never select host globals | ADR 27 |
| webapi-exposure | `[]` exposes no ambient globals (`fetch`, `process`, `require`, `crypto`, `Intl`, `document`) | Spec §6, §9 |
| webapi-exposure | explicit list never falls back to the policy module; omission does | Spec §6 |
| webapi-exposure | invalid lists (`"x"`, `[""]`, `[1]`, `null`) rejected before context allocation | Spec §6 |
| webapi-exposure | absent host global is skipped silently | Spec §6 |
| crypto-capability | facade is null-prototype; host `crypto.subtle` is unreachable | ADR 23 |
| crypto-capability | integer typed arrays only; `Float32Array`/`DataView` rejected; >65,536 bytes → `QuotaExceededError` | ADR 23 |
| crypto-capability | `__sandboxCrypto*` helpers deleted after install | ADR 23 |
| forward-membrane | `Intl.NumberFormat` and `TextEncoder` work through `makeCallable`/`bindWebApi` | ADR 3, 4 |
| forward-membrane | constructor-only messages from V8 and browser engines trigger `Reflect.construct`; other `TypeError`s propagate | ADR 24 |
| forward-membrane | cyclic host object and repeated reference reuse one wrapper | Spec §6 |
| reverse-membrane | method receivers preserved; `createInstance` keeps WeakMap privates | ADR 13 |
| reverse-membrane | prototype getters read live from QuickJS | ADR 14 |
| reverse-membrane | `Date`, arrays, plain objects, `Map`/`Set` are not pinned | ADR 20, spec §7 |
| reverse-membrane | non-configurable non-writable properties returned exactly (Proxy invariant) | `wrapReturned` |
| reverse-membrane | host override on a returned object wins over the QuickJS method | Spec §7 |
| reverse-membrane | callable exports also expose static properties | ADR 17 |
| reverse-membrane | `new.target` preserved for sandbox subclasses (patched `ue()`) | ADR 16 |
| marshallers | each typed-array kind round-trips with offset/length views | ADR 2 |
| marshallers | RegExp source and flags in both directions | Spec §8 |
| marshallers | `arguments` round-trips with Arguments identity | Spec §8 |
| marshallers | returned Error subclasses, `AggregateError`, bounded custom fields, cycles | ADR 22 |
| marshallers | removing a marshaller from `index.js` makes its case fail (registration guard) | AGENTS rule |
| isolation | prototype pollution and global writes stay inside one context | Spec §9 |
| isolation | two sandboxes do not share globals or temp stores | ADR 1 |
| workloads | workload loaded once, shares library context and `__SANDBOXED_LIB__` | ADR 21 |
| parser | named, default, duplicate, reserved-word, `export =` declaration fixtures | ADR 7, 12 |
| proxy-generator | permissions serialised exactly, including `[]` | ADR 25 |
| generated-proxy | named, class, default-singleton, `export =`, workload and `disposeLibrary()` paths execute; `apply` traps; `unrefPump()` after initialization | Spec §4, ADR 10, 12, 17 |
| policy-loading | omission → `[]`; `null`, non-array and empty-string entries rejected | `build-helpers.ts` |
| import-redirection | configured root and workload requests redirected; unconfigured untouched; child bundles emitted and evaluated; Node entry chosen over a `browser` entry; `@types` fallback and stub proxy | Spec §3, ADR 6, 11 |

### 5.1 Previously corrected defects

Most decisions in [architectural-decisions.md](architectural-decisions.md) record a defect found through compatibility campaigns and the correction applied. The table below shows which of those corrections the unit suite guards today and which step will add the guard. "Partial" means the corrected path runs during a test but no assertion targets the original failure.

| ADR | Corrected behaviour | Current coverage | Remaining guard |
|---|---|---|---|
| 1 | One QuickJS context per library | Covered: separate contexts, globals, prototypes and workload state (steps 1–2) | — |
| 2 | Typed arrays copied, not proxied | Covered: every kind in both directions, offset views, copy semantics (step 2) | — |
| 3 | `bindWebApi` keeps native receivers | Covered: private-field host objects, `Intl`, cycles, write-through (step 2); nested-reference identity (ADR 27) | — |
| 4 | Constructor detection in `makeCallable` | Covered: constructor fallback, unrelated `TypeError` propagation (step 2) | — |
| 5 | Job pump drives QuickJS Promises | Covered: resolution, chained awaits, rejection delivery, pump cleared on disposal (step 1) | — |
| 6 | Child-compiler library bundles | Covered: emitted library and workload bundles evaluate through `__SANDBOXED_LIB__` and the generated proxies (step 3) | — |
| 7 | Declaration-driven proxy generation | Covered: parser fixtures, generator output, `@types` fallback and stub proxy (step 3) | Type-only exports are reported as runtime names (`todo`) |
| 8 | Loader interception for compatibility suites | Shared alias only | Remains covered by compatibility campaigns |
| 9 | `bindSandboxExport` reverse membrane | Covered: receivers, wrapper caching, nested objects, static properties (step 2) | — |
| 10 | Pump referenced until initialization completes | Covered: pump referenced during creation (step 1); generated proxy calls `unrefPump()` once, after creation resolves (step 3); awaited Promises settle after `unrefPump()` (ADR 27) | — |
| 11 | Node entry points for child bundles | Covered: a package-level `browser` entry is not bundled (step 3) | `browser` maps for internal modules still select the browser file (`todo`) |
| 12 | Default export that is a singleton | Covered: singleton methods and `new` on the generated default (step 3) | — |
| 13 | `createInstance` keeps WeakMap private state | Covered: WeakMap privates and native `#private` fields (step 2) | — |
| 14 | Live primitive reads from returned objects | Covered: prototype getters re-read after mutation (step 2) | — |
| 16 | Patched `ue()` preserves `new.target` | Covered: host `new` on an exported subclass (step 2) | — |
| 17 | `apply` trap on exported functions | Covered: reverse membrane (step 2); generated named, default and `export =` proxies, including `call` and `Reflect.apply` (step 3) | Constructing an `export =` class throws (`todo`) |
| 19 | Precompiled temporary-object helpers | Covered indirectly by returned-instance tests (step 2) | Unbounded `__SANDBOX_TEMP__` growth is a `todo` |
| 20 | `Date` results are not wrapped | Covered (step 2) | — |
| 21 | Workload adapters share the library context | Covered: shared context, single evaluation, preloading, per-sandbox state (step 2) | — |
| 22 | Structured error marshalling | Covered: built-in subclasses, `AggregateError`, listed fields, bounds, thrown-error fields (step 2) | Thrown-error subclass identity and `cause` are `todo`s |
| 23 | Constrained crypto facade | Covered: null prototype, accepted and rejected views, byte range, quota, UUID (steps 1–2) | — |
| 24 | Browser constructor-only messages | Covered at matcher level (step 2) | Browser execution remains with the security scenarios |
| 25 | Explicit runtime policy, no silent fallback | Covered: explicit list vs fallback, sync and async validation, fail-closed plugin policy loading (step 1) | — |
| 27 | Boundary fast path and handle ownership | Covered: `boundary-runtime.test.mjs`, one case per change and correction | — |

ADRs 15 (bridge assessment), 18 (crossing cost) and 26 (advisor model) do not record boundary defects. The advisor has its own suite.

## 6. Known gaps as tests

Behaviour that the specification lists as a limitation, or that the probe showed differs from what was intended, is recorded with `test(name, { todo: "<issue or reason>" }, fn)`. The case runs and is reported, but it does not fail the suite. A fix removes the `todo` and the case becomes a guard. Gaps that belong to one area live in that area's test file. Cross-cutting gaps go into `known-gaps.test.mjs` in step 4.

| Gap | Recorded in |
|---|---|
| Awaited sandbox rejections also emit a host `unhandledRejection` | `sandbox-lifecycle.test.mjs` |
| Repeated `dispose()` throws `QuickJSUseAfterFree` | `sandbox-lifecycle.test.mjs` |
| `__SANDBOX_TEMP__` is never pruned | `reverse-membrane.test.mjs` |
| Thrown sandbox errors are not instances of the host subclass | `marshallers.test.mjs` |
| `Error.cause` is not copied | `marshallers.test.mjs` |
| Native QuickJS `arguments` objects return as plain objects | `marshallers.test.mjs` |
| Returned `Map` and `Set` objects fail on method calls (spec §8) | `marshallers.test.mjs` |
| `DataView` loses its identity in both directions (spec §8) | `marshallers.test.mjs` |
| Interfaces and type aliases are reported as runtime exports | `parser.test.mjs` |
| The `export =` construct trap calls the value without `new`, so a class cannot be constructed | `generated-proxy.test.mjs` |
| `browser` maps for internal modules select the browser file in child bundles (ADR 11) | `import-redirection.test.mjs` |
| Two sandboxes receiving one mutable host object share a forward wrapper (#3) | `known-gaps.test.mjs` (step 4) |
| Configured-package subpath imports are not redirected (#2) | `known-gaps.test.mjs` (step 4) |
| Authority-bearing host arguments produce no diagnostics (#1) | `known-gaps.test.mjs` (step 4) |
| No CPU, memory or interrupt limits (spec §9) | `known-gaps.test.mjs` (step 4) |

## 7. Rollout

Each step is one reviewable PR. Steps 2 and 3 can run in parallel after step 1. Step 5 follows steps 2–4.

1. **Infrastructure (#5, implemented):** alias module and hook, fixture helper, `test:unit`/`test` scripts, `--import tsx` fix and `proxyDirectory` seam for the existing plugin test, CI workflow, plus lifecycle and exposure tests.
2. **Runtime boundary (#6, implemented):** forward/reverse membrane, marshaller, crypto, isolation and workload tests.
3. **Build-time (#7, implemented):** parser, proxy-generator, generated-proxy, policy-loading and import-redirection tests.
4. **Gaps, coverage and documentation (#8):** `known-gaps.test.mjs`; a report-only `npm run test:coverage` with the coverage table in the CI job summary and an lcov artifact, but no thresholds, because line coverage overstates what is asserted and section 5.1 remains the primary measure. Then updates to `README.md`, `CONTRIBUTING.md`, `AGENTS.md`, the documentation index, `compat-testing-plan.md` (tier table), and an architectural decision entry for the validation tiers.
5. **Coverage gate (#10):** `npm run test:coverage` applies Node's built-in `--test-coverage-lines`, `--test-coverage-branches` and `--test-coverage-functions` floors to the runtime and plugin sources, and CI fails below them. The details:
   - Each floor sits a point or two below the coverage measured after steps 2–4. It is raised as coverage improves, and lowering it needs a stated reason in the PR.
   - The script pins every flag that affects the result. The step 1 suite measures 79.3% of lines with `--enable-source-maps` and 82.0% without.
   - CI writes the per-file table to the job summary. Reviewers use it, together with the template's regression-scenario item, to confirm that changed code has tests, because a project-wide floor can hide a drop in one file.
   - The gate runs on Ubuntu, and exclusions use `node:coverage ignore` comments with a stated reason.
   - There is no per-file or changed-line script; at this code size, review covers that at lower cost.
   - The suite stays on `node:test`. If per-file floors are needed later, `c8` can add them without changing framework.
   - The gate complements section 5.1, because executed lines are not asserted behaviour.

## 8. Risks

- **Characterisation that freezes defects.** Pin current behaviour only where the specification documents it. Everything else goes in section 6 as `todo`.
- **WASM start-up per file.** About 200 ms per context and file processes running in parallel keep this within budget. Contexts are not shared between tests, because sharing them would break isolation assumptions.
- **Hung processes from leaked pumps.** `t.after(dispose)` plus `--test-timeout`.
- **Divergence from the real bundle contract.** `import-redirection.test.mjs` compiles `fixture-lib` with the real child compiler and evaluates its output with the same helper, so the inline fixture format stays tied to what Webpack emits.
