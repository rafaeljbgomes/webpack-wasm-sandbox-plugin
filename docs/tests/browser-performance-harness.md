# Chromium Browser Performance Harness

The browser performance harness measures the same checked-in workload in two
browser modes:

- `native`: the scenario imports the npm package directly.
- `sandbox`: the scenario imports the same package name, but webpack redirects it
  through `WebpackSandboxPlugin` to the generated QuickJS sandbox proxy.

The harness is intentionally Chromium-only for the first browser evaluation
path. It uses Playwright to control headless Chromium and Chrome DevTools
Protocol (CDP) to collect browser-level metrics, while reusing the existing
runtime instrumentation for sandbox-internal metrics.

## Goals

- Keep scenario code identical between native and sandbox runs.
- Exclude webpack build time from measured runtime overhead.
- Preserve the existing CSV workflow and keep
  `performance-harness/analyze.py` as the only analysis entrypoint.
- Measure browser runtime behavior externally with CDP.
- Measure sandbox internals through the existing `runtime-metrics.js` counters.

## File Layout

- `performance-harness/run-browser-scenario.mjs`: CLI runner. It builds the
  browser bundle, serves a temporary static site, launches Chromium, samples CDP
  metrics, and writes CSV rows.
- `performance-harness/browser/webpack.browser.config.cjs`: browser webpack
  config factory. It creates either a native build or a sandbox build for the
  same scenario entry.
- `performance-harness/browser/bootstrap.js`: in-page bootstrap. It enables
  runtime metrics, dynamically imports the scenario, executes the configured
  workload repetitions, and publishes the final result on
  `window.__SANDBOX_PERF_RESULT__`.
- `performance-harness/browser/scenarios/marked/parser.scenario.js`: example
  marked parser workload.
- `performance-harness/browser/scenarios/failure/throw.scenario.js`: small
  intentional failure scenario used to verify failure-row behavior.
- `performance-harness/runtime-metrics.js`: shared counter and crossing
  instrumentation used by both Node and browser runs.
- `.sandbox/core/webapi-exposure.js`: records Web API exposure time and count.
- `performance-harness/analyze.py`: reads browser and Node CSV results and
  prints median summaries plus native-vs-sandbox wall-time overhead.

## Architecture

The harness has a build phase and a measured browser phase.

### Build Phase

`run-browser-scenario.mjs` creates a temporary static root under the system temp
directory and invokes webpack with `webpack.browser.config.cjs`.

In `native` mode:

- `WebpackSandboxPlugin` is not installed.
- Scenario imports resolve normally through `node_modules`.
- The output is `dist/browser-scenario.js` inside the temporary static root.

In `sandbox` mode:

- `WebpackSandboxPlugin` is installed.
- Imports matching configured sandbox libraries are replaced with generated
  proxy modules under `.sandbox/proxys/`.
- The CLI `--library` value is CSV metadata; actual redirection is controlled
  by `.sandbox/sandbox.config.js`. The runner fails early when `--mode sandbox`
  targets a library that is not enabled in that config, because otherwise the
  row would be labeled as sandboxed while running natively.
- The plugin child compiler emits isolated library bundles as
  `dist/<library>.bundle.js` under the same temporary static root.
- Browser proxies still fetch `/dist/<library>.bundle.js`, matching the
  existing proxy contract and avoiding a special browser-performance proxy path.

Webpack build time is not included in any measured runtime row. Measurement
starts only when the browser page loads the generated scenario bundle.

### Browser Runtime Phase

For each warmup or measured iteration, the runner:

1. Opens a fresh Playwright browser context and page.
2. Creates a page-scoped CDP session with `page.context().newCDPSession(page)`.
3. Enables the CDP `Performance` domain.
4. Navigates to the temporary static site.
5. Captures baseline `Performance.getMetrics`.
6. Starts polling `Performance.getMetrics` every `--sample-ms`.
7. Loads `/dist/browser-scenario.js` as a module script.
8. Waits for `window.__SANDBOX_PERF_RESULT__.status === "finished"`.
9. Captures final CDP metrics.
10. Closes the page context before the next iteration.

The fresh-page-per-iteration model keeps browser-side globals, module state,
QuickJS instances, and heap measurements isolated between runs.

### In-Page Bootstrap

`bootstrap.js` is the only in-browser entrypoint. It performs three important
tasks:

- Calls `setRuntimeMetricsEnabled(true)` before importing the scenario. This is
  necessary because sandbox proxy initialization uses top-level await; enabling
  metrics before the dynamic import ensures sandbox creation, Web API exposure,
  and bundle evaluation are captured.
- Runs the scenario workload. The preferred scenario contract is a default
  function:

  ```js
  export default function run() {}
  ```

  Object scenarios with optional `setup`, `run`, and `teardown` methods are also
  supported when a workload needs state prepared outside the measured section.
- Stores the final measured payload on `window.__SANDBOX_PERF_RESULT__`.

`wall_ms` is measured only around workload calls. Dynamic scenario import,
sandbox proxy initialization, scenario validation, optional `setup`, and
optional `teardown` are excluded from `wall_ms`. The `--repetitions` option
controls how many workload calls are made inside each measured run.

