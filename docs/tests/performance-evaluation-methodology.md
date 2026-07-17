# Performance Evaluation Methodology

**Status:** Investigation draft  
**Scope:** Experimental performance evaluation for thesis work  
**Results:** To be added later

## Purpose

This document defines the methodology used to evaluate the performance impact of isolating third-party npm libraries inside the `spike-quickjs` sandbox.

The goal of this evaluation is not to introduce a production performance monitoring subsystem into the main implementation. Instead, it is to support the dissertation work by answering the following questions:

- What is the end-to-end overhead of executing a library inside the sandbox instead of executing it natively?
- Is the observed overhead small enough for the approach to remain usable in realistic scenarios?
- Where does the overhead come from, especially across the host/sandbox membrane boundary?
- Which kinds of libraries or workloads are more sensitive to sandboxing costs?

The instrumentation described here is therefore considered research-oriented and intrusive. It exists to explain behavior and quantify overhead, not to become part of the final production-ready branch.

## Instrumentation Added for Investigation

The performance evaluation branch introduces a dedicated measurement harness under `performance-harness/`.

This harness is responsible for:

- running native and sandboxed versions of the same workload
- collecting coarse process-level metrics such as wall-clock time, CPU usage, and memory usage
- collecting internal diagnostic metrics related to sandbox initialization, membrane calls, marshalling, unmarshalling, and boundary crossings
- exporting structured measurements for later aggregation and analysis

The instrumentation currently targets two different levels of observation:

### 1. External scenario-level measurement

These measurements characterize the cost of a complete browser usage scenario.
The same scenario function is executed natively and through the sandbox.

### 2. Internal diagnostic measurement

These measurements are intended to explain where the overhead is introduced inside the sandboxed execution path. They include counters and timing values associated with the membrane and with object/value transfers across the boundary between the host and the QuickJS VM.

Because these internal measurements add extra work to the execution path, they are useful for diagnosis and interpretation, but they must not be treated as entirely non-intrusive.

## Evaluated Architecture

The evaluated architecture is the current sandboxing prototype implemented in this repository:

- third-party libraries are bundled at build time through the webpack sandbox plugin
- each configured library is redirected to a generated proxy module
- the proxied library executes inside its own QuickJS WebAssembly context
- selected APIs are exposed to the sandbox according to the sandbox configuration
- data and callable values cross the host/sandbox boundary through membrane wrappers and custom marshalling logic

From a performance perspective, the most relevant architectural components are:

- sandbox creation and QuickJS context initialization
- library bundle evaluation inside the VM
- generated proxy modules and their top-level initialization
- forward and reverse membrane operations
- marshalling and unmarshalling of values, especially complex objects and binary data
- temporary object management used to preserve behavior such as method binding and object identity

The main comparison in this methodology is:

- native execution of a library scenario in Chromium
- sandboxed execution of the same workload through the QuickJS-based isolation layer

## Candidate Libraries and Workload Diversity

The evaluation is intended to cover multiple library profiles instead of relying on a single synthetic benchmark. The selected libraries should represent different data shapes, execution styles, and pressure points for the sandbox boundary.

The current candidate set includes libraries already being exercised through compatibility work, such as:

- `strip-ansi` for lightweight string processing
- `marked` for parser-oriented workloads with object-rich interactions
- `lodash` for broad utility usage and large API surface
- `date-fns`, `dayjs`, and `luxon` for date/time manipulation
- `zod` and `yup` for schema validation and object traversal
- `mime` for lightweight structured lookup behavior
- `mnemonist` for stateful data-structure behavior
- `tweetnacl-js` for binary-heavy cryptographic operations
- `image-js` for large payloads and typed-array-intensive workloads

These libraries were chosen because together they exercise different aspects of the architecture, including:

- simple scalar argument passing
- nested object traversal
- stateful instances and method calls
- repeated membrane crossings
- asynchronous behavior
- `TypedArray`, `ArrayBuffer`, and binary payload transfer
- workloads that may stress object identity and temporary proxy state

