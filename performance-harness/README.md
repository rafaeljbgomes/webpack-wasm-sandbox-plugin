# Performance Harness

This harness has two execution paths:

- `run-command.mjs` wraps an existing Node command, injects a runtime metrics
  hook, and appends summarized results to CSV files under
  `performance-harness/results/`.
- `run-browser-scenario.mjs` builds and runs checked-in browser scenarios under
  headless Chromium with Playwright and CDP, writing compatible CSV files under
  `performance-harness/results-browser/`.

See `docs/tests/browser-performance-harness.md` for the browser harness
architecture, scenario contract, CSV schema, and usage details.

For browser sandbox runs, `--library` is the CSV grouping label and
`.sandbox/sandbox.config.js` controls which package webpack actually redirects
to a sandbox proxy. The browser runner rejects sandbox runs when the requested
library is not enabled in that config, preventing mislabeled native rows.

Browser runs report both workload-only `wall_ms` and broader
`browser_elapsed_ms`. Use `wall_ms` to compare the repeated scenario workload
itself, and use `browser_elapsed_ms` when you want a number closer to external
browser command timing.

## Run a sandboxed command

```powershell
node performance-harness/run-command.mjs `
  --mode sandbox `
  --library marked `
  --workload-id parser `
  --label "marked parser sandbox" `
  --iterations 5 `
  --warmup 1 `
  -- node `
  --import ./test-sandbox-redirect/register-sandbox.mjs `
  test-harness/marked/test/unit/Parser.test.js
```

## Run a native command

```powershell
node performance-harness/run-command.mjs `
  --mode native `
  --library marked `
  --workload-id parser `
  --label "marked parser native" `
  --iterations 5 `
  --warmup 1 `
  -- node test-harness/marked/test/unit/Parser.test.js
```

## Analyze results

Install the Python analysis dependency once:

```powershell
python -m pip install -r performance-harness/requirements.txt
```

```powershell
python performance-harness/analyze.py --results-dir performance-harness/results
```

Analyze browser results with the same entrypoint:

```powershell
python performance-harness/analyze.py --results-dir performance-harness/results-browser
```

The analyzer reports native-vs-sandbox overhead for both execution and browser
heap usage. Runtime correlations use `wall_ratio`; memory overhead correlations
use `peak_heap_ratio`, calculated as sandbox peak JS heap divided by native peak
JS heap for the same workload. The memory section correlates that ratio against
crossing count, median crossing size, p95 crossing size, and total crossing
bytes.

## Run all browser scenarios

Use the PowerShell helper to collect browser measurements for every checked-in
scenario in both native and sandbox mode:

```powershell
.\performance-harness\run-all-browser-scenarios.ps1
```

For a quick smoke run:

```powershell
.\performance-harness\run-all-browser-scenarios.ps1 `
  -Iterations 1 `
  -Warmup 0 `
  -Repetitions 1 `
  -OutDir performance-harness/results-browser-smoke
```
