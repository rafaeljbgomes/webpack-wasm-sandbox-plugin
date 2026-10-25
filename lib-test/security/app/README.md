# Security validation application

**Status:** Active browser security validation on `main`.

This isolated browser application validates the sandbox through its normal
transparent import flow. Its own `node_modules` contains the exact dependencies
used by both execution modes.

The `strip-ansi` and `image-js` installations are modified by harmless,
checked-in `patch-package` patches. The validation fixture installs the clean
`strip-ansi@7.2.0` release used by the project and alters it locally to reproduce
the security-relevant behavior associated with the historical compromise. It
does not install the compromised package. The patches contain no original
malware, perform no external requests, and are not part of the proposed sandbox
runtime.

The main project dependencies, sandbox configuration, and performance harness
are not modified by these validation patches.

The application is a validation fixture, not an example dependency policy for production. It executes locally, makes no intentional external requests, and writes generated bundles only under the repository's ignored `dist/` directory.

The security Webpack configuration also contains the same kind of dependency
compatibility alias used elsewhere in the prototype: `ml-xsadd` is normalized
to the named export expected by the current ImageJS dependency graph. This
alias is unrelated to the security policy or attack simulation.

## Installation

From the repository root:

```powershell
npm install --prefix .\lib-test\security\app
```

The application's `postinstall` script reapplies the patches automatically.
`npm` reports a high-severity vulnerability in this isolated dependency tree
because the Lodash scenario intentionally pins vulnerable `4.17.21`. Do not run
`npm audit fix` in this application before running the scenarios,
as upgrading Lodash would invalidate that scenario.

## Manual execution

Build each native version, record the displayed table, then build the sandbox
version and reload the same page:

```powershell
npx webpack --config webpack.security.config.cjs --env scenario=lodash --env mode=native
npx webpack --config webpack.security.config.cjs --env scenario=lodash --env mode=sandbox

npx webpack --config webpack.security.config.cjs --env scenario=strip-ansi --env mode=native
npx webpack --config webpack.security.config.cjs --env scenario=strip-ansi --env mode=sandbox

npx webpack --config webpack.security.config.cjs --env scenario=image-js --env mode=native
npx webpack --config webpack.security.config.cjs --env scenario=image-js --env mode=sandbox
```

Serve the repository root and open `http://localhost:9000/index.html`:

```powershell
python -m http.server 9000
```

Each build writes `dist/bundle.js`. Keep the server running, rebuild the desired
mode in another terminal, and reload the page after each build.

`webpack.security.config.cjs` validates both `scenario` and `mode`. Native mode does not instantiate `WebpackSandboxPlugin`. Sandbox mode loads the scenario-specific build policy; generated proxies explicitly pass those permissions into the runtime. Its existing policy-import replacement remains for direct runtime callers using the legacy fallback.

Native builds do not instantiate `WebpackSandboxPlugin`. Sandbox builds use the
unchanged plugin behavior: read the selected configuration, resolve the package
from this application's `node_modules`, build the isolated library bundle,
generate a proxy, and redirect the application's bare package import.

Each run writes the same observations to the page and `console.table`, reports
`PASS` or `FAIL`, and throws when an expected result is not observed.

## Scenarios and expected observations

| Scenario | Native execution | Sandbox execution |
|---|---|---|
| Lodash | `_.unset` deletes the canary from the host `Object.prototype` | The vulnerable call returns successfully, but the host canary remains |
| strip-ansi | The patched package preserves ANSI removal and intercepts the three fictitious host APIs | ANSI removal succeeds, while the host APIs and recipients remain unchanged |
| image-js | Transformation and encoding succeed, and the patched package writes the `localStorage` canary | Transformation and encoding succeed through the allowed capabilities, while the `localStorage` write is blocked |

The Lodash scenario uses the real vulnerable `4.17.21` package and the
canonical `["constructor", "prototype", canaryKey]` path described by
CVE-2025-13465. The other two
scenarios use clean current project versions with explicit validation patches:
the strip-ansi patch simulates the relevant supply-chain behavior, while the
ImageJS patch adds an additional capability probe to `encodeDataURL`.

## Interpreting results

Each scenario writes the same structured observations to the page and `console.table`, reports `PASS` or `FAIL`, and throws when the expected outcome is missing. A successful sandbox result requires both dimensions:

1. the legitimate library operation still produces its expected result;
2. the host-side effect observed in native mode is absent or contained.

Do not treat a blocked operation alone as compatibility success, or a successful library operation alone as proof of isolation. The patches are controlled simulations and do not claim that the clean `strip-ansi` or Image.js releases are malicious.
