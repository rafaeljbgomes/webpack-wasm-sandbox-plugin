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
