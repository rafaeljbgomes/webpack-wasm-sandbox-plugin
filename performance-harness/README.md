# Performance Harness

The thesis performance evaluation uses the Chromium browser harness:

- `run-browser-scenario.mjs` builds one checked-in scenario in native or
  sandbox mode, executes it in headless Chromium, and writes CSV rows.
- `run-all-browser-scenarios.ps1` collects all 14 checked-in scenarios.
- `analyze.py` analyzes the browser CSV schema and generates the evaluation
  plots.

The older Node command harness remains available for exploratory work, but
`analyze.py` now expects the browser scenario schema only.

## Sandbox Policy Scope

The branch policy in `.sandbox/sandbox.config.js` enables the ten libraries
evaluated by the project and retains the minimum capability permissions used on
`main`. Unlike `main`, this branch also declares the four workload adapters
used by the benchmark: Image.js `transform`, Lodash `collection`, Luxon
`scheduling`, and Zod `validation`. Those workload declarations and their
instrumented runtime support are exclusive to `feat/sandbox-benchmarking`.

Do not copy this policy to `main`: the workload source modules and performance
instrumentation are intentionally absent there.

## Scenario Contract

Every browser scenario exports one default function. One call represents one
complete, typical use of the evaluated library:

```js
import { Marked } from "marked";

const markdown = "# Example";

export default function run() {
  const parser = new Marked({ gfm: true });
  const html = parser.parse(markdown);

  if (!html.includes("<h1")) {
    throw new Error("Unexpected parser output.");
  }
}
```

Top-level code may prepare deterministic, library-independent input fixtures.
All evaluated library operations, including schemas, parsers, images, keys, and
validators, belong inside the exported function.

Within each browser iteration, the harness invokes the complete function
`--repetitions` times. It records:

- `scenario_total_ms`: total time of the complete batch.
- `scenario_ms`: normalized time per scenario.
- `completed_repetitions`: calls completed before success or failure.
- `browser_elapsed_ms`: broader external browser iteration time.
- `browser_non_scenario_ms`: `browser_elapsed_ms - scenario_total_ms`.

`browser_non_scenario_ms` includes page creation, navigation, scenario import,
sandbox/proxy initialization, CDP collection, and context cleanup. It is not a
pure import-time measurement.

## Run Browser Scenarios

Run one scenario:

```powershell
node performance-harness/run-browser-scenario.mjs `
  --mode sandbox `
  --library marked `
  --workload-id parser `
  --variant transparent `
  --scenario performance-harness/browser/scenarios/marked/parser.scenario.js `
  --iterations 10 `
  --warmup 2 `
  --repetitions 10
```

Run all checked-in scenarios in native and sandbox modes:

```powershell
.\performance-harness\run-all-browser-scenarios.ps1
```

The batch runner uses a seeded Fisher-Yates shuffle for the 14 scenarios. When
both modes are requested, it alternates the order within successive scenarios:
`native`/`sandbox`, then `sandbox`/`native`. This assigns each mode to the first
position seven times and avoids always measuring sandbox second.

The default seed is `20260613`. Override it with `-Seed`, and retain the
generated `collection-plan.csv` with the result CSV files. The plan records the
seed, effective execution order, scenario variant, mode, and collection
parameters.

The batch runner refuses output directories that already contain `runs.csv`,
`events.csv`, or `crossings.csv`, preventing measurements collected with
different execution orders from being appended together.

Inspect or archive an execution plan without running Chromium:

```powershell
.\performance-harness\run-all-browser-scenarios.ps1 `
  -Seed 20260613 `
  -PlanOnly `
  -OutDir performance-harness/results-browser-plan
```

The default output directory is
`performance-harness/results-browser-scenarios`. This schema is intentionally
not compatible with older `setup`/`run` browser CSVs or crossing files without
forward/reverse membrane fields.

For a smoke run:

```powershell
.\performance-harness\run-all-browser-scenarios.ps1 `
  -Iterations 1 `
  -Warmup 0 `
  -Repetitions 2 `
  -OutDir performance-harness/results-browser-smoke
```

## Analyze Results

Activate the checked-in environment and run:

```powershell
. .\performance-harness\performance_analysis\Scripts\Activate.ps1
python performance-harness/analyze.py `
  --results-dir performance-harness/results-browser-scenarios
```

The analyzer:

- calculates `median(sandbox scenario_ms) / median(native scenario_ms)`;
- produces a 95% confidence interval from 10,000 independent bootstrap
  resamples with a fixed seed;
- normalizes cumulative scenario counters, durations, crossing counts, and
  crossing bytes by `repetitions`;
- leaves payload-size percentiles and peak metrics unnormalized;
- retains combined crossing metrics and decomposes them into `forward_*` and
  `reverse_*` metrics;
- generates overhead and heap plots for forward/reverse crossing counts and
  estimated bytes;
- excludes workload adapters from all general plots and correlations;
- compares transparent and workload-adapter overhead only in
  `workload_adapter_overhead.png`.

General plots cover the ten transparent scenarios. The workload comparison
in `workload_adapter_overhead.png` contains only the Lodash `collection` and
Zod `validation` pairs. Luxon `scheduling` and Image.js `transform` remain in
the collected data and overhead summaries, but are excluded from this aggregate
comparison so they can be analyzed separately if needed.

Plot titles, axes, legends, and annotations are generated in Portuguese for
direct use in the dissertation. Bootstrap overhead distributions are sorted by
decreasing median overhead and grouped into numbered panels under
`plots/runtime_overhead_distributions/`. The main distribution panels use a
shared linear 0x-100x scale so the common 25x-50x range remains legible.
Distributions whose robust upper limit exceeds 100x are emitted separately as
`distribuicao_overhead_outliers_*.png` with a scale shared only by those
outliers. `runtime_overhead.png` remains the cross-library magnitude
comparison. Each subplot reports the median and 95% confidence interval,
without the bootstrap sample count or the native `1x` reference line.

In `crossings.csv`, a crossing count represents a transferred value rather than
a Web API call. Forward crossings cover exposed Web API function/constructor
arguments, successful results, getters, and setters. Reverse crossings cover
host access to QuickJS exports and returned objects. Unprefixed fields are the
sum of both membrane paths.
