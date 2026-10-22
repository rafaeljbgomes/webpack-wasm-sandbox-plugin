# Capability advisor validation — 2026-10-02

This is a scoped implementation-validation record. See the [operational guide](README.md) and [canonical architecture](../docs/architecture/sandbox-plugin-spec-v2.md) for contracts and limitations.

## Automated checks

| Exact command | Result |
|---|---|
| `npm run test:advisor` | 22 tests passed, including official SDK mocked transport, real Webpack child compilation, explicit custom policy propagation and QuickJS allowed/denied behavior |
| `npx --no-install tsc -p webpack-sandbox-plugin/tsconfig.json --noEmit` | Passed |
| `node --import tsx --test webpack-sandbox-plugin/test/plugin.fail-closed.test.mjs` | 5 existing local tests passed; the pre-existing untracked test file was not changed |
| `node --test compatibility-harness/test/parsers.test.mjs` | 10 tests passed |
| `npm run sandbox:suggest -- --dry-run` | All ten selected libraries produced bounded request previews, draft and reports; no API calls |
| `npm run build:bundles` | All ten libraries compiled successfully; generated default bundles/proxies restored after security validation |
| `node compatibility-harness/run-compat.mjs --library zod --test-file packages/zod/src/v4/classic/tests/array.test.ts` | 18/18 native and 18/18 sandbox tests passed |
| `node compatibility-harness/run-compat.mjs --library date-fns --test-file src/intlFormat/test.ts` | 5/5 native and 4/5 sandbox tests passed; all four formatting cases passed |

The initial restricted Zod run crashed in both modes because esbuild could not read ancestor directories. The same campaign passed outside that restricted environment; no runner configuration was changed. The compatibility runner itself can return zero after a failed unit, so results were verified from `summary.csv`, not inferred from the runner exit code.

The Date-fns invalid-date assertion failed while matching a sandbox `RangeError` against the host constructor. A direct comparison using the original `HEAD` runtime, the current explicit policy and the current legacy fallback reproduced the same result in all three: the error has name `RangeError` but is not an instance of the host `RangeError`. This existing cross-runtime error identity limitation remains unresolved; it is not a permission-propagation regression. Comparison artifacts are retained in the ignored `capability-advisor-results/baseline-policy-comparison/` directory.

## Browser security validation

For each `scenario` in `lodash`, `strip-ansi`, and `image-js`, and each `mode` in `native` and `sandbox`, ran:

```powershell
npx webpack --config webpack.security.config.cjs --env scenario=<scenario> --env mode=<mode>
```

All six builds succeeded. Served a temporary loopback-only HTML shell containing the existing `output` element and the emitted scenario script. Verified the displayed observation tables in the Codex in-app browser. The temporary tab and server were closed afterwards.

| Scenario | Native observation | Sandbox observation | Result |
|---|---|---|---|
| Lodash | Vulnerable unset deleted the host prototype canary | Unset completed; host prototype canary remained | Both PASS |
| strip-ansi | ANSI removal succeeded; fictitious host APIs/recipients were intercepted | ANSI removal succeeded; APIs and recipients remained unchanged | Both PASS |
| Image.js | Image transformation/PNG encoding succeeded; patched localStorage canary was written | Image transformation/PNG encoding succeeded; localStorage write was blocked | Both PASS |

The intentionally vulnerable isolated Lodash and harmless installed validation patches were preserved. These are scoped scenarios, not a general security assurance.

## Ten-library evidence review

Final dry-run reports are retained in the ignored timestamped result directory. Review found:

| Library | Compiled modules | Supported-capability references | Analysis boundary |
|---|---:|---|---|
| date-fns | 304 | Intl | Complete extracted evidence; optional internationalization code |
| image-js | 547 | Intl, TextEncoder, TextDecoder | Dynamic code evaluation in the dependency graph blocks new draft additions; optional network/DOM references are also reported |
| lodash | 1 | None detected | Dynamic code evaluation requires manual review |
| luxon | 1 | Intl | Complete extracted evidence |
| marked | 1 | None detected | Logging is reported as unvalidated |
| mime | 4 | None detected | Static absence is not proof of no requirement |
| strip-ansi | 2 | None detected | Static absence is not proof of no requirement |
| tweetnacl | 2 | crypto | Randomness initialization evidence retained; inert Webpack-ignored Node crypto module recognized |
| yup | 4 | None detected | Static absence is not proof of no requirement |
| zod | 76 | None detected | Additional URL/file/base64/navigator references require review |

`TYPESAFE_API_KEY` was absent. Authenticated classifications, unnecessary-suggestion counts, missed demonstrated needs and model calibration therefore remain **unmeasured**. Dry-run produces no new grants and labels all capability decisions unresolved. Mocked responses validate deterministic policy rules but do not measure Jev accuracy. Configure the key and run a live preparation, then manually label each demonstrated library/capability pair before drawing accuracy conclusions.

PlantUML sources were updated; parser/render validation was not performed.

## SubQ provider switch — 2026-10-22

The advisor model changed from Jev `jev-1.13.0` to SubQ Snap `subq-snap-1.1` (architectural decision 26). The record above describes the Jev-era run and is kept as history.

| Exact command | Result |
|---|---|
| `npm run test:advisor` | 23 tests passed. Includes the production `createProviderClient` against a mocked `https://api.subq.ai/v1/systemone` with an overriding `TYPESAFE_BASE_URL` set, and optional/null SubQ confidence handling |
| `node --import tsx --test webpack-sandbox-plugin/test/plugin.fail-closed.test.mjs` | 5 tests passed |
| `node --test compatibility-harness/test/parsers.test.mjs` | 10 tests passed |
| `npx --no-install tsc -p webpack-sandbox-plugin/tsconfig.json --noEmit` | Passed (run before the advisor-only change; plugin sources unchanged) |
| `npm run sandbox:suggest -- --dry-run --out-dir <scratch>` | 10 libraries, 11 batches, all pinned to `subq-snap-1.1`, at most 29 questions per batch; no API calls and no draft additions |

`SUBQ_API_KEY` was absent, so no live SubQ request was made. SubQ wire compatibility is taken from SubQ's published Decisions API documentation, not from an observed response. In particular, the exact `model` string SubQ echoes back has not been observed; a mismatch would fail closed as `invalid_response`. SubQ classification accuracy remains **unmeasured**.
