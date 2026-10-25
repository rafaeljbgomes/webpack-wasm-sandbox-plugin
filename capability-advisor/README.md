# SubQ capability advisor

**Status:** Implemented experimental preparation workflow. Recommendations require developer review; this is not a security audit or a proof of minimum permissions.

See the [canonical specification](../docs/architecture/sandbox-plugin-spec-v2.md) for the isolation boundary and runtime limitations.

## Select, prepare, review, build

Select installed libraries in the policy. Permissions may be omitted:

```js
export default {
  luxon: {},
  tweetnacl: {},
  "image-js": {},
};
```

Omission means `[]` in the normal build. Non-array, null, empty-name and non-string permission values fail validation. Existing permissions and serializable workload declarations are preserved in the draft. Policies with functions, cycles or other non-JSON fields cannot be drafted without losing data, so the advisor rejects them without changing the original.

Use Node.js 20 or newer and install the root dependencies. First inspect the evidence without an API call:

```powershell
npm run sandbox:suggest -- --dry-run
```

For live classification, create a key at the SubQ console, configure `SUBQ_API_KEY` in the terminal environment or your secret manager, then run:

```powershell
npm run sandbox:suggest -- `
  --config ./.sandbox/sandbox.config.js `
  --webpack-config ./webpack.bundles.config.cjs
```

The key is used only by the Node preparation process. It is not saved in configuration, reports, bundles or proxies. Requests go to SubQ's System One endpoint, `POST https://api.subq.ai/v1/systemone`, with Bearer authentication. The transport is the `@typesafe-ai/sdk` System One client, which speaks the same wire contract. The base URL is set explicitly, so `TYPESAFE_BASE_URL` and similar SDK environment variables cannot redirect evidence. SDK debug logging is disabled. Normal Webpack builds never load the SDK or contact SubQ.

Read `report.md` and inspect `requests.json` for the exact bounded snippets. Edit the suggested configuration and copy reviewed permission lists into the policy selected by your normal build. Then run `npm run build:bundles`, followed by relevant native and sandbox compatibility checks. A draft is never applied automatically.

## Options and artifacts

| Option | Behavior |
|---|---|
| `--config <path>` | Policy path, relative to the selected compiler context; default `.sandbox/sandbox.config.js` |
| `--webpack-config <path>` | Webpack configuration relative to the current directory; default `webpack.bundles.config.cjs` |
| `--env key=value` | Repeatable values supplied to a Webpack configuration factory |
| `--out-dir <path>` | Result/cache directory; default `capability-advisor-results` |
| `--dry-run` | Compile evidence and preview requests; no provider calls or new draft permissions |
| `--offline` | Use validated matching cache entries; misses become incomplete results and a nonzero exit |
| `--refresh` | Bypass previous classifications and request fresh answers; incompatible with offline mode |
| `--help` | Print usage without compiling |

One Webpack configuration object or asynchronous factory is supported. Multi-compiler arrays are rejected. The CLI replaces the sandbox plugin with its analysis plugin, removes the host entry, and retains other plugins, target, resolver settings, aliases and loaders. Trusted build configuration and loaders execute just as in a normal compilation; emitted dependency code is not executed.

Each timestamped run contains `sandbox.config.suggested.js`, `report.md`, `report.json`, `requests.json` and analysis-only bundles. Cache files are stored in the result root's `cache/`. The default root is ignored by Git. Use the same ignore policy for a custom output directory. Evidence may contain dependency source and comments: keep generated artifacts out of public commits.

Failed provider requests produce sanitized error codes, preserve existing permissions, add no permissions from those requests, and set exit status 1. Successful independent requests can still contribute to the draft; the report records partial results. Missing credentials produce `missing_api_key`. Dry-run and human-review outcomes such as incomplete static evidence do not themselves fail the command.

## Evidence and classification

The analysis plugin uses the same policy loader, Node package entry resolution and Webpack child compiler helper as the runtime build. It captures transformed installed module sources, including transitive and concatenated modules, together with package versions and content hashes. It does not replace the actual entry with an alternative browser entry. Webpack deliberately ignored modules are inert and recorded by hash; externals and other opaque modules are limitations.

Scope-aware TypeScript analysis detects unshadowed globals, static root properties, immutable/simple unreassigned aliases and object destructuring. It recognizes `globalThis["fetch"]`, `self.crypto` and the `msCrypto` alias, while ignoring local variables or parameters named after capabilities. Function or initialization context is retained. Dynamic global properties, direct reflective code evaluation, dynamic scopes, parse failures, omitted source, local modules and opaque modules mark analysis incomplete. This is bounded static extraction, not general interprocedural data-flow analysis. Reassigned aliases, reflective execution, implicit `this` roots and runtime-generated names can evade extraction; absence is never proof of no need.

