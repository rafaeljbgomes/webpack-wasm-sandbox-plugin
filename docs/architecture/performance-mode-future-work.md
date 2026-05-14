# Advanced Feature: Explicit Performance Mode for Coarse-Grained Sandbox Execution

## Context

The current sandbox design prioritizes transparent adoption: a developer configures a third-party library for sandboxing, and existing imports are redirected to generated proxies without requiring application code changes. This is an important usability property of the prototype and should remain the default behavior.

The performance evaluation shows a predictable limitation of this transparent mode. Libraries with chatty APIs, such as Zod builders or Lodash chains with callbacks, can trigger many host-to-sandbox and sandbox-to-host boundary crossings. Each crossing pays for argument marshalling, QuickJS/Wasm invocation, result marshalling, and reverse-membrane wrapping. For CPU-heavy libraries such as Marked, even one coarse call can still be slower because the library code executes in QuickJS/Wasm rather than in the browser's native JavaScript engine.

This document records the implemented proof-of-concept for an optional "performance mode" that moves selected real workload logic into the sandbox so that the host performs fewer, larger calls.

## Goal

Performance mode preserves the existing transparent sandboxing mode while offering an opt-in path for performance-sensitive workloads.

The intended goals are:

- Keep transparent import redirection as the default behavior.
- Reduce membrane crossings for hot paths by executing larger workload units inside QuickJS.
- Preserve the same isolation boundary and policy-driven API exposure model.
- Avoid requiring broad application rewrites.
- Make any non-transparent behavior explicit, inspectable, and optional.
- Allow developer-written adapter code to run inside the sandbox, reducing the trusted host-side surface for optimized workflows.

## Non-Goal

Performance mode should not replace the transparent proxy model. The transparent mode remains the most usable general-purpose interface and the best fit for compatibility tests, low-frequency calls, and applications where zero code changes matter more than raw throughput.

Performance mode also should not claim that arbitrary JavaScript can always be moved into the sandbox automatically. JavaScript closures, mutable host state, DOM references, dynamic imports, callbacks, and non-serializable objects make fully automatic lifting unsafe in the general case.

## Problem

Transparent mode exposes the library API directly to host code. This is convenient for ordinary usage:

```js
import _ from "lodash";

const totalsByRegion = _.mapValues(
  _.groupBy(completedOrders, "region"),
  (regionOrders) => _.sumBy(regionOrders, "total"),
);
```

and:

```js
import { z } from "zod";

const schema = z.object({
  id: z.string().startsWith("order-"),
  total: z.number().positive(),
});

schema.parse(order);
```

The problem is that these APIs are chatty. Lodash collection pipelines repeatedly pass arrays, callbacks, and derived objects through the membrane. Zod schema builders and validation methods involve chained objects and repeated method calls. In transparent mode, each public function or method invocation is visible at the host/sandbox boundary.

That behavior preserves compatibility, but it makes the worst-case performance profile depend on boundary traffic rather than on the library's own logic. The latest browser measurements showed Lodash and Zod as clear outliers because their workloads required many expensive crossings and large serialized payloads.

## Implemented Core Idea

Instead of exposing only the third-party library API through a fine-grained membrane, performance mode lets selected application-level workload functions be bundled with the sandboxed library.

The host imports a small workload entry point:

```js
import { validateOrders } from "sandbox-workload/zod/validation";

const result = validateOrders(orders, invalidOrder);
```

The workload module itself is bundled into the QuickJS sandbox:


```js
import { z } from "sandbox-real/zod";

const orderSchema = z.object({ /* ... */ });

export function validateOrders(orders, invalidOrder) {
  const parsedOrders = orders.map((order) => orderSchema.parse(order));
  const invalidResult = orderSchema.safeParse(invalidOrder);

  return {
    paidOrderCount: parsedOrders.filter((order) => order.paid).length,
    invalidAccepted: invalidResult.success,
  };
}
```

Internally, the schema and validation logic execute inside QuickJS. Only the input data and final result cross the boundary. For Lodash, the same pattern moves the whole collection transformation pipeline into the sandbox and returns the final aggregate object.

## Current Implementation

The proof-of-concept is implemented through explicit workload adapter modules configured in `.sandbox/sandbox.config.js`.

Example configuration:

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

The implementation has four moving parts:

1. Workload configuration

   Each configured library can define a `workloads` object. A workload declares a source entry module and the exported functions that should be made available to host code.

2. Workload bundle generation

   `WebpackSandboxPlugin` creates an additional child compiler per workload. The workload child compiler emits `dist/<library>.<workload>.workload.bundle.js` as an isolated bundle with `library.type: "var"` and a workload-specific global name such as `__SANDBOXED_WORKLOAD_collection__`.

   The workload bundle does not include another copy of the library. Imports of `sandbox-real/<library>` are compiled as an external reference to the already-loaded `__SANDBOXED_LIB__` global in the owning library sandbox.

3. Generated library proxy

   The normal `.sandbox/proxys/<library>-proxy.js` remains the owner of the QuickJS sandbox. It creates one sandbox with `SandboxManager.createSandbox("<library>", libraryCode)` and exports the transparent library API as before.

   If workloads are configured, the library proxy also exposes an internal async helper named `__getSandboxWorkloadExport(workloadName, exportName)`. The helper lazily fetches or reads the workload bundle, evaluates it inside the existing library sandbox through `librarySandbox.loadWorkload(...)`, and returns the bound workload export. Transparent library-only imports do not load or evaluate workload bundles.

4. Generated workload proxy

   The plugin writes `.sandbox/proxys/<library>-<workload>-workload-proxy.js`. This proxy imports `__getSandboxWorkloadExport` from the normal library proxy and exports host-callable functions that delegate to workload exports from the same sandbox instance. It does not call `SandboxManager.createSandbox()` and does not own disposal.

5. Import rewriting

   Host code imports a workload through `sandbox-workload/<library>/<workload>`. In sandbox builds, the plugin rewrites that import to the generated workload proxy. In native browser-harness builds, webpack aliases the same import to the plain workload module, allowing native-vs-sandbox comparison of the same adapter-level API.

Workload modules import the real package through `sandbox-real/<library>`. This avoids recursive interception while building the workload bundle. Without that alias, an adapter such as `validation-workload.js` importing `zod` would itself be redirected to the normal generated Zod proxy, causing the workload bundle to include the sandbox machinery recursively.

This means a page that imports both:

```js
import _ from "lodash";
import { summarizeOrders } from "sandbox-workload/lodash/collection";
```

uses one `lodash` QuickJS sandbox. The transparent API and the workload adapter share the same loaded library instance, permission configuration, async-job pump, and disposal lifecycle.

## Implemented Proof-of-Concept Workloads

Two browser workloads currently exercise the feature:

- `performance-harness/browser/workloads/lodash/collection-workload.js`
  - Exports `summarizeOrders(orders)`.
  - Runs Lodash filtering, grouping, aggregation, ordering, chaining, and item summarisation inside QuickJS.
  - The host receives only the final aggregate object.
- `performance-harness/browser/workloads/zod/validation-workload.js`
  - Exports `validateOrders(orders, invalidOrder)`.
  - Defines the Zod schema inside the sandbox and performs validation inside QuickJS.
  - The host receives only summary fields instead of every parsed object unless the application explicitly chooses to return them.

The corresponding browser scenarios are:

- `performance-harness/browser/scenarios/lodash/collection-adapter.scenario.js`
- `performance-harness/browser/scenarios/zod/validation-adapter.scenario.js`

These scenarios keep the same high-level workload intent as the transparent Lodash and Zod scenarios, but call the adapter-level API instead of driving the library API directly from the host.

## Security Properties

Performance mode does not weaken the isolation model. The third-party library still executes inside the QuickJS WebAssembly sandbox with the same permission configuration and Web API exposure rules.

The model can improve the security posture of optimized hot paths because selected developer-written adapter code also runs inside the sandbox. Instead of trusting host-side glue code to manipulate untrusted library results safely, the host can pass plain input data into a sandboxed workflow and receive a deliberately small result object.

The boundary remains explicit:

- Host code decides which workload entry point to call.
- Workload modules are named and configured.
- Inputs and outputs still cross through the existing membrane and marshalling rules.
- The sandbox cannot access host APIs unless the library's permission configuration exposes them.
- Workloads share the base library sandbox, so they inherit the same per-library policy instead of requiring a second workload-specific policy entry.

## Performance Interpretation

The intended performance improvement is not that QuickJS executes JavaScript faster than the browser engine. It does not. The improvement comes from moving many fine-grained crossings into one coarse-grained sandbox call.