## Metrics

The evaluation is divided into coarse-grained metrics for headline comparisons and fine-grained metrics for diagnostic analysis.

### Coarse-Grained Scenario Metrics

These metrics describe the total cost of executing a workload:

- total wall-clock execution time for the whole scenario
- CPU usage for the process
- peak memory usage during execution
- final memory usage after execution
- completion status of the scenario

These metrics are the primary basis for comparing native and sandboxed execution from an end-user or deployer perspective.

For memory overhead, the browser analysis uses `peak_heap_ratio`: the sandbox
peak JS heap divided by the native peak JS heap for the same workload. This
ratio is the dependent variable for memory-overhead correlation analysis,
because it directly expresses how much additional peak heap the sandboxed run
uses relative to native execution.

Each browser scenario exports one function that represents a complete, typical
use of the library. The function includes all relevant library work, including
construction of schemas, parsers, keys, images, or validators. Top-level code is
restricted to deterministic, library-independent fixtures.

The harness executes the complete scenario function a configured number of
times per browser iteration:

- `scenario_total_ms` measures the complete batch.
- `scenario_ms = scenario_total_ms / repetitions` measures one normalized
  scenario execution.
- `browser_elapsed_ms` covers the broader browser iteration.
- `browser_non_scenario_ms = browser_elapsed_ms - scenario_total_ms` estimates
  the browser time outside the scenario batch.

The residual `browser_non_scenario_ms` includes page creation, navigation,
scenario import, sandbox/proxy initialization, CDP collection, and context
cleanup. It must not be interpreted as a pure import-time measurement.

### Internal Diagnostic Metrics

These metrics describe internal sources of overhead in the sandboxed path:

- sandbox creation time
- library bundle evaluation time
- number of membrane calls
- cumulative membrane call time
- number of marshal operations
- cumulative marshal time
- number of unmarshal operations
- cumulative unmarshal time
- number of wrapped returned values
- number of constructor-based instance creations
- peak count of temporary tracked objects

The aggregate forms retain all activity. `startup_` variants attribute metrics
to scenario import and sandbox initialization, while `scenario_` variants cover
the repeated complete scenarios. Cumulative `scenario_` counts, durations,
crossing counts, and crossing bytes are divided by `repetitions` during
analysis. Payload-size percentiles and peak metrics are not divided.

### Boundary Traffic Metrics

To better understand data movement across the membrane, the evaluation also records estimated characteristics of values that cross the boundary:

- number of host-to-VM crossings
- number of VM-to-host crossings
- total estimated bytes transferred from host to VM
- total estimated bytes transferred from VM to host
- estimated median crossing payload size
- estimated p95 crossing payload size
- estimated maximum crossing payload size

These size-oriented metrics are especially relevant to workloads that manipulate deep objects, collections, and binary buffers.

The same metric family is retained separately for the reverse membrane, where
host scenario code accesses QuickJS exports, and the forward membrane, where
sandboxed code accesses exposed host Web APIs. Forward measurements cover
function and constructor arguments, successful return values, getters, and
setters. Each crossing represents one transferred value, so a call with
multiple arguments produces multiple crossings.

Columns without a membrane prefix combine forward and reverse traffic.
Direction names remain physical: `host_to_vm` means a value enters QuickJS and
`vm_to_host` means a value leaves QuickJS. Consequently, forward arguments are
`vm_to_host`, while forward results are `host_to_vm`.

## Interpretation Notes

The metrics in this document do not all have the same methodological role.

- Coarse-grained scenario metrics are used to support overall overhead claims.
- Internal diagnostic metrics are used to explain where the overhead likely originates.
- Crossing-size estimates are heuristic and should be interpreted as approximate indicators rather than exact byte-accurate transfer measurements.
- Overall execution overhead is
  `median(sandbox scenario_ms) / median(native scenario_ms)`.
- The 95% confidence interval is calculated from 10,000 independent bootstrap
  resamples of the native and sandbox medians, using a fixed seed.
