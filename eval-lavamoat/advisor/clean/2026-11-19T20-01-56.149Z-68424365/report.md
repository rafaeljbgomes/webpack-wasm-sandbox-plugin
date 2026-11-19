# Sandbox capability suggestions

Model: subq-snap-1.1. Draft threshold: 0.9.

Review the draft before copying permissions into the active policy. Probabilities are review heuristics, not a security guarantee.

Analysis follows the runtime build's entry resolution and includes installed transitive modules. Host/local modules and configured workloads are excluded.

Sensitive and unvalidated APIs require explicit developer review. Static absence is not proof that a capability is unnecessary.

New API token usage: 0 input; 0 output. Cached results do not add new usage.

## image-js

Packages: bresenham-zingl@0.2.5, colord@2.9.3, fast-bmp@4.0.1, fast-jpeg@3.0.1, fast-png@8.0.0, fflate@0.8.3, fft.js@4.0.4, file-type@10.11.0, image-js@1.5.0, image-type@4.1.0, iobuffer@6.0.1, is-any-array@3.0.0, jpeg-js@0.4.4, js-priority-queue@0.1.5, median-quickselect@1.0.1, ml-affine-transform@1.0.3, ml-array-median@1.1.6, ml-convolution@2.0.0, ml-matrix@6.12.2, ml-random@0.5.0, ml-ransac@1.0.0, ml-regression-base@4.0.1, ml-regression-multivariate-linear@2.0.4, ml-regression-polynomial-2d@1.0.0, ml-spectra-processing@14.29.0, ml-xsadd@2.0.0, next-power-of-two@1.0.0, robust-orientation@1.2.1, robust-point-in-polygon@1.0.3, robust-scale@1.0.2, robust-subtract@1.0.0, robust-sum@1.0.0, tiff@7.1.3, ts-pattern@5.9.0, two-product@1.0.2, two-sum@1.0.0, uint8-base64@1.0.0

Analysis issues: local_module_excluded, dynamic_code_evaluation. Workloads analyzed: no.

| Capability | Classification | Probability | Draft / review | Code evidence |
|---|---|---|---|---|
| Intl | insufficient_evidence | — | existing; dry_run_not_evaluated | image-js/lib/utils/validators/checkProcessable.js:1 [module initialization] (ListFormat) |
| TextEncoder | insufficient_evidence | — | existing; dry_run_not_evaluated | fflate/esm/browser.js:1660 [module initialization]; fflate/esm/browser.js:1660 [module initialization]; iobuffer/lib/text.js:11 [module initialization] |
| TextDecoder | insufficient_evidence | — | existing; dry_run_not_evaluated | fast-png/lib/helpers/text.js:5 [module initialization]; fflate/esm/browser.js:1662 [module initialization]; fflate/esm/browser.js:1662 [module initialization]; fflate/esm/browser.js:1700 [DecodeUTF8]; image-js/lib/save/encodeDataURL.js:12 [encodeDataURL]; iobuffer/lib/text.js:8 [decode] |
| crypto | insufficient_evidence | — | dry_run_not_evaluated | none found |
| fetch | insufficient_evidence | — | dry_run_not_evaluated | image-js/lib/load/fetchURL.js:8 [fetchURL] |
| XMLHttpRequest | insufficient_evidence | — | dry_run_not_evaluated | jpeg-js/lib/decoder.js:552 [load] |
| WebSocket | insufficient_evidence | — | dry_run_not_evaluated | none found |
| EventSource | insufficient_evidence | — | dry_run_not_evaluated | none found |
| localStorage | insufficient_evidence | — | dry_run_not_evaluated | none found |
| sessionStorage | insufficient_evidence | — | dry_run_not_evaluated | none found |
| indexedDB | insufficient_evidence | — | dry_run_not_evaluated | none found |
| document | insufficient_evidence | — | dry_run_not_evaluated | image-js/lib/load/readImg.js:10 [readImg] (createElement); jpeg-js/lib/encoder.js:806 [getImageDataFromImage] (getElementById); jpeg-js/lib/encoder.js:807 [getImageDataFromImage] (createElement) |
| navigator | insufficient_evidence | — | dry_run_not_evaluated | none found |
| location | insufficient_evidence | — | dry_run_not_evaluated | none found |
| URL | insufficient_evidence | — | dry_run_not_evaluated | fflate/esm/browser.js:12 [anonymous callback] (createObjectURL) |
| URLSearchParams | insufficient_evidence | — | dry_run_not_evaluated | none found |
| Blob | insufficient_evidence | — | dry_run_not_evaluated | fflate/esm/browser.js:12 [anonymous callback] |
| File | insufficient_evidence | — | dry_run_not_evaluated | none found |
| FileReader | insufficient_evidence | — | dry_run_not_evaluated | none found |
| atob | insufficient_evidence | — | dry_run_not_evaluated | none found |
| btoa | insufficient_evidence | — | dry_run_not_evaluated | none found |
| console | insufficient_evidence | — | dry_run_not_evaluated | ml-matrix/matrix.js:2352 [mmulStrassen] (warn); ml-matrix/matrix.js:4038 [anonymous callback] (warn) |
| performance | insufficient_evidence | — | dry_run_not_evaluated | none found |
| setTimeout | insufficient_evidence | — | dry_run_not_evaluated | fflate/esm/browser.js:2556 [module initialization]; fflate/esm/browser.js:2556 [module initialization] |
| clearTimeout | insufficient_evidence | — | dry_run_not_evaluated | none found |
| setInterval | insufficient_evidence | — | dry_run_not_evaluated | none found |
| clearInterval | insufficient_evidence | — | dry_run_not_evaluated | none found |
| requestAnimationFrame | insufficient_evidence | — | dry_run_not_evaluated | none found |
| cancelAnimationFrame | insufficient_evidence | — | dry_run_not_evaluated | none found |

