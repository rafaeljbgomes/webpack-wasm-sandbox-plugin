# Chromium Browser Performance Harness

The browser harness executes the same checked-in scenario in two modes:

- `native`: imports resolve to the npm package.
- `sandbox`: webpack redirects configured imports to generated QuickJS proxies.

The first browser evaluation is intentionally limited to headless Chromium. The
runner uses Playwright for execution and Chrome DevTools Protocol (CDP) for
external browser metrics.

## Architecture

`run-browser-scenario.mjs` builds the browser bundle once per command. Webpack
compilation, proxy generation, HTTP server startup, and Chromium process launch
are outside every measured row.

For each warmup or measured iteration, the runner:

1. Creates a fresh browser context and page.
2. Enables the CDP `Performance` domain.
3. Navigates to the temporary static site.
4. Captures baseline CDP metrics.
5. Loads the generated scenario bundle.
6. Waits for the in-page scenario result.
7. Captures final CDP metrics.
8. Closes the browser context.

Fresh contexts isolate module state, QuickJS instances, and heap measurements
between iterations.

The in-page bootstrap enables runtime instrumentation before dynamically
importing the scenario. Import-time sandbox creation, bundle evaluation, proxy
initialization, and Web API exposure are therefore attributed to the `startup`
phase. It then switches to the `scenario` phase and invokes the complete
scenario function `repetitions` times.

## Scenario Contract

A scenario must export exactly one default function:

```js
import { Marked } from "marked";

const markdown = "# Example";

export default function run() {
  const parser = new Marked({ gfm: true });
  const html = parser.parse(markdown);

  if (!html.includes("<h1")) {
    throw new Error("Unexpected output.");
  }
}
```

One function call is the unit of work and must represent one complete, typical
use of the library.

Scenario rules:

- Keep imports identical between native and sandbox modes.
- Keep top-level code limited to deterministic, library-independent fixtures.
- Put every evaluated library operation inside the function.
- Recreate schemas, parsers, validators, keys, and images when their creation
  belongs to the typical use being evaluated.
- Validate outputs so functional failures are visible in the CSV.
- Do not read external files or access external networks.

Object exports with `setup`, `run`, or `teardown` are rejected.

For image-processing scenarios, prefer a checked-in encoded fixture over
constructing an image pixel by pixel through the public API. A suitable fixture
should be small enough for stable repeated measurements, use a common format
such as PNG or JPEG, contain multiple color channels, include both smooth
gradients and high-contrast edges, and be large enough for meaningful crop and
filter operations. Encoded bytes may be prepared at module startup, while
decoding and the evaluated transformations belong inside the scenario function.

## Timing Metrics

The in-page bootstrap reports:

- `scenario_total_ms`: total time of all attempted scenario calls.
- `scenario_ms`: `scenario_total_ms / repetitions`.
- `completed_repetitions`: calls that returned successfully.
- `completed`: true only when every configured call completed.
- `exit_code`: `0` on complete success and `1` otherwise.

The external runner adds:

- `browser_elapsed_ms`: complete browser iteration around page creation,
  navigation, import, scenario execution, final metric collection, and cleanup.
- `browser_non_scenario_ms`: `browser_elapsed_ms - scenario_total_ms`.
- `browser_task_ms`: CDP `TaskDuration` delta.
- `browser_script_ms`: CDP `ScriptDuration` delta.
- `peak_heap_used_mb` and `final_heap_used_mb`: CDP JS heap measurements.

`browser_non_scenario_ms` is a residual browser cost. It includes import and
sandbox initialization, but also page lifecycle, CDP, and cleanup work. It is
not a pure import-time metric.

## Internal Metrics

`runtime-metrics.js` retains aggregate event and crossing fields and records
phase-prefixed variants:

- `startup_*`: activity during dynamic import and sandbox initialization.
- `scenario_*`: activity during all complete scenario calls in the batch.

Event metrics include sandbox creation, bundle evaluation, Web API exposure,
membrane calls, custom marshalling, returned-object wrapping, instance creation,
and peak temporary-object count.

Crossing metrics distinguish the two membrane paths:

- `reverse`: host scenario code calling exports and objects inside QuickJS;
- `forward`: sandboxed code calling host Web APIs exposed to QuickJS.

Each path records direction-specific counts and estimated bytes, plus median,
p95, and maximum estimated payload sizes. Forward instrumentation covers
function and constructor arguments, successful results, property getters, and
property setters. A crossing count represents one transferred value, not one
function or Web API call.

Columns without a membrane prefix are combined totals. `forward_*` and
`reverse_*` columns provide the decomposition.

