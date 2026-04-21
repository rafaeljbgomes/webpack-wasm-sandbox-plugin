# Performance Harness

This harness wraps an existing Node test command, injects a runtime metrics hook,
and appends summarized results to CSV files under `performance-harness/results/`.

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

```powershell
python performance-harness/analyze.py --results-dir performance-harness/results
```