For chatty APIs, this changes the cost model:

- Transparent mode: many host calls into library API methods, many intermediate objects crossing the membrane.
- Performance mode: one host call into a workload function, most intermediate objects stay inside QuickJS.

This is especially useful for:

- Zod schema construction and validation loops.
- Lodash data transformation pipelines, especially chains and callbacks.
- Library-specific workflows where the same sandboxed library is called many times per user operation.

It is less useful for:

- Single large CPU-heavy calls where most time is spent executing JavaScript inside QuickJS/Wasm.
- Workloads that need frequent DOM or Web API interaction.
- Workloads that return large object graphs, because the final result still has to cross the boundary.

## Developer Experience

The current proof-of-concept asks the developer to do three explicit things for a hot path:

1. Move the hot library usage into a workload module.
2. Add that workload to `.sandbox/sandbox.config.js`.
3. Import the workload through `sandbox-workload/<library>/<workload>`.

This is more work than transparent mode, but still small compared with rewriting the application or changing the library. It also keeps performance-sensitive boundaries visible in source code and configuration, which is useful for a research prototype.

## Future Work: Annotation-Based Lifting

The explicit adapter approach is the right first proof-of-concept because it is easy to reason about and easy to measure. A future Webpack-based improvement could reduce developer friction by supporting annotation-based lifting.

Example source:

```js
// @sandbox-workload zod validation
import { z } from "zod";

const orderSchema = z.object({
  id: z.string().startsWith("order-"),
  total: z.number().positive(),
});

export function validateOrder(order) {
  return orderSchema.parse(order);
}
```

or:

```js
import { sandboxed } from "webpack-sandbox-plugin/runtime";

export const validateOrder = sandboxed("zod", "validation", () => {
  const orderSchema = z.object({ /* ... */ });
  return (order) => orderSchema.parse(order);
});
```

The plugin would detect the annotation or helper call, extract the marked function/module into a workload child compiler, rewrite host imports or call sites to the generated workload proxy, and preserve the same runtime architecture used by the explicit adapter implementation.

Eligibility rules should remain conservative:

- Captured values must be serializable constants, sandboxed imports, or explicitly supported values.
- DOM references, host object references, mutable host state, dynamic imports, and unknown closures should be rejected by default.
- The plugin should fail closed with clear diagnostics when a function cannot be lifted.
- Host callbacks should be disallowed or explicitly marked as expensive because they reintroduce boundary crossings.

Annotation-based lifting would make the developer job easier, but it is harder to implement safely. For this prototype, explicit adapter modules provide the same architectural evidence with fewer hidden assumptions.

## Relationship to Transparency

Performance mode should be presented as progressive optimization:

1. Transparent mode: no application code changes, maximum usability.
2. Explicit adapter mode: small explicit change for measured hot paths.
3. Annotation-based lifting: possible future improvement that keeps the same coarse-grained execution model with less manual configuration.

This preserves the core thesis objective. Developers can sandbox configured libraries without code changes. When measurements show that a specific hot path suffers from excessive boundary crossings, the system can offer an optional way to move that workload closer to the sandboxed dependency.

## Later Future Work: Build-Time Auto-Lifting

The most transparent future option is build-time auto-lifting. The plugin would analyze application modules and detect functions that mainly depend on configured sandboxed libraries.

For example, if a function only depends on `zod`, serializable constants, and serializable inputs, the plugin could move it into the Zod sandbox bundle automatically.

Advantages:

- Best usability if it works.
- Could preserve source-level transparency for many common cases.
- Provides a migration path where developers first rely on transparent mode and later benefit from automatic optimization.

Drawbacks:

- Hard to implement correctly for arbitrary JavaScript.
- Unsafe or ambiguous captures must be rejected.
- Dynamic language features can defeat static analysis.
- Debuggability may suffer if code silently moves execution environments.

Because of these risks, auto-lifting should be treated as a later optimization, not as the first version of performance mode.

## Research Framing

The performance results should be interpreted as evidence of a known membrane trade-off:

- Fine-grained transparent APIs optimize usability and compatibility.
- Coarse-grained sandbox workloads optimize runtime performance.

The contribution is not to abandon transparency, but to support both modes in the same architecture. Transparent mode remains the default. Performance mode is an optional specialization for workloads where the application can benefit from fewer, larger sandbox calls.