During analysis:

- cumulative scenario counts, durations, and bytes are divided by
  `repetitions`;
- crossing-size percentiles and maximums are not divided;
- peak heap and peak temporary-object metrics are not divided.

Custom marshalling counters cover only configured custom
marshaller/unmarshaller paths. `crossings.csv` is the broader host/VM traffic
estimate. Payload bytes are heuristic structural estimates rather than
byte-accurate serialization measurements.

## CSV Schema

Results default to `performance-harness/results-browser-scenarios`.

### `runs.csv`

The principal fields are:

- `library`, `workload_id`, and `scenario_variant`;
- `mode`, `iteration`, and `warmup`;
- `scenario_total_ms`, `scenario_ms`, and `completed_repetitions`;
- `repetitions`;
- `browser_elapsed_ms` and `browser_non_scenario_ms`;
- CDP task, script, and heap metrics;
- completion and failure fields.

`scenario_variant` is:

- `transparent` for normal generated-library-proxy scenarios;
- `workload` for explicit coarse-grained workload adapters.

### `events.csv` and `crossings.csv`

Both files contain aggregate fields and `startup_`/`scenario_` variants. Native
rows contain zeroes for sandbox-only metrics. The crossing schema contains
combined fields and corresponding `forward_*` and `reverse_*` fields.

The schema is not append-compatible with either the previous
`setup_ms`/`run_ms`/`workload_ms` browser schema or crossing files created
before membrane-specific fields were introduced. Use a new output directory.

## CLI

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode sandbox `
  --library marked `
  --workload-id parser `
  --variant transparent `
  --scenario performance-harness/browser/scenarios/marked/parser.scenario.js `
  --iterations 10 `
  --warmup 2 `
  --repetitions 10 `
  --sample-ms 100 `
  --out-dir performance-harness/results-browser-scenarios
```

Options:

- `--mode <native|sandbox>`;
- `--library <name>`;
- `--workload-id <id>`;
- `--variant <transparent|workload>`, default `transparent`;
- `--scenario <path>`;
- `--iterations <n>`, default `5`;
- `--warmup <n>`, default `1`;
- `--repetitions <n>`, default `1`;
- `--sample-ms <n>`, default `100`;
- `--out-dir <path>`.

The batch script uses 10 measured iterations, 2 warmups, and 10 complete
scenario repetitions by default.

### Batch Execution Order

The batch runner randomizes the 14-scenario order with a seeded Fisher-Yates
shuffle. The default seed is `20260613` and can be changed with `-Seed`.

When `-Mode both` is used, mode order is counterbalanced across the shuffled
scenario sequence:

- scenario positions 1, 3, 5, ... use `native` then `sandbox`;
- scenario positions 2, 4, 6, ... use `sandbox` then `native`.

With 14 scenarios, the two modes occupy the first position seven times each.
The two modes of one scenario remain adjacent, while no mode is systematically
measured second across the collection.

The script writes `collection-plan.csv` before executing measurements. This file
records the seed, exact order, collection parameters, and scenario metadata.
Use `-PlanOnly` to generate and inspect the plan without launching Chromium.
The output directory must not already contain measurement CSV files, because
mixing separate collection orders would make the recorded plan ambiguous.

## Analysis

The analyzer supports only this browser schema. For each matching native and
sandbox group, it calculates:

```text
scenario_ratio =
  median(sandbox scenario_ms) / median(native scenario_ms)
```

The 95% confidence interval is obtained from 10,000 independent bootstrap
resamples of the native and sandbox medians with a fixed seed. Native and
sandbox rows are not paired by ordinal position.

The ten transparent scenarios feed the general overhead, distribution,
crossing, marshalling, and memory plots. Combined crossing plots are retained,
with additional forward/reverse count and byte plots. The Lodash, Zod, Luxon,
and Image.js workload adapter rows are excluded from those plots and appear
only in `workload_adapter_overhead.png`, which compares transparent and
workload sandbox/native ratios with bootstrap error bars.

## Failure Behavior

If a scenario throws, the bootstrap publishes the elapsed batch time,
`completed_repetitions`, the serialized error, and metrics collected before the
failure. Failed rows remain in all CSV files but are excluded from overhead
summaries.

The checked-in failure scenario throws on its second call:

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode native `
  --library marked `
  --workload-id intentional-failure `
  --scenario performance-harness/browser/scenarios/failure/throw.scenario.js `
  --iterations 1 `
  --warmup 0 `
  --repetitions 2 `
  --out-dir performance-harness/results-browser-failure
```
