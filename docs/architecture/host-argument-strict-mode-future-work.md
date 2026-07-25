# Future Work: Strict and Attenuated Host Argument Modes

**Status:** Design exploration only. None of the modes in this document are implemented on `main`. The current compatibility-first boundary is documented in [host-argument-capability-limitation.md](host-argument-capability-limitation.md) and [sandbox-plugin-spec-v2.md](sandbox-plugin-spec-v2.md).

## Context

The current transparent sandbox mode allows host application arguments to cross into the QuickJS VM through the Arena bridge. This preserves compatibility with common JavaScript APIs, including APIs that accept callbacks, option objects, class instances, and other non-plain values.

The trade-off is that authority-bearing host behavior can act as a capability. A sandboxed library cannot access undeclared ambient Web APIs by itself, and ordinary plain objects passed as arguments are not equivalent to explicitly synchronized Web APIs. The sharper concern is that callbacks, accessors, and method-bearing objects passed by the application may expose executable host behavior.

This document outlines future hardening modes that could reduce this risk while preserving the current compatible behavior as the default.

## Goals

- Preserve transparent compatibility as the default mode.
- Make host-to-VM executable behavior transfer visible and configurable.
- Allow stronger boundaries for libraries that only need data inputs.
- Avoid forcing one strict policy on all JavaScript libraries.
- Keep Web API permissions and host argument capabilities conceptually separate.

## Non-Goals

- Do not make strict mode the only supported behavior.
- Do not claim that arbitrary JavaScript APIs can remain fully compatible under a data-only boundary.
- Do not describe ordinary marshalled host objects as live synchronized capabilities unless they are explicitly exposed through `arena.sync(...)`.
- Do not silently wrap broad callable/accessor-bearing host objects in a way that implies safety while still exposing executable authority.

## Option 1: Audit Mode

Audit mode would keep current compatibility but report risky host-to-VM crossings.

Examples of crossings to record:

- function arguments,
- class instances with methods,
- objects with custom prototypes,
- objects with getters or setters,
- nested functions inside options objects,
- DOM or Web API objects,
- large object graphs.

Possible output:

```text
[Sandbox] Host capability passed to lodash.map at argument 2: function iteratee
[Sandbox] Non-plain object passed to some-library.parse at argument 1: StorageClient
```

This mode is low risk for compatibility and useful for research because it can reveal how often real workloads rely on authority-bearing arguments.

Audit mode should distinguish between data-shape risk and execution-capability risk. A large plain object may be relevant for performance or denial-of-service analysis, but it is not the same kind of boundary concern as a function, getter, setter, or method that can execute host code.

## Option 2: Per-Library Argument Policy

Instead of a single global rule, each sandboxed library could declare an argument policy.

```js
export default {
  "marked": {
    permissions: [],
    argumentPolicy: "data-only"
  },
  "lodash": {
    permissions: [],
    argumentPolicy: "compat"
  }
};
```

Possible policy levels:

- `compat`: current behavior; all Arena-supported values may cross.
- `audit`: current behavior plus warnings/metrics for authority-bearing values.
- `data-only`: primitives, arrays, plain objects, typed arrays, dates, regexps, and errors may cross by value; functions, accessors, and method-bearing non-plain objects are rejected.
- `explicit-capabilities`: data crosses normally, but callbacks, accessors, and selected object methods require explicit wrappers.

This fits the project because different libraries have different API shapes. A parser or formatter may work well with `data-only`, while a callback-heavy utility library may need `compat` or `explicit-capabilities`.

## Option 3: Explicit Capability Wrappers

Explicit wrappers would make authority transfer visible in host code.

```js
import { allowCallback, allowObjectCapability } from "./sandbox-capabilities";

sandboxedLibrary.process(data, {
  onResult: allowCallback(handleResult, {
    maxCalls: 10,
    argumentPolicy: "data-only",
    returnPolicy: "void"
  }),
  logger: allowObjectCapability(logger, {
    methods: ["warn", "error"]
  })
});
```

This approach preserves compatibility for intentional callbacks while avoiding accidental broad behavior exposure.

Useful restrictions include:

- allowed method list,
- maximum call count,
- argument marshalling policy,
- return-value marshalling policy,
- timeout/deadline per callback,
- read-only property projection,
- no getter execution unless explicitly allowed.
- no synchronization of ordinary object mutation unless explicitly requested.

## Option 4: Data Copy by Default, Capability Grant by Exception

A stricter production profile could split values into two categories:

- data values cross by copy or structured marshalling,
- authority values require explicit capability grants.

Data values may include:

- `null`,
- booleans,
- numbers,
- strings,
- arrays,
- plain objects,
- typed arrays,
- `ArrayBuffer`,
- `Date`,
- `RegExp`,
- `Error`.

Authority values may include:

- functions,
- class instances,
- objects with custom prototypes,
- objects with getters/setters,
- objects whose prototype methods are intended to be callable by sandboxed code,
- host API objects,
- framework objects,
- service clients.

This model is clearer from a security perspective, but it is more likely to break existing JavaScript library APIs.

This mode should not be justified as a required defense against ordinary sandbox-internal prototype pollution escaping to the host. Under normal marshalling, QuickJS prototype mutation stays in the QuickJS heap. The strict-mode motivation is instead to make executable host behavior transfer explicit and to prevent later host-side misuse of attacker-shaped data.

## Recommended Evolution Path

The most practical sequence is:

1. Document the current limitation and developer guidance.
2. Add audit mode to measure real compatibility impact.
3. Add per-library `argumentPolicy` configuration.
4. Add explicit capability wrappers for callbacks and selected object methods.
5. Consider a strict `data-only` mode for libraries whose APIs support it.

This sequence keeps the current transparent mode intact while creating a path toward stronger production hardening.

## Research Value

This future work exposes the central trade-off between JavaScript compatibility and capability-safe isolation. Any implementation must therefore be opt-in, compatibility-tested, and documented as a change to the sandbox's authority model.

Transparent sandboxing improves adoption because developers can keep using familiar APIs. Strict argument policies improve confinement but require developers to think in terms of data transfer and explicit capabilities. A practical sandbox for npm dependencies likely needs both modes, with compatibility as the default and stricter policies available for security-sensitive integrations.
