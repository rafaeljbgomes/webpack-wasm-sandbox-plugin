# Compatibility Harness

Runs the configured library test suites in native and sandbox modes and stores
the complete logs separately from the performance evaluation results.

## Usage

```powershell
node compatibility-harness/run-compat.mjs
node compatibility-harness/run-compat.mjs --library zod
node compatibility-harness/run-compat.mjs --mode sandbox
node compatibility-harness/run-compat.mjs --library zod --mode native
node compatibility-harness/run-compat.mjs --library zod --test-file packages/zod/src/v4/classic/tests/array.test.ts
node compatibility-harness/run-compat.mjs --library date-fns --batch-size 5
node compatibility-harness/run-compat.mjs --library yup --batch-size 3
node compatibility-harness/run-compat.mjs --library date-fns --strategy per-file
node compatibility-harness/run-compat.mjs --build
```

Use `--build` when the generated bundles and proxies need to be refreshed.
Without it, the runner validates and uses the existing proxy files.
`--strategy`, `--batch-size`, and repeatable `--test-file` overrides require
`--library`.

The configured libraries are:

- `date-fns`
- `image-js`
- `lodash`
- `luxon`
- `marked`
- `mime`
- `strip-ansi`
- `tweetnacl`
- `yup`
- `zod`

`dayjs` and `mnemonist` are intentionally excluded.

Date-fns and Yup run native mode as a single suite, then run sandbox mode in
small batches of discovered test files. Date-fns defaults to batches of 10
files and Yup defaults to batches of 5 files. If a sandbox batch crashes or
does not produce a valid summary, its files are retried one at a time. Zod runs
each v4 classic test file in an independent process. The other libraries retain
suite-level execution.

## Results

Each invocation stores results by library and then timestamp:

```text
compatibility-results/<library>/<timestamp>/
```

Each library directory contains `summary.csv`, `failures.csv`, `units.csv`,
`run-metadata.json`, and mode-specific aggregate logs and results. Isolated
attempts are retained under `<mode>/units/<sequence-hash>/`. A failed batch
replaced by per-file retries remains available for auditing but is excluded
from the totals.

Test-runner output is written to the log files rather than repeated in the
terminal. The terminal only shows campaign progress and the final result path.

The compatibility ratio is only reported when native and sandbox use the same
test-set fingerprint, every expected file produces a valid result, and both
modes execute the same number of tests:

```text
sandbox passed / native passed
```

No suite-level timeout is imposed. A manual interruption is recorded as
`interrupted`.
