# Repository Guidelines

## Project overview

`spike-quickjs` is an experimental Webpack plugin that isolates untrusted browser-side npm libraries in per-library QuickJS WebAssembly contexts. It generates proxy modules, bundles configured libraries separately, redirects host imports, and exposes only policy-selected capabilities through membrane wrappers.

Treat source code and executable configuration as authoritative. `README.md` is the developer entry point, `docs/README.md` classifies documentation, and `docs/architecture/sandbox-plugin-spec-v2.md` is the canonical architecture specification.

## Repository structure

- `webpack-sandbox-plugin/src/`: TypeScript Webpack plugin, declaration parser, and proxy generator.
- `.sandbox/core/`: QuickJS/Arena lifecycle and capability exposure.
- `.sandbox/membrane/`: forward host-to-QuickJS and reverse QuickJS-to-host wrappers.
- `.sandbox/marshallers/`: registered typed-array, RegExp, arguments, and error conversions.
- `.sandbox/sandbox.config.js`: per-library permissions and optional workload declarations.
- `test-sandbox-redirect/`: deterministic ESM and CommonJS test import redirection.
- `compatibility-harness/`: ten-library campaign manifest, unit planning, result parsing, and artifact generation.
- `lib-test/security/app/`: isolated dependency tree and reproducible browser security scenarios.
- `test-harness/`: upstream-derived compatibility suites. Preserve runner-specific configuration.
- `dist/` and `.sandbox/proxys/`: generated output; never edit or commit.

## Commands

```powershell
npm install
npm run build:bundles
npx webpack --config webpack.config.cjs
node --test compatibility-harness/test/parsers.test.mjs
node compatibility-harness/run-compat.mjs --library zod
node compatibility-harness/run-compat.mjs --library zod --mode sandbox --build
```

Run a single compatibility test directly only when debugging its loader path:

```powershell
node --import ./test-sandbox-redirect/register-sandbox.mjs --test test-harness/<library>/<file>.js
```

The automated harness is preferred because it fingerprints the test set and records complete result artifacts.

Security validation commands and safety constraints are documented in `lib-test/security/app/README.md`. The isolated app intentionally pins vulnerable Lodash; do not run `npm audit fix` there before validation.

## Performance branch

Performance tooling is intentionally separate on `feat/sandbox-benchmarking`. That branch instruments forward and reverse membrane crossings and contains browser scenarios, batch collection, CSV contracts, a Python analyzer, and methodology documents.

Use a separate checkout or worktree and follow `performance-harness/README.md` on that branch. Do not describe its commands as available on `main`, and do not mix instrumented sandbox code into unrelated runtime changes.

## Coding and architecture rules

- Use ES modules, `const`/`let`, PascalCase for classes and types, camelCase for functions and variables, two-space indentation, and semicolons, matching surrounding files.
- Add JSDoc to every new or materially changed class and function. Add concise comments where behaviour, lifecycle ownership, cross-runtime semantics, or a non-obvious decision would otherwise be unclear; do not use comments to restate self-evident code.
- Keep one QuickJS context per configured library.
- Keep capability exposure deny-by-default and prefer constrained facades.
- Preserve method receivers, constructor behaviour, object identity where supported, and async job pumping.
- Dispose QuickJS handles, helper functions, Arena resources, and contexts in lifecycle changes.
- Register new marshallers in `.sandbox/marshallers/index.js`; an unregistered file is inactive.
- Update `docs/architecture/architectural-decisions.md` for material architectural changes.

## Testing rules

- Compatibility is the primary functional signal. Add or update focused upstream-derived fixtures and run native and sandbox modes.
- Every correction must include a short, focused test scenario that reproduces the corrected behaviour and protects it from regression. Use the smallest appropriate unit, compatibility, or browser-security scenario; retain or update it with the correction.
- Preserve framework-specific mappings for Jest, Vitest, AVA, QUnit, and CommonJS suites.
- Keep compatibility artifacts separate from performance measurements.
- For security changes, validate both allowed functionality and denied host effects.
- Report exact commands and results. If a runner, browser, dependency, or operating-system limitation prevents validation, state that boundary explicitly.

## Git and documentation

Use conventional branch prefixes and lightweight Conventional Commit subjects. Preserve unrelated working-tree changes. Do not commit generated bundles, proxies, raw result directories, or caches.

Update the relevant documentation after every change, including code, configuration, tests, and developer workflow changes. Keep the README, documentation index, canonical specification, architecture decisions, and operational guides aligned with the change; if no documentation update is needed, state why in the change or PR description. Maintained developer documentation and PlantUML labels are English. Label future-work documents explicitly and link to the canonical specification instead of copying architecture text. Keep diagrams as versioned `.puml` sources under `docs/diagrams/`; do not add a parallel Markdown diagram narrative.