Only transformed installed-package evidence and package metadata enter requests. Host/local modules are excluded and block new draft grants because their effects are unknown. Workloads are preserved but not analyzed. Build-settings values are hashed locally, not sent. Each request's `state` is at most 24 KiB of serialized UTF-8 JSON and its complete payload at most 48 KiB. Evidence is deduplicated and limited to 12 KiB per capability; omitted snippets make that capability ineligible for a new draft permission.

SubQ Snap `subq-snap-1.1` (public preview) answers one Choice per capability: `core_required`, `optional_feature`, `no_demonstrated_need`, or `insufficient_evidence`. Questions explicitly treat code/comments as untrusted data and distinguish intended features from probes, fallbacks and unauthorized side effects. The model neither generates executable policy nor invents explanations: report explanations come from local evidence and validation rules.

## Catalogue and review rules

Catalogue version 1 is maintained in `catalogue.mjs`:

- Supported: `Intl`, `TextEncoder`, `TextDecoder`, and the existing constrained `crypto` facade.
- Sensitive, explicit review: network globals, origin storage, `document`, `navigator` and `location`.
- Exposure unvalidated: URL constructors, blobs/files, base64 helpers, console, performance, timers and animation callbacks.

QuickJS JavaScript built-ins, including `Date`, are not host capability candidates. Whole host roots (`window`, `self`, `globalThis`) are never suggested. Additional globals remain manual until added to the catalogue and their exposure validated. Listing an API does not establish compatibility or safe attenuation.

Supported core and optional feature needs enter the draft only with matching complete evidence and selected-option probability at least 0.90. Optional features remain labeled in the report. Sensitive, unvalidated, failed or uncertain results do not add permissions. Existing permissions are retained even when outside the catalogue and explicitly marked for review.

The `crypto` facade covers integer typed-array `getRandomValues` and optional `randomUUID`, not `subtle`, `randomBytes`, or host Crypto objects. Detected unsupported members block a new crypto draft suggestion. Model probabilities and confidence are recorded separately. SubQ confidence is optional and is recorded as `null` when absent; it never affects eligibility. The probability threshold is an initial heuristic, not demonstrated domain calibration. SubQ accepts up to 128 questions per request, and the 48 KiB request budget keeps batches well below that.

Cache keys include module hashes, resolved package versions, effective Webpack settings/configuration, analyzer implementation, catalogue, question definitions and pinned model. Existing developer permission edits re-render the draft without replacing cached classifications. Corrupt cache entries fail closed; use `--refresh` to replace them. Two workers bound concurrency. Requests use a 10-second attempt timeout, at most three attempts and a 40-second overall AbortSignal deadline. SDK retries are disabled so attempts do not multiply. Authentication/validation errors are terminal; retryable transport and HTTP failures use backoff and honor bounded `Retry-After` values.

## Validation

```powershell
npm run test:advisor
npx --no-install tsc -p webpack-sandbox-plugin/tsconfig.json --noEmit
node --import tsx --test webpack-sandbox-plugin/test/plugin.fail-closed.test.mjs
node --test compatibility-harness/test/parsers.test.mjs
npm run sandbox:suggest -- --dry-run
npm run build:bundles
node compatibility-harness/run-compat.mjs --library zod --test-file packages/zod/src/v4/classic/tests/array.test.ts
```

Advisor tests include the production SubQ client factory against a mocked HTTP endpoint, transitive compilation, aliases, local-source exclusion, cache behavior, draft preservation, response rejection, bounded concurrency/retries, custom compiler policies and real QuickJS allowed/denied behavior. Follow the [browser security guide](../lib-test/security/app/README.md) for native/sandbox browser scenarios.

Ten-library dry runs establish evidence collection and artifacts, not recommendation accuracy. Before relying on recommendations, run authenticated classification and manually label demonstrated capability needs for the installed versions. Record unnecessary draft additions, missed demonstrated supported needs, optional-feature labels and unresolved outcomes separately. Do not use the existing policy as unquestioned ground truth or count unsupported/sensitive review-only results as successful automated grants.

Primary API references: [SubQ models](https://docs.subq.ai/using-the-api/models/), [SubQ Decisions API](https://docs.subq.ai/endpoints/decisions-api/), [SubQ Snap announcement](https://subq.ai/introducing-subq-snap), and the [System One Node SDK](https://docs.typesafe.ai/sdk/javascript) used as transport. Architectural decision 26 records the move from Jev to SubQ.
