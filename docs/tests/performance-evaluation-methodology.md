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

These measurements are intended to characterize the total cost of running a workload from the perspective of the Node process. They are collected with minimal dependence on the internal implementation details of the sandbox.

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

- native execution of a library workload in Node.js
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

For browser scenarios, `wall_ms` has a narrower meaning than a full external
stopwatch measurement. It covers only the repeated workload function executed by
the in-page bootstrap. Scenario module import, top-level scenario code,
sandbox proxy initialization, optional setup, optional teardown, page creation,
navigation, and cleanup are excluded from `wall_ms`. The broader
`browser_elapsed_ms` field covers the browser iteration around those steps,
while still excluding webpack compilation and HTTP server startup.

This split is deliberate: `wall_ms` supports steady-state workload comparisons,
and `browser_elapsed_ms` supports broader browser-iteration comparisons. When a
scenario performs meaningful library API work outside `run()`, that work must be
classified explicitly. Fixture generation may remain outside `run()`, but
normal usage work such as constructing parsers, schemas, validators, encoders,
or other public API objects should be moved into `run()` if it belongs to the
measured operation. If that initialization is intentionally excluded, the
evaluation text must say so and should not describe `wall_ms` as the full
scenario cost.

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

## Interpretation Notes

The metrics in this document do not all have the same methodological role.

- Coarse-grained scenario metrics are used to support overall overhead claims.
- Internal diagnostic metrics are used to explain where the overhead likely originates.
- Crossing-size estimates are heuristic and should be interpreted as approximate indicators rather than exact byte-accurate transfer measurements.
- Execution overhead correlations use runtime ratios such as `wall_ratio`.
- Memory overhead correlations use `peak_heap_ratio` against crossing count,
  median crossing size, p95 crossing size, and total crossing bytes.

This distinction is important because the diagnostic instrumentation itself can influence the measured execution cost. For that reason, the final analysis should clearly separate end-to-end claims from explanatory internal measurements.

## Planned Documentation Additions

The following sections will be completed later as results become available:

- benchmark scenarios and workload definitions
- execution procedure and repetition strategy
- environment and machine configuration
- collected results
- analysis of overhead sources
- conclusions regarding practical usability