- Runtime correlations use `scenario_ratio` and normalized `scenario_`
  diagnostic metrics.
- Memory overhead correlations use `peak_heap_ratio` against crossing count,
  median crossing size, p95 crossing size, total crossing bytes, and the
  direction-specific host-to-VM and VM-to-host crossing counts and byte totals.
- Direction-specific correlations help identify whether overhead aligns more
strongly with traffic entering the VM or leaving it, but they still show
association rather than proving that one membrane path is intrinsically more
expensive.
- Membrane-specific correlations compare the combined results with forward and
  reverse crossing counts and estimated byte totals. Web API exposure time
  remains a startup metric and must not be interpreted as the recurring cost
  of forward membrane use.

The membrane-specific crossing schema is intentionally incompatible with older
result directories. Existing complete measurements remain valid for their
original analysis, but they cannot support forward/reverse decomposition.

This distinction is important because the diagnostic instrumentation itself can influence the measured execution cost. For that reason, the final analysis should clearly separate end-to-end claims from explanatory internal measurements.

## Collection Order

Each scenario/mode combination retains the configured block of warmup and
measured iterations. A fresh browser context and page are created for every
iteration, while the Chromium process is reused within that combination.

To reduce systematic order effects without introducing a more complex
round-based experiment, the batch collection:

- randomizes the order of the 14 scenarios using a seeded Fisher-Yates shuffle;
- keeps the native and sandbox executions of each scenario adjacent;
- alternates which mode is executed first between successive shuffled
  scenarios;
- assigns native-first and sandbox-first order to seven scenarios each;
- writes the seed and exact effective order to `collection-plan.csv`.

This counterbalancing prevents sandbox from always occupying the second
position and distributes gradual temporal effects across both modes. It does
not make observations perfectly independent, so residual effects from system
load, caching, CPU temperature, and process reuse remain threats to validity.

## Workload Adapter Comparison

The Lodash collection, Zod validation, Luxon scheduling, and Image.js transform
scenarios are also evaluated through explicit coarse-grained workload adapters.
For each library, the dedicated comparison reports two sandbox/native ratios:

- transparent sandbox access through the generated library proxy;
- one coarse-grained call to developer-written workload code inside QuickJS.

Adapter scenarios are excluded from general overhead, distribution,
correlation, and memory-diagnostic plots. They appear only in the grouped
`workload_adapter_overhead.png` chart so that the effect of moving chatty
operations behind one sandbox boundary is not mixed with the general library
results.

The general runtime bar chart is the comparison of overhead magnitude across
libraries. Bootstrap distributions are presented separately in numbered panels,
ordered by decreasing median overhead. The main distribution panels use a
shared linear 0x-100x vertical scale, which keeps the common 25x-50x range
legible while preserving a consistent scale for the majority of scenarios.
Distributions whose robust upper limit exceeds 100x are emitted in separate
outlier panels with a scale shared only by those outliers. The distribution
panels omit the native `1x` reference line and report only the median and 95%
confidence interval. All visible plot text is generated in Portuguese for
inclusion in the dissertation.

For Luxon, the adapter moves the date/time object graph and method sequence
behind one reverse-membrane call. Luxon's configured `Intl` capability remains
host-provided, so forward-membrane traffic can remain present in the adapter
variant. This separates the cost of transparent host access to Luxon objects
from the cost of the host capabilities used internally by Luxon.

For Image.js, both variants receive the same encoded PNG bytes and perform the
same decode, crop, greyscale, blur, histogram, and mean operations. The adapter
moves that complete pipeline behind one workload call and returns only scalar
validation data. Its results are collected for exploratory comparison; whether
they support a dissertation claim is decided only after the measurements are
analyzed.

## Planned Documentation Additions

The following sections will be completed later as results become available:

- benchmark scenarios and workload definitions
- execution procedure and repetition strategy
- environment and machine configuration
- collected results
- analysis of overhead sources
- conclusions regarding practical usability