This is intentional for steady-state workload comparisons, but it means
top-level scenario code is not part of `wall_ms`. Scenario authors should treat
top-level code as fixture preparation only. Meaningful library work, such as
constructing parsers, validators, encoders, or other public API objects that a
normal user would create as part of the measured operation, should either happen
inside `run()` or be represented by a separate startup/setup measurement. If the
analysis needs the broader browser iteration cost, use `browser_elapsed_ms`
instead of `wall_ms`.

The browser runner treats this in-page payload as authoritative for:

- `wall_ms`
- `completed`
- `exit_code`
- sandbox `events`
- sandbox `crossings`

### CDP Metrics

The runner uses CDP only for external browser metrics. It reads:

- `JSHeapUsedSize`
- `TaskDuration`
- `ScriptDuration`

`TaskDuration` and `ScriptDuration` are reported by CDP in seconds, so the
runner converts deltas to milliseconds.

Browser memory is mapped into the existing heap columns:

- `peak_heap_used_mb`: peak polled `JSHeapUsedSize`.
- `final_heap_used_mb`: final `JSHeapUsedSize`.

Node-only process fields are set to `0` for browser rows:

- `cpu_user_ms`
- `cpu_system_ms`
- `peak_rss_mb`
- `peak_external_mb`
- `final_rss_mb`
- `final_external_mb`

## Runtime Metrics

`performance-harness/runtime-metrics.js` now supports two enablement paths:

- Node command runs still use `SANDBOX_PERF_ENABLED=1`.
- Browser runs call `setRuntimeMetricsEnabled(true)`.

The existing counter API remains unchanged for sandbox callers:

- `recordDuration`
- `incrementCounter`
- `recordMembraneCall`
- `recordMarshal`
- `recordUnmarshal`
- `recordCrossing`
- `observeWrappedReturn`
- `observeCreateInstance`
- `observeTempObjectCreated`
- `observeTempObjectReset`
- `getRuntimeMetricsSnapshot`

Browser sandbox runs also record:

- `webapi_expose_ms`: time spent exposing configured host Web APIs into the
  QuickJS arena.
- `webapi_exposed_count`: number of configured Web APIs actually present on the
  host and exposed to the arena.

For example, the checked-in `marked` sandbox config currently exposes
`console` and `localStorage` when those globals exist in Chromium.

## CSV Outputs

Browser results default to `performance-harness/results-browser/`.

The runner writes the same three CSV files used by the Node harness:

- `runs.csv`
- `events.csv`
- `crossings.csv`

### `runs.csv`

Browser rows preserve the existing run columns and append:

- `environment`: always `browser`.
- `browser_name`: always `chromium`.
- `scenario_path`: checked-in scenario module path.
- `repetitions`: workload executions per run.
- `browser_elapsed_ms`: elapsed time for one browser iteration, including
  page/context creation, navigation, scenario bundle loading, scenario import,
  setup, workload repetitions, teardown, final metric capture, and page/context
  cleanup. It excludes webpack compilation and HTTP server startup.
- `browser_task_ms`: CDP `TaskDuration` delta in milliseconds.
- `browser_script_ms`: CDP `ScriptDuration` delta in milliseconds.

### `events.csv`

Sandbox events include both existing and browser-added fields:

- `sandbox_create_ms`
- `bundle_eval_ms`
- `webapi_expose_ms`
- `webapi_exposed_count`
- `membrane_call_count`
- `membrane_call_ms`
- `marshal_count`
- `marshal_ms`
- `unmarshal_count`
- `unmarshal_ms`
- `wrap_returned_count`
- `create_instance_count`
- `temp_object_peak_count`

Native rows contain zeroes for sandbox-only event fields.

### `crossings.csv`

Crossing fields retain the existing structure:

- `host_to_vm_count`
- `vm_to_host_count`
- `host_to_vm_total_bytes`
- `vm_to_host_total_bytes`
- `crossing_size_median_bytes`
- `crossing_size_p95_bytes`
- `crossing_size_max_bytes`

Native rows contain zeroes because no QuickJS boundary is crossed.

## Usage

Install dependencies and Playwright Chromium:

```powershell
npm install
npx playwright install chromium
```

Run the marked browser scenario natively:

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode native `
  --library marked `
  --workload-id parser `
  --scenario performance-harness/browser/scenarios/marked/parser.scenario.js `
  --repetitions 100
```

Run the same checked-in scenario through the sandbox:

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode sandbox `
  --library marked `
  --workload-id parser `
  --scenario performance-harness/browser/scenarios/marked/parser.scenario.js `
  --repetitions 100
```

Use a smaller verification run:

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode sandbox `
  --library marked `
  --workload-id parser `
  --scenario performance-harness/browser/scenarios/marked/parser.scenario.js `
  --iterations 1 `
  --warmup 0 `
  --repetitions 100 `
  --out-dir performance-harness/results-browser-smoke
```

Analyze browser results with the shared analyzer:

```powershell
python performance-harness/analyze.py `
  --results-dir performance-harness/results-browser
```

The analyzer groups measured successful rows by
`environment/library/workload_id/repetitions/mode`. Browser summaries print wall
time, browser iteration elapsed time, browser task time, browser script time,
and peak JS heap. When both native and sandbox rows exist for the same browser
workload, the analyzer prints `wall_ratio`, `browser_elapsed_ratio`,
`browser_task_ratio`, `peak_heap_delta_mb`, and `peak_heap_ratio`.

For execution-time analysis, Spearman correlations use `wall_ratio` as the
overhead metric. For memory-overhead analysis, correlations use
`peak_heap_ratio`, calculated as sandbox peak JS heap divided by native peak JS
heap for the same workload. The memory-overhead section correlates
`peak_heap_ratio` with crossing count, median crossing size, p95 crossing size,
and total crossing bytes. Generated plots include a runtime overhead box plot
based on per-run sandbox/native ratios, with a shared-scale overview and
per-workload local detail panels, runtime overhead against crossing count and
total crossing bytes, and peak heap delta against crossing count and total
crossing bytes.

## CLI Reference

Required options:

- `--mode <native|sandbox>`: build and run mode.
- `--library <name>`: library metadata written to CSV and used for grouping.
  In sandbox mode, this library must also be enabled in
  `.sandbox/sandbox.config.js`.
- `--workload-id <id>`: workload metadata written to CSV and used for grouping.
- `--scenario <path>`: checked-in scenario module path.

Optional options:

- `--label <label>`: free-form CSV label.
- `--iterations <n>`: measured iterations, default `5`.
- `--warmup <n>`: warmup iterations, default `1`.
- `--repetitions <n>`: workload executions per run, default `1`.
- `--sample-ms <n>`: CDP polling interval, default `100`.
- `--out-dir <path>`: CSV output directory, default
  `performance-harness/results-browser`.

## Adding a Scenario

Create a module under `performance-harness/browser/scenarios/<library>/`.

Example:

```js
import { marked } from "marked";

const markdown = "# hello\n\n**world**";

export default function run() {
  const html = marked.parse(markdown);
  if (!html.includes("<h1")) {
    throw new Error("Unexpected parser output.");
  }
}
```

Guidelines:

- Keep the same imports for native and sandbox runs.
- Keep scenarios as simple workload scripts.
- Keep top-level code limited to fixture preparation that is intentionally
  excluded from `wall_ms`.
- Put meaningful library API work inside `run()` when it should count as part
  of the measured workload. Examples include parser construction, schema
  construction, encoder setup, and other public object creation that normal
  usage performs during the operation being evaluated.
- Use object scenarios with optional `setup`, `run`, and `teardown` methods
  only when state preparation is intentionally outside the steady-state
  workload. Document that choice in the scenario or evaluation notes.
- Use `--repetitions` to make the measured section large enough for stable
  browser timings.
- Validate output in the workload; failures are recorded as CSV rows with
  `exit_code != 0` and `completed=false`.
- Avoid reading files or reaching external networks from browser scenarios.
  Browser scenarios are served from a temporary local static root.

## Failure Behavior

If a scenario throws, the bootstrap still writes
`window.__SANDBOX_PERF_RESULT__` with:

- `completed=false`
- `exit_code=1`
- the measured wall time up to the failure
- runtime event and crossing snapshots collected before the failure

The runner still appends rows to all three CSV files, so failed runs remain
visible in raw data. The analyzer excludes failed measured rows from median and
overhead summaries.

The checked-in failure scenario can be used to verify this behavior:

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode native `
  --library marked `
  --workload-id intentional-failure `
  --scenario performance-harness/browser/scenarios/failure/throw.scenario.js `
  --iterations 1 `
  --warmup 0 `
  --out-dir performance-harness/results-browser-failure
```

## Interpretation Notes

- `wall_ms` is measured inside the page and includes only the repeated workload
  calls controlled by `--repetitions`. Dynamic scenario import, sandbox proxy
  initialization, setup, and teardown are excluded.
- `browser_elapsed_ms` is the broader per-iteration browser runtime. Use it
  when comparing against external stopwatch timings for the browser command,
  while remembering that webpack compilation is still outside this field.
- Webpack compilation, proxy generation, and temporary HTTP server startup are
  intentionally excluded from `wall_ms`.
- In sandbox mode, top-level proxy initialization is recorded in sandbox event
  metrics such as `sandbox_create_ms` and `bundle_eval_ms`, but it is not part
  of `wall_ms`.
- `browser_task_ms` reflects Chromium main-thread task time and may exceed or
  differ from in-page `wall_ms` because it is an external browser metric.
- `browser_script_ms` only reflects CDP script execution accounting; sandbox
  QuickJS execution time is better interpreted through `wall_ms`,
  `membrane_call_ms`, and crossing metrics.
- A single measured iteration is useful for smoke tests, but thesis evaluation
  runs should use warmup runs, multiple measured iterations, and a repetition
  count large enough for stable timings.
