# Compatibility Harness

**Status:** Active compatibility campaign runner for `main`.

The harness runs the configured upstream-derived suites in native and sandbox modes. It stores complete logs, parsed results, execution plans, and comparison metadata under `compatibility-results/`, separate from performance benchmark data.

Read [the testing architecture](../docs/architecture/compat-testing-plan.md) before changing manifest policy, discovery, fingerprints, or aggregation.

## Prerequisites

Install the root dependencies:

```powershell
npm install
```

The repository tracks the runner, manifest, and immutable runner configurations, but intentionally does not version the upstream-derived suites. Before a campaign, obtain each suite and place it under the `test-harness/<library>/` path declared in `manifest.mjs`. Generated proxies and bundles must exist before sandbox execution; pass `--build` when they may be stale or absent.

## CLI

```text
node compatibility-harness/run-compat.mjs [options]

--library <name>     Run one configured library
--mode <mode>        Run only native or sandbox
--strategy <value>   Override suite, per-file, or batch strategy
--batch-size <n>     Override the positive batch size
--test-file <path>   Select one discovered test file; repeatable
--build              Build sandbox bundles before sandbox runs
```

`--strategy`, `--batch-size`, and `--test-file` require `--library`. `--batch-size` is valid only with the batch strategy.

## Examples

Run all libraries in both modes using existing generated artifacts:

```powershell
node compatibility-harness/run-compat.mjs
```

Run one complete comparison and refresh bundles/proxies first:

```powershell
node compatibility-harness/run-compat.mjs --library zod --build
```

Run one mode:

```powershell
node compatibility-harness/run-compat.mjs --library date-fns --mode sandbox
```

Select one or more discovered files:

```powershell
node compatibility-harness/run-compat.mjs `
  --library zod `
  --mode sandbox `
  --test-file packages/zod/src/v4/classic/tests/array.test.ts
```

Override isolation while diagnosing a library:

```powershell
node compatibility-harness/run-compat.mjs --library date-fns --strategy per-file
node compatibility-harness/run-compat.mjs --library yup --strategy batch --batch-size 3
```

Overrides are diagnostic controls. Record them with any result derived from a non-default plan.

## Evaluated libraries and default plans

| Library | Native | Sandbox | Parser |
|---|---|---|---|
| `date-fns` | suite | batches of 10, fallback per file | Vitest JSON |
| `image-js` | suite | suite | Vitest JSON |
| `lodash` | suite | suite | QUnit |
| `luxon` | suite | suite | Jest JSON |
| `marked` | suite | suite | TAP |
| `mime` | suite | suite | TAP |
| `strip-ansi` | suite | suite | TAP |
| `tweetnacl` | suite | suite | TAP |
| `yup` | suite | batches of 5, fallback per file | Vitest JSON |
| `zod` | per file | per file | Vitest JSON |


## Redirection paths

Sandbox commands preserve test imports and redirect them to generated proxies:

- ESM suites register `test-sandbox-redirect/register-sandbox.mjs`;
- CommonJS suites register `register-sandbox-cjs.mjs` and the require hook;
- framework-managed resolution uses committed Jest/Vitest/AVA-specific aliases or setup.

Do not replace a runner-specific mapping with the generic loader without proving that every relevant import, including source-path imports, still reaches the proxy.

## Units, batching, and fallback

`suite`, `per-file`, and `batch` plans are resolved before execution. Discovered file paths are normalized and fingerprinted. For Date-fns and Yup, a sandbox batch that crashes or produces no valid summary is retried one file at a time.

The failed batch remains under its unit directory for audit. Its counts are excluded and the included per-file retries replace it in aggregate totals.

No suite-level timeout is imposed. Manual termination produces an `interrupted` status and retains completed work.

## Results

Each invocation stores results by library and timestamp:

```text
compatibility-results/<library>/<timestamp>/
```

Each library directory contains:

- `summary.csv`: mode totals and comparison fields;
- `failures.csv`: parsed test or process failures;
- `units.csv`: every attempt, inclusion state, files, status, and fallback relationship;
- `run-metadata.json`: resolved plan, options, and fingerprints;
- `<mode>/`: aggregate logs/results;
- `<mode>/units/<sequence-hash>/`: per-attempt command output and reports.

Test-runner output is written to log files rather than repeated in the terminal. The terminal reports campaign progress and the final result path.

## Comparison validity

The compatibility ratio is emitted only when native and sandbox:

- have the same test-set fingerprint;
- produce a valid result for every expected file;
- execute the same number of tests;
- complete without interruption.

For a valid comparison:

```text
compatibility ratio = sandbox passed / native passed
```

Do not calculate a replacement ratio manually from incomplete totals.

## Internal harness checks

```powershell
node --test compatibility-harness/test/parsers.test.mjs
```

These checks cover parsers, manifest membership and paths, discovery, execution plans, fallback inclusion, CLI overrides, and comparison guards. They require the upstream suites to be present locally and do not test sandbox runtime semantics or provide sandbox-regression coverage.
