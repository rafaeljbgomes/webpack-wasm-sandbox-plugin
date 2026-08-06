# Webpack WASM Sandbox Plugin — Benchmarking Branch

This branch contains the instrumented runtime and browser harness used to
evaluate the performance of `webpack-wasm-sandbox-plugin`. It is not the
normal implementation branch and must not be used as the production-oriented
baseline for the sandbox.

The canonical project overview, architecture, security evaluation, and
compatibility workflow are maintained on
[`main`](https://github.com/rafaeljbgomes/webpack-wasm-sandbox-plugin/tree/main).
This branch adds only the measurement-specific implementation, scenarios, and
methodology required for the dissertation performance evaluation.

## Performance evaluation

The benchmark instruments forward and reverse membrane crossings, executes
checked-in scenarios in Chromium, and records browser measurements for later
analysis. It also includes workload-adapter scenarios for Image.js, Lodash,
Luxon, and Zod.

Follow [the performance harness guide](performance-harness/README.md) for the
environment, collection commands, CSV contract, and analysis workflow. Do not
run its collection commands on `main`: this branch alone contains the required
instrumentation and workload adapters.

The benchmark policy in `.sandbox/sandbox.config.js` enables the ten evaluated
libraries and declares the four branch-exclusive workload adapters. Generated
bundles and `performance-harness/results*` remain ignored and must not be
committed.

## Acknowledgements

Developed by Rafael Gomes under the academic supervision of Professor Nuno
Pereira ([Nuno Pereira](https://github.com/nampereira)), ISEP. The supervisor
provided guidance on the research direction and selected design decisions.
