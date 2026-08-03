# Contributing

This repository contains an experimental sandboxing prototype. Contributions must preserve the distinction between implemented behaviour and proposed future work.

## Before changing code

1. Read the [project README](README.md), [documentation index](docs/README.md), and [canonical architecture specification](docs/architecture/sandbox-plugin-spec-v2.md).
2. Confirm that the target file is source rather than generated or vendored output.
3. Create a focused branch using the repository's conventional prefixes, for example `fix/...`, `feat/...`, `test/...`, `docs/...`, or `chore/...`.
4. Record the current `git status`. Preserve unrelated local and untracked files.
5. Plan the short, focused test scenario that will prove the change and prevent its regression.

Do not edit or commit:

- `dist/` or generated `.sandbox/proxys/*-proxy.js` files;
- `compatibility-results*/` or `performance-harness/results*/` data;
- upstream-derived files under `test-harness/<library>/` unless the fixture change is intentional and documented;

## Install and verify the baseline

```powershell
npm install
npm run build:bundles
node --test compatibility-harness/test/parsers.test.mjs
```

The bundle build on `main` generates ten library bundles. Benchmark workload adapters are maintained exclusively on `feat/sandbox-benchmarking` and are not part of this branch's configuration.

## Change the sandbox runtime

Runtime compatibility depends on object identity, method receivers, constructor behaviour, marshalling, and pending-job execution. When changing `.sandbox/`:

- keep one QuickJS context per library;
- preserve deny-by-default capability exposure;
- dispose newly created handles or helper functions;
- test calls, constructors, getters, returned stateful objects, and errors in both directions;
- update the canonical specification and architectural decision record when behaviour or a security boundary changes.

Custom marshallers implement `{ isWrappable, isHandleWrappable, marshal, unmarshal, dispose }`. A new marshaller is inactive until it is registered in `.sandbox/marshallers/index.js`.

## Add or update a sandboxed library

1. Add the dependency and its declarations, if declarations are not bundled with the package.
2. Add the package to `.sandbox/sandbox.config.js` with the smallest required `permissions` list.
3. Run `npm run build:bundles` and inspect the generated proxy without editing it.
4. Add or retain an upstream-derived harness under `test-harness/<library>/`.
5. Add a manifest entry in `compatibility-harness/manifest.mjs`, including the native and sandbox commands, parser, execution strategy, and any deterministic loader mapping.
6. Run a targeted native/sandbox campaign and retain the output path in the PR description.
7. Update the supported-library list and affected developer documentation.

Some test frameworks need runner-specific mapping rather than the generic Node ESM loader. Keep such configuration immutable and explicit.

## Change permissions or capability exposure

A configured host object is a capability. Before exposing one:

- identify the exact API surface the library needs;
- route objects and functions through the forward membrane;
- test that an unconfigured library cannot access it;
- document any authority that can still arrive through host-supplied arguments.

Security scenarios belong in the isolated `lib-test/security/app/` dependency tree. Simulation patches must be harmless, checked in, offline, and clearly distinguished from vulnerabilities in the unmodified package.

## Compatibility campaigns

Use `compatibility-harness/run-compat.mjs`. Do not mix its outputs with performance results. Run one library while developing:

```powershell
node compatibility-harness/run-compat.mjs --library zod --mode sandbox --build
```

The final comparison is valid only when native and sandbox executions have matching test-set fingerprints, complete parsed results, and equal executed-test counts. See [compatibility-harness/README.md](compatibility-harness/README.md).

## Performance work

Performance work belongs on `feat/sandbox-benchmarking`, which instruments the membrane paths and contains the collection and analysis tooling. Use a separate checkout or worktree and follow that branch's `performance-harness/README.md`. Do not copy its instrumentation into an unrelated runtime or documentation change.

## Documentation standards

- Update the relevant documentation after every change, including code, configuration, tests, and developer workflow changes. Keep the README, documentation index, canonical specification, architectural decisions, and operational guides aligned; if no documentation update is needed, explain why in the PR description.
- Use English for maintained developer documentation.
- State whether a document is canonical, operational, historical, or future work.
- Derive behaviour from source and commands from executable configuration.
- Keep generated compatibility and performance results out of version control.
- Link to one canonical explanation instead of maintaining duplicate specifications.
- Use exact terms consistently: host, QuickJS context, Arena, forward membrane, reverse membrane, marshaller, generated proxy, and workload adapter.

## Code documentation and regression prevention

- Add JSDoc to every new or materially changed class and function. It must explain the contract, especially parameters, return values, ownership, lifecycle, side effects, or cross-runtime behaviour when applicable.
- Add concise implementation comments where code behaviour, lifecycle ownership, membrane crossings, or a non-obvious decision would otherwise be unclear. Do not comment code that is already self-explanatory.
- Every correction must add or update a short, focused test scenario that reproduces the corrected behaviour and guards against future regressions. Choose the smallest suitable unit, compatibility, or browser-security scenario, and run it alongside any broader validation required by the affected subsystem.

## Pull requests

Use an imperative Conventional Commit-style subject where practical. The PR description must identify:

- the affected subsystem or evaluated library;
- the security or compatibility consequence;
- commands run and their results;
- generated outputs that were intentionally not committed;
- documentation and architectural decisions updated;
- the focused regression scenario added or updated for each correction;
- validation that could not be completed and why.
