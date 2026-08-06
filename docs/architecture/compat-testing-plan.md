# Compatibility Testing Architecture

**Status:** Implemented operational architecture for the compatibility campaigns on `main`.

Compatibility testing compares the same upstream-derived library tests in native and sandbox modes. The automated runner owns execution planning, process isolation, result parsing, provenance, and comparison validity. Raw outputs are kept separate from performance measurements.

## 1. Goals

- Exercise real package APIs rather than sandbox-specific rewrites.
- Keep native and sandbox test selections comparable.
- Preserve runner-specific behaviour for Jest, Vitest, AVA, QUnit, Node TAP, and CommonJS suites.
- Isolate files or batches when one failing process would hide later results.
- Retain complete logs and machine-readable artifacts for audit.
- Refuse to report a compatibility ratio when the two modes are not comparable.

The harness measures compatibility for the evaluated suites. It does not prove compatibility with every package API or application workload.

## 2. Components

```text
compatibility-harness/manifest.mjs
        | library commands, parsers, discovery, strategies
        v
compatibility-harness/run-compat.mjs
        | plans units, spawns processes, parses and aggregates
        +----> units.mjs       discovery, selection, batching, fingerprints
        +----> parsers.mjs     TAP, QUnit, Jest/Vitest JSON, text summaries
        v
test-sandbox-redirect/
        | ESM loader or CommonJS require hook
        v
.sandbox/proxys/<library>-proxy.js
        | generated API facade
        v
QuickJS library context
```

When populated locally, `test-harness/<library>/` contains upstream-derived tests and runner configuration. The suites are intentionally ignored by Git, so a developer must obtain them before executing a campaign or its internal harness checks. Treat large suites as vendored fixtures: avoid stylistic rewrites or application-specific modifications.

## 3. Import redirection

Sandbox mode must execute the original test import against the generated proxy.

### 3.1 ESM loader

`test-sandbox-redirect/register-sandbox.mjs` registers `sandbox-loader.mjs`. The loader maps configured bare package requests and selected source paths to `.sandbox/proxys/<library>-proxy.js`.

```powershell
node --import ./test-sandbox-redirect/register-sandbox.mjs --test <test-file>
```

### 3.2 CommonJS hook

`register-sandbox-cjs.mjs` installs `sandbox-require-hook.cjs` for suites that resolve packages through `require()`.

### 3.3 Runner-specific mapping

Some runners resolve modules internally and do not pass every request through the generic Node loader. Their manifest commands retain dedicated configuration, such as Jest `moduleNameMapper`, Vitest aliases, AVA setup, or compatibility shims. These mappings are part of the evaluated method and must remain explicit.

## 4. Manifest contract

`compatibilityManifest` is the source of truth for the ten evaluated libraries. Each entry defines:

- library name and harness directory;
- command factory for each mode;
- parser for the runner's result format;
- default strategy and optional per-mode override;
- test discovery rules when files are isolated or batched;
- optional fallback behaviour;
- environment or immutable runner configuration.

The configured libraries are `date-fns`, `image-js`, `lodash`, `luxon`, `marked`, `mime`, `strip-ansi`, `tweetnacl`, `yup`, and `zod`.

## 5. Execution strategies

The planner in `units.mjs` supports:

| Strategy | Behaviour | Use |
|---|---|---|
| `suite` | One runner process for the configured suite | Default where the runner completes and reports reliably |
| `per-file` | One process per discovered test file | Prevents an early crash from hiding later files |
| `batch` | Fixed-size groups of discovered files | Balances isolation and execution cost |

Current special cases:

- Date-fns: native suite; sandbox batches of 10 with invalid-batch fallback to individual files.
- Yup: native suite; sandbox batches of 5 with the same fallback.
- Zod: each v4 classic test file runs in an independent process.
- Other evaluated libraries: suite-level execution.

A fallback occurs when a batch crashes or fails to produce a valid parsed summary. The original attempt remains in the artifacts for diagnosis but is excluded from aggregate totals and replaced by its per-file attempts.

## 6. Selection and fingerprints

For isolated strategies, discovery applies manifest-defined directories, suffixes, and exclusions. Paths are normalized relative to the harness root. A repeated `--test-file` option selects a subset only after discovery validates it.

The planner fingerprints the effective test set and strategy. A native/sandbox compatibility ratio is reported only when:

1. both modes have valid complete summaries;
2. every expected file contributes a valid included result;
3. the test-set fingerprints match;
4. both modes execute the same number of tests.

When valid, the ratio is:

```text
sandbox passed / native passed
```

This guard prevents partial sandbox execution from appearing more compatible than it is.

## 7. Status and interruption semantics

Each attempt records command outcome, parsed counts, files, sequence, and inclusion state. Status classification distinguishes successful, test-failing, process-failing, invalid-result, and interrupted work.

The runner imposes no suite-level timeout. A user interruption is recorded as `interrupted`, completed artifacts are retained, and the campaign is not reported as a valid comparison.

## 8. Result layout

Each invocation writes one directory per library and timestamp:

```text
compatibility-results/<library>/<timestamp>/
  summary.csv
  failures.csv
  units.csv
  run-metadata.json
  native/
  sandbox/
```

Mode directories contain aggregate logs/results and `units/<sequence-hash>/` attempt details. `run-metadata.json` records the resolved plan and campaign context. Result directories are ignored by Git; include relevant paths and metadata in a pull request when reporting a compatibility change.

Compatibility artifacts must not be placed under `performance-harness/results*`. Compatibility counts and performance timings have different collection contracts.

## 9. Adding a library

1. Add the dependency and declarations.
2. Add the library and minimum permissions to `.sandbox/sandbox.config.js`.
3. Build bundles and inspect the generated proxy.
4. Add or preserve the upstream-derived suite under `test-harness/<library>/`.
5. Determine how the runner resolves imports; use the generic loader unless the framework requires explicit mapping.
6. Add the manifest entry, parser, discovery rules, and execution strategy.
7. Add parser/planner unit coverage where the runner introduces a new output shape or policy.
8. Run a small native and sandbox selection before the complete campaign.
9. Verify matching fingerprints and executed counts before interpreting the ratio.
10. Update the operational README and supported-library documentation.

## 10. Verification

Optionally run the internal harness checks after the upstream suites are available locally:

```powershell
node --test compatibility-harness/test/parsers.test.mjs
```

These checks validate parser and execution-planning infrastructure; they do not provide sandbox-runtime regression coverage. Native-versus-sandbox campaigns are the functional compatibility evidence for the plugin.

Refresh proxies and execute one target library:

```powershell
node compatibility-harness/run-compat.mjs --library zod --build
```

See [../../compatibility-harness/README.md](../../compatibility-harness/README.md) for all CLI options and examples.
