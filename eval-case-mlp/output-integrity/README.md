# Output-integrity study (case study, Section 4.9)

Output contracts (`outputs` in the sandbox policy; runtime in
`.sandbox/core/output-contracts.js`) evaluated on Markdown Live Preview with a
compromised Marked 15.0.7.

    cd eval-case-mlp && ./fetch.sh && npm install          # app checkout at ./app
    node output-integrity/make-evil-marked.cjs app/node_modules/marked output-integrity/evil-marked
    APP=$PWD/app node output-integrity/build-variants.cjs   # 14 builds, one process each
    RUNS=5 node output-integrity/attack.mjs                # -> attack-results.json (Table 6)
    APP=$PWD/app node output-integrity/benign-alteration.mjs  # CommonMark 0.31.2: 36/652 changed
    APP=$PWD/app ITER=10 node measure.mjs b-native-shipped b-sb-shipped b-sb-forget-contract b-sb-shipped-contract
    # -> results.json; measure-summary.json keeps its rows without raw event lists, measure.log its summary lines

Variants: `e-*` use the compromised Marked, `b-*` the genuine one; `forget`
removes the app's DOMPurify call, `bypass` calls `marked()` (an undeclared
path) instead of `marked.parse`, `contract` declares
`{"marked.parse": {type: "html", sanitizer: "dompurify"}}`, `-tt` adds
`trustedTypes` to the contract plus `require-trusted-types-for 'script'`
(and Webpack's `output.trustedTypes`), `-csp` adds
`img-src/media-src/connect-src 'self'`.

Note: build each variant in its own process (build-variants.cjs does). Node
caches `require.resolve`, so a genuine build after a compromised one in the
same process would bundle the compromised copy; build-variants.cjs checks the
payload is present in exactly the `e-*` bundles.

The scripts import `playwright-core` and drive the installed Google Chrome.

## Tampering with the checker (Section 4.9)

Question: a compromised library that runs in the same JavaScript realm as the
application's sanitizer can disable it. Does the same tampering find anything to
tamper with when the library runs in the sandbox, with or without an output
contract?

The compromised Marked (`make-evil-marked.cjs`, `TAMPER=blind,sink`) runs a
prologue at module evaluation, guarded by `typeof` checks:

- T1 `blind`: `NodeIterator.prototype.nextNode` returns `null`. DOMPurify calls
  `nodeIterator.nextNode()` through the prototype on every `sanitize()` call,
  so nothing is removed.
- T2 `sink`: the `innerHTML` setter appends the payload corpus to any string
  assigned to `#output`, after the sanitizer and any contract. Under Trusted
  Types it first creates its own policy.

The prologue also appends a plain-text self-report, `tamper:T1=… T2=…`, to every
result, so "blocked because the API is absent" can be told apart from "the
tamper code never ran". `attack.mjs` reads it from `#output` and checks
`NodeIterator.prototype.nextNode` and the `innerHTML` setter host-side.

    cd eval-case-mlp && ./fetch.sh && npm install --ignore-scripts
    export APP=$PWD/app
    node output-integrity/make-evil-marked.cjs app/node_modules/marked output-integrity/evil-marked
    TAMPER=blind,sink node output-integrity/make-evil-marked.cjs app/node_modules/marked output-integrity/evil-marked-tamper
    TAMPER=blind      node output-integrity/make-evil-marked.cjs app/node_modules/marked output-integrity/evil-marked-tamper-blind
    TAMPER=sink       node output-integrity/make-evil-marked.cjs app/node_modules/marked output-integrity/evil-marked-tamper-sink
    node output-integrity/build-variants.cjs t-native-shipped t-native-shipped-blind t-native-shipped-sink \
        t-sb-shipped t-sb-forget-contract t-sb-forget-contract-csp t-sb-forget-contract-tt
    RUNS=5 RESULTS=tamper-results.json node output-integrity/attack.mjs \
        t-native-shipped t-native-shipped-blind t-native-shipped-sink t-sb-shipped \
        t-sb-forget-contract t-sb-forget-contract-csp t-sb-forget-contract-tt | tee tamper.log
    # reproduction of the untampered rows and the genuine-Marked smoke check
    node output-integrity/build-variants.cjs e-native-shipped e-sb-forget-contract b-native-shipped b-sb-shipped
    RUNS=5 RESULTS=repro-results.json node output-integrity/attack.mjs \
        e-native-shipped e-sb-forget-contract b-native-shipped b-sb-shipped

`build-variants.cjs` checks that the payload is present in exactly the `e-*` and
`t-*` bundles and the tamper prologue in exactly the `t-*` bundles. Each variant
is built in its own process (see the note above).

Results (5 runs each, all consistent): see `tamper-results.json` and `tamper.log`.
Native tampering succeeds (T1 and T2 applied): 9 script and 4 exfiltration
payloads live. In the sandbox, neither vector finds its target, the self-report
says `absent`, and the results match the untampered builds. `repro-results.json`
reproduces `e-native-shipped` (0 + 3) and `e-sb-forget-contract` (0 + 3) and the
genuine builds (0 + 0, app renders).

**LavaMoat did not build (not produced).** The `pol-clean`, `pol-regen` and
`pol-reviewed` steps and the `t-lavamoat-*` and `b-lavamoat` variants are
defined in `build-variants.cjs`, but `@lavamoat/webpack@3.0.2` stops on
`monaco-editor/esm/vs/editor/common/services/editorSimpleWorker.js` (a dynamic
`require` with a non-literal module id) and writes no policy. The console output
is in `lavamoat-failure.log`. `build.cjs` now fails when no policy is written
instead of succeeding silently. The LavaMoat rows of the checker experiment are
therefore not measured for this app. The sandbox-versus-native result does not
depend on them. Note that `policy.json` is never produced, so `lavamoat-policies/`
does not exist.
