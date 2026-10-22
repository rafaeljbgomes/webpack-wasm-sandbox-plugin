# Webpack WASM Sandbox Plugin

`webpack-wasm-sandbox-plugin` is an experimental Webpack plugin for isolating browser-side JavaScript dependencies in per-library WebAssembly sandboxes powered by QuickJS. The plugin replaces configured package imports with generated proxy modules. The proxies initialize the isolated library and expose its API through policy-controlled membrane and marshalling layers.

The project explores a specific security question: can a browser application continue to use a third-party JavaScript library without granting that library all authority available to the host page? The implementation is an experimental prototype, not a production-ready package.

## What is implemented

- One QuickJS context and Arena bridge per configured library.
- Webpack child compilation of isolated library bundles.
- `.d.ts`-driven generation of transparent proxy modules.
- Declarative, deny-by-default exposure of selected browser capabilities.
- Forward and reverse membranes for calls across the host/QuickJS boundary.
- Custom marshalling for typed arrays, `RegExp`, `arguments`, and errors.
- Compatibility campaigns across ten npm libraries.
- Browser security scenarios for prototype pollution and unauthorised capability use.
- Optional coarse-grained workload adapters in the plugin contract.

Performance instrumentation and its collection/analysis tools are intentionally maintained on [`feat/sandbox-benchmarking`](#performance-benchmarking). They are not part of the uninstrumented `main` runtime.

## Prerequisites

- Node.js with npm. The current dependency lock is the source of truth for package versions.
- PowerShell for the documented Windows commands.
- Python 3 for serving the browser demonstrations.
- A Chromium-based browser for manual browser validation.

## Install and build

From the repository root:

```powershell
npm install
npm run build:bundles
```

`npm install` also applies the checked-in `patch-package` changes. `build:bundles` generates library bundles under `dist/` and proxies under `.sandbox/proxys/`; both locations are generated output and must not be edited or committed.

The current sandbox configuration contains ten libraries:

`date-fns`, `image-js`, `lodash`, `luxon`, `marked`, `mime`, `strip-ansi`, `tweetnacl`, `yup`, and `zod`.

On `main`, the build generates bundles for all ten configured libraries. Benchmark workload adapters and their source files are maintained exclusively on `feat/sandbox-benchmarking`, so they are not declared in this branch's sandbox configuration.

Build the main browser demonstration with:

```powershell
npx webpack --config webpack.config.cjs
python -m http.server 9000
```

Then open `http://localhost:9000`.

## How the sandbox works

The system has a build-time and a runtime phase.

1. `WebpackSandboxPlugin` reads `.sandbox/sandbox.config.js`.
2. For each configured package, it finds the package declarations, derives the public export surface, and generates `.sandbox/proxys/<library>-proxy.js`.
3. Webpack child compilers create `dist/<library>.bundle.js` with the library assigned to `__SANDBOXED_LIB__`.
4. `NormalModuleReplacementPlugin` redirects the host application's bare package import to the generated proxy.
5. The proxy loads the isolated bundle and creates a QuickJS context through `SandboxManager` using top-level await.
6. The runtime exposes only configured capabilities, evaluates the library inside QuickJS, and returns wrapped exports to the host.

Each library receives a separate QuickJS context. Prototype or global mutations inside one context do not directly mutate the host realm or another library context. Host objects deliberately passed into a library remain capabilities: the membranes preserve method receivers and mediate traversal, but they do not revoke authority already contained in an explicitly supplied object. See the [canonical architecture specification](docs/architecture/sandbox-plugin-spec-v2.md) and [host-argument limitation](docs/architecture/host-argument-capability-limitation.md).

## Sandbox configuration

The plugin accepts one option:

```js
new WebpackSandboxPlugin({
  configPath: "./.sandbox/sandbox.config.js",
});
```

The configuration is keyed by package name:

```js
export default {
  "example-library": {
    permissions: ["Intl"],
    workloads: {
      example: {
        entry: "path/to/example-workload.js",
        exports: ["runExample"],
      },
    },
  },
};
```

- `permissions` lists host globals to expose. Omission normalizes to `[]`; malformed values fail the build. Generated proxies carry the compiler-selected permissions into the runtime, including explicit empty lists.
- `workloads` is optional. Each entry defines code that executes inside the owning library sandbox and the functions exported through `sandbox-workload/<library>/<workload>`.
- The runtime currently supports explicitly configured globals and a constrained `crypto` capability. Adding a name to the configuration does not automatically make an unsupported global safe or usable.

## Compatibility testing

The automated compatibility runner is the project's primary functional evidence. It executes upstream-derived suites in native and sandbox modes and stores auditable results outside the performance data. The upstream suites are intentionally not versioned in this repository; obtain the required suites and place them in the paths declared by `compatibility-harness/manifest.mjs` before running a campaign.

```powershell
node compatibility-harness/run-compat.mjs --library zod
node compatibility-harness/run-compat.mjs --library date-fns --mode sandbox
node compatibility-harness/run-compat.mjs --library lodash --build
```

Use `--build` when bundles and proxies must be refreshed. Results are written to `compatibility-results/<library>/<timestamp>/` and are ignored by Git. See the [compatibility harness guide](compatibility-harness/README.md) and [testing architecture](docs/architecture/compat-testing-plan.md).

The repository has no standalone sandbox-runtime regression suite at present. The following internal check validates parser behaviour and harness planning only; it does not establish correctness of the sandbox or plugin. It also requires the upstream suites to have been populated locally:

```powershell
node --test compatibility-harness/test/parsers.test.mjs
```

## Security validation

The isolated application under `lib-test/security/app/` compares native and sandbox execution for:

- Lodash prototype pollution using the intentionally vulnerable `4.17.21` package;
- a harmless local `strip-ansi` patch that simulates unauthorised capability use;
- a harmless local Image.js patch that probes `localStorage` while preserving image processing.

Install the isolated application's dependencies and follow its guide:

```powershell
npm install --prefix .\lib-test\security\app
npx webpack --config webpack.security.config.cjs --env scenario=lodash --env mode=native
npx webpack --config webpack.security.config.cjs --env scenario=lodash --env mode=sandbox
python -m http.server 9000
```

Do not run `npm audit fix` inside the validation application: upgrading its intentionally vulnerable Lodash dependency invalidates that scenario. Full commands and expected observations are in the [security validation README](lib-test/security/app/README.md).

## Performance benchmarking

Performance benchmarking requires the instrumented `feat/sandbox-benchmarking` branch. Use a separate worktree so generated results and instrumented runtime code do not replace the `main` checkout:

```powershell
git worktree add ..\spike-quickjs-benchmark feat/sandbox-benchmarking
Set-Location ..\spike-quickjs-benchmark
```

That branch contains the browser scenarios, sandbox boundary-crossing instrumentation, batch collection script, CSV contracts, Python analyzer, and methodology documents. Follow `performance-harness/README.md` on that branch. Do not run performance commands copied from the benchmarking branch on `main`; the required scripts and instrumented runtime are intentionally absent here.

## Known limitations

- Cross-realm identity, prototype equality, symbols, function source text, and native internal slots cannot always be reproduced transparently.
- Arguments supplied by the host can convey authority into the sandbox if they reference privileged host objects.
- Configured bare package imports are redirected; package subpath imports are not currently covered by the isolation boundary. See the [import coverage and cache limitations](docs/architecture/isolation-coverage-and-cache-limitations.md).
- Shared mutable host objects exposed to multiple sandboxes are not yet guaranteed to receive independent membrane wrappers. See the [import coverage and cache limitations](docs/architecture/isolation-coverage-and-cache-limitations.md).
- Proxy generation depends on the package's declarations and falls back to `@types/<package>` where available.
- The runtime uses a 1 ms interval to execute pending QuickJS jobs. The interval is unreferenced after proxy initialization in Node.js and remains part of the sandbox lifecycle until disposal.
- Generated default-export behaviour depends on the export patterns detected by the declaration parser.
- The prototype demonstrates isolation and compatibility for the evaluated libraries; it does not establish compatibility with arbitrary npm packages or production hardening.

## Repository map

| Path | Purpose |
|---|---|
| `webpack-sandbox-plugin/src/` | Webpack plugin, declaration parser, and proxy generator |
| `.sandbox/core/` | QuickJS/Arena lifecycle and capability exposure |
| `.sandbox/membrane/` | Forward and reverse boundary wrappers |
| `.sandbox/marshallers/` | Registered cross-runtime type conversions |
| `.sandbox/sandbox.config.js` | Per-library permissions and optional workloads |
| `test-sandbox-redirect/` | ESM and CommonJS redirection for compatibility suites |
| `compatibility-harness/` | Campaign manifest, runners, parsers, and unit tests |
| `lib-test/security/app/` | Isolated browser security validation application |
| `docs/` | Developer documentation and versioned PlantUML diagrams |
| `dist/`, `.sandbox/proxys/` | Generated output; never edit or commit |

Start with the [documentation index](docs/README.md), [contribution guide](CONTRIBUTING.md), [security policy](SECURITY.md), and [code of conduct](CODE_OF_CONDUCT.md). Architectural changes must also update [architectural-decisions.md](docs/architecture/architectural-decisions.md).

## Acknowledgements

Developed by Rafael Gomes under the academic supervision of Professor Nuno Pereira ([Nuno Pereira](https://github.com/nampereira)), ISEP.
The supervisor provided guidance on the research direction and selected design decisions.
