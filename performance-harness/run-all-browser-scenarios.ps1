param(
  [ValidateSet("native", "sandbox", "both")]
  [string]$Mode = "both",

  [int]$Iterations = 5,
  [int]$Warmup = 1,
  [int]$Repetitions = 50,
  [int]$SampleMs = 100,
  [string]$OutDir = "performance-harness/results-browser"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$scenarios = @(
  @{ Library = "lodash"; WorkloadId = "collection"; Scenario = "performance-harness/browser/scenarios/lodash/collection.scenario.js" }
  @{ Library = "lodash"; WorkloadId = "collection-adapter"; Scenario = "performance-harness/browser/scenarios/lodash/collection-adapter.scenario.js" }
  @{ Library = "marked"; WorkloadId = "parser"; Scenario = "performance-harness/browser/scenarios/marked/parser.scenario.js" }
  @{ Library = "zod"; WorkloadId = "validation"; Scenario = "performance-harness/browser/scenarios/zod/validation.scenario.js" }
  @{ Library = "zod"; WorkloadId = "validation-adapter"; Scenario = "performance-harness/browser/scenarios/zod/validation-adapter.scenario.js" }
  @{ Library = "date-fns"; WorkloadId = "calendar"; Scenario = "performance-harness/browser/scenarios/date-fns/calendar.scenario.js" }
  @{ Library = "image-js"; WorkloadId = "transform"; Scenario = "performance-harness/browser/scenarios/image-js/transform.scenario.js" }
  @{ Library = "luxon"; WorkloadId = "scheduling"; Scenario = "performance-harness/browser/scenarios/luxon/scheduling.scenario.js" }
  @{ Library = "mime"; WorkloadId = "lookup"; Scenario = "performance-harness/browser/scenarios/mime/lookup.scenario.js" }
  @{ Library = "strip-ansi"; WorkloadId = "clean"; Scenario = "performance-harness/browser/scenarios/strip-ansi/clean.scenario.js" }
  @{ Library = "tweetnacl"; WorkloadId = "signature"; Scenario = "performance-harness/browser/scenarios/tweetnacl/signature.scenario.js" }
  @{ Library = "yup"; WorkloadId = "validation"; Scenario = "performance-harness/browser/scenarios/yup/validation.scenario.js" }
)

$modes = if ($Mode -eq "both") { @("native", "sandbox") } else { @($Mode) }

foreach ($scenario in $scenarios) {
  foreach ($currentMode in $modes) {
    Write-Host "Running $($scenario.Library)/$($scenario.WorkloadId) in $currentMode mode..."

    node performance-harness/run-browser-scenario.mjs `
      --mode $currentMode `
      --library $scenario.Library `
      --workload-id $scenario.WorkloadId `
      --scenario $scenario.Scenario `
      --iterations $Iterations `
      --warmup $Warmup `
      --repetitions $Repetitions `
      --sample-ms $SampleMs `
      --out-dir $OutDir

    if ($LASTEXITCODE -ne 0) {
      throw "Performance runner failed for $($scenario.Library)/$($scenario.WorkloadId) in $currentMode mode."
    }
  }
}

Write-Host "Performance measurements written to $OutDir"
