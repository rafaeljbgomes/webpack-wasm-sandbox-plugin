# Documentation Index

This index covers the maintained documentation for users and contributors. The [project README](../README.md) is the onboarding entry point, and [sandbox-plugin-spec-v2.md](architecture/sandbox-plugin-spec-v2.md) is the canonical technical description of the current implementation.

## Developer documentation

| Document | Status | Purpose |
|---|---|---|
| [Project README](../README.md) | Canonical onboarding | Scope, setup, workflows, limitations, and repository map |
| [Contributing](../CONTRIBUTING.md) | Operational | Contribution and validation rules |
| [Repository agent guide](../AGENTS.md) | Operational | Concise repository instructions for coding agents |
| [Sandbox plugin specification](architecture/sandbox-plugin-spec-v2.md) | Canonical architecture | Build-time and runtime design, interfaces, and limitations |
| [Architectural decisions](architecture/architectural-decisions.md) | Living historical record | Rationale and consequences of material design decisions |
| [Compatibility testing](architecture/compat-testing-plan.md) | Operational architecture | Automated campaign design and library onboarding |
| [Compatibility harness guide](../compatibility-harness/README.md) | Operational | Commands, strategies, and generated result artifacts |
| [Host-argument capability limitation](architecture/host-argument-capability-limitation.md) | Current limitation | Authority conveyed through host-supplied arguments |
| [Import coverage and cache limitations](architecture/isolation-coverage-and-cache-limitations.md) | Current limitation | Exact import matching, shared membrane cache scope, and future hardening |
| [Strict host-argument modes](architecture/host-argument-strict-mode-future-work.md) | Future work | Candidate attenuation designs; none are implemented |
| [Security validation application](../lib-test/security/app/README.md) | Operational | Reproducible native and sandbox security scenarios |

## Architecture diagrams

Architecture diagrams are maintained directly as PlantUML source files under `docs/diagrams/`. The `.puml` files are the versioned source of truth; generated images are not committed, and there is no parallel Markdown diagram specification.

| PlantUML source | View |
|---|---|
| [arquitetura-build-time.puml](diagrams/arquitetura-build-time.puml) | Webpack build and import-replacement sequence |
| [arquitetura-componentes.puml](diagrams/arquitetura-componentes.puml) | Logical components and boundary directions |
| [arquitetura-deployment.puml](diagrams/arquitetura-deployment.puml) | Build, host JavaScript, and QuickJS/WebAssembly deployment view |
| [arquitetura-implementacao.puml](diagrams/arquitetura-implementacao.puml) | Source-package relationships |
| [arquitetura-runtime.puml](diagrams/arquitetura-runtime.puml) | Library initialization and mediated host calls |
| [coarse-grained-runtime.puml](diagrams/coarse-grained-runtime.puml) | Optional workload-adapter execution |
| [membrana-vm-host.puml](diagrams/membrana-vm-host.puml) | Reverse membrane calls from the host to isolated exports |
| [webapi-autorizada.puml](diagrams/webapi-autorizada.puml) | Permission-selected host capability exposure |

Render the diagrams with any compatible PlantUML tool. When architecture changes, update the relevant `.puml` source together with the canonical specification and architectural decision record.

## Performance branch

The instrumented performance implementation is maintained on `feat/sandbox-benchmarking`, not `main`. Use a separate checkout or worktree and follow `performance-harness/README.md` on that branch for native-versus-sandbox collection and analysis. Its commands and instrumented boundary-crossing runtime are intentionally not duplicated in the uninstrumented `main` documentation.