## strip-ansi

Packages: ansi-regex@6.2.2, strip-ansi@7.2.0

Analysis issues: none detected. Workloads analyzed: no.

| Capability | Classification | Probability | Draft / review | Code evidence |
|---|---|---|---|---|
| Intl | insufficient_evidence | — | dry_run_not_evaluated | none found |
| TextEncoder | insufficient_evidence | — | dry_run_not_evaluated | none found |
| TextDecoder | insufficient_evidence | — | dry_run_not_evaluated | none found |
| crypto | insufficient_evidence | — | dry_run_not_evaluated | none found |
| fetch | insufficient_evidence | — | dry_run_not_evaluated | none found |
| XMLHttpRequest | insufficient_evidence | — | dry_run_not_evaluated | none found |
| WebSocket | insufficient_evidence | — | dry_run_not_evaluated | none found |
| EventSource | insufficient_evidence | — | dry_run_not_evaluated | none found |
| localStorage | insufficient_evidence | — | dry_run_not_evaluated | none found |
| sessionStorage | insufficient_evidence | — | dry_run_not_evaluated | none found |
| indexedDB | insufficient_evidence | — | dry_run_not_evaluated | none found |
| document | insufficient_evidence | — | dry_run_not_evaluated | none found |
| navigator | insufficient_evidence | — | dry_run_not_evaluated | none found |
| location | insufficient_evidence | — | dry_run_not_evaluated | none found |
| URL | insufficient_evidence | — | dry_run_not_evaluated | none found |
| URLSearchParams | insufficient_evidence | — | dry_run_not_evaluated | none found |
| Blob | insufficient_evidence | — | dry_run_not_evaluated | none found |
| File | insufficient_evidence | — | dry_run_not_evaluated | none found |
| FileReader | insufficient_evidence | — | dry_run_not_evaluated | none found |
| atob | insufficient_evidence | — | dry_run_not_evaluated | none found |
| btoa | insufficient_evidence | — | dry_run_not_evaluated | none found |
| console | insufficient_evidence | — | dry_run_not_evaluated | none found |
| performance | insufficient_evidence | — | dry_run_not_evaluated | none found |
| setTimeout | insufficient_evidence | — | dry_run_not_evaluated | none found |
| clearTimeout | insufficient_evidence | — | dry_run_not_evaluated | none found |
| setInterval | insufficient_evidence | — | dry_run_not_evaluated | none found |
| clearInterval | insufficient_evidence | — | dry_run_not_evaluated | none found |
| requestAnimationFrame | insufficient_evidence | — | dry_run_not_evaluated | none found |
| cancelAnimationFrame | insufficient_evidence | — | dry_run_not_evaluated | none found |

