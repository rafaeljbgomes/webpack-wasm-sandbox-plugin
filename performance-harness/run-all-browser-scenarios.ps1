param(
  [ValidateSet("native", "sandbox", "both")]
  [string]$Mode = "both",

  [int]$Iterations = 10,
  [int]$Warmup = 2,
  [int]$Repetitions = 10,
  [int]$SampleMs = 100,
  [string]$OutDir = "performance-harness/results-browser-scenarios",
  [int]$Seed = 20260613,
  [switch]$PlanOnly
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$scenarios = @(
  @{ Library = "lodash"; WorkloadId = "collection"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/lodash/collection.scenario.js" }
  @{ Library = "lodash"; WorkloadId = "collection-adapter"; Variant = "workload"; Scenario = "performance-harness/browser/scenarios/lodash/collection-adapter.scenario.js" }
  @{ Library = "marked"; WorkloadId = "parser"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/marked/parser.scenario.js" }
  @{ Library = "zod"; WorkloadId = "validation"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/zod/validation.scenario.js" }
  @{ Library = "zod"; WorkloadId = "validation-adapter"; Variant = "workload"; Scenario = "performance-harness/browser/scenarios/zod/validation-adapter.scenario.js" }
  @{ Library = "date-fns"; WorkloadId = "calendar"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/date-fns/calendar.scenario.js" }
  @{ Library = "image-js"; WorkloadId = "transform"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/image-js/transform.scenario.js" }
  @{ Library = "image-js"; WorkloadId = "transform-adapter"; Variant = "workload"; Scenario = "performance-harness/browser/scenarios/image-js/transform-adapter.scenario.js" }
  @{ Library = "luxon"; WorkloadId = "scheduling"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/luxon/scheduling.scenario.js" }
  @{ Library = "luxon"; WorkloadId = "scheduling-adapter"; Variant = "workload"; Scenario = "performance-harness/browser/scenarios/luxon/scheduling-adapter.scenario.js" }
  @{ Library = "mime"; WorkloadId = "lookup"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/mime/lookup.scenario.js" }
  @{ Library = "strip-ansi"; WorkloadId = "clean"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/strip-ansi/clean.scenario.js" }
  @{ Library = "tweetnacl"; WorkloadId = "signature"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/tweetnacl/signature.scenario.js" }
  @{ Library = "yup"; WorkloadId = "validation"; Variant = "transparent"; Scenario = "performance-harness/browser/scenarios/yup/validation.scenario.js" }
)

function Get-SeededShuffle {
  param(
    [Parameter(Mandatory = $true)]
    [object[]]$Items,

    [Parameter(Mandatory = $true)]
    [int]$RandomSeed
  )

  $random = [System.Random]::new($RandomSeed)
  $shuffled = @($Items)

  for ($index = $shuffled.Count - 1; $index -gt 0; $index--) {
    $swapIndex = $random.Next($index + 1)
    $temporary = $shuffled[$index]
    $shuffled[$index] = $shuffled[$swapIndex]
    $shuffled[$swapIndex] = $temporary
  }

  return $shuffled
}

$orderedScenarios = @(Get-SeededShuffle -Items $scenarios -RandomSeed $Seed)
$outDirPath = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $outDirPath -Force | Out-Null

$existingResultFiles = @("runs.csv", "events.csv", "crossings.csv") |
  ForEach-Object { Join-Path $outDirPath $_ } |
  Where-Object { Test-Path -LiteralPath $_ }

if ($existingResultFiles.Count -gt 0) {
  throw "Output directory already contains measurement CSV files. Use a new directory to avoid mixing collection orders: $outDirPath"
}

$collectionPlan = @()
$executionPosition = 0

for ($scenarioIndex = 0; $scenarioIndex -lt $orderedScenarios.Count; $scenarioIndex++) {
  $scenario = $orderedScenarios[$scenarioIndex]

  if ($Mode -eq "both") {
    $scenarioModes = if (($scenarioIndex % 2) -eq 0) {
      @("native", "sandbox")
    } else {
      @("sandbox", "native")
    }
  } else {
    $scenarioModes = @($Mode)
  }

  for ($modeIndex = 0; $modeIndex -lt $scenarioModes.Count; $modeIndex++) {
    $executionPosition += 1
    $collectionPlan += [pscustomobject]@{
      execution_position = $executionPosition
      scenario_position = $scenarioIndex + 1
      mode_position = $modeIndex + 1
      seed = $Seed
      library = $scenario.Library
      workload_id = $scenario.WorkloadId
      scenario_variant = $scenario.Variant
      mode = $scenarioModes[$modeIndex]
      scenario_path = $scenario.Scenario
      iterations = $Iterations
      warmup = $Warmup
      repetitions = $Repetitions
      sample_ms = $SampleMs
    }
  }
}

$planPath = Join-Path $outDirPath "collection-plan.csv"
$collectionPlan | Export-Csv -Path $planPath -NoTypeInformation -Encoding UTF8

Write-Host "Collection seed: $Seed"
Write-Host "Collection plan:"
$collectionPlan |
  Select-Object execution_position, library, workload_id, scenario_variant, mode |
  Format-Table -AutoSize
Write-Host "Collection plan written to $planPath"

if ($PlanOnly) {
  Write-Host "PlanOnly selected; no browser measurements were executed."
  return
}

foreach ($planEntry in $collectionPlan) {
  $currentMode = $planEntry.mode

  Write-Host "Running $($planEntry.library)/$($planEntry.workload_id) in $currentMode mode..."

  node performance-harness/run-browser-scenario.mjs `
    --mode $currentMode `
    --library $planEntry.library `
    --workload-id $planEntry.workload_id `
    --variant $planEntry.scenario_variant `
    --scenario $planEntry.scenario_path `
    --iterations $Iterations `
    --warmup $Warmup `
    --repetitions $Repetitions `
    --sample-ms $SampleMs `
    --out-dir $outDirPath

  if ($LASTEXITCODE -ne 0) {
    throw "Performance runner failed for $($planEntry.library)/$($planEntry.workload_id) in $currentMode mode."
  }
}

Write-Host "Performance measurements written to $outDirPath"
