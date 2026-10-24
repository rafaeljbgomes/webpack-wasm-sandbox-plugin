# Documentation Index

This index covers the maintained documentation for users and contributors. The [project README](../README.md) is the onboarding entry point, and [sandbox-plugin-spec-v2.md](architecture/sandbox-plugin-spec-v2.md) is the canonical technical description of the current implementation.

## Developer documentation

| Document | Status | Purpose |
|---|---|---|
| [Project README](../README.md) | Canonical onboarding | Scope, setup, workflows, limitations, and repository map |
| [Contributing](../CONTRIBUTING.md) | Operational | Contribution and validation rules |
| [Security policy](../SECURITY.md) | Operational | Private vulnerability reporting, security scope, and known boundary limitations |
| [Code of Conduct](../CODE_OF_CONDUCT.md) | Operational | Community participation and enforcement standards |
| [Repository agent guide](../AGENTS.md) | Operational | Concise repository instructions for coding agents |
| [Sandbox plugin specification](architecture/sandbox-plugin-spec-v2.md) | Canonical architecture | Build-time and runtime design, interfaces, and limitations |
| [Architectural decisions](architecture/architectural-decisions.md) | Living historical record | Rationale and consequences of material design decisions |
| [Compatibility testing](architecture/compat-testing-plan.md) | Operational architecture | Automated campaign design and library onboarding |
| [Compatibility harness guide](../compatibility-harness/README.md) | Operational | Commands, strategies, and generated result artifacts |
| [Capability advisor guide](../capability-advisor/README.md) | Operational, experimental | SubQ System One preparation, evidence handling, reviewed drafts and cache behavior |
| [Capability advisor validation](../capability-advisor/VALIDATION.md) | Scoped validation snapshot | Implementation checks, browser scenarios and unmeasured model accuracy |
| [Host-argument capability limitation](architecture/host-argument-capability-limitation.md) | Current limitation | Authority conveyed through host-supplied arguments |
| [Import coverage and cache limitations](architecture/isolation-coverage-and-cache-limitations.md) | Current limitation | Exact import matching, shared membrane cache scope, and future hardening |
| [Strict host-argument modes](architecture/host-argument-strict-mode-future-work.md) | Future work | Candidate attenuation designs; none are implemented |
| [Security validation application](../lib-test/security/app/README.md) | Operational | Reproducible native and sandbox security scenarios |
| [Unit regression suite design](architecture/unit-test-suite-design.md) | Partially implemented; remainder future work | Fast, hermetic runtime and plugin tests; step 1 implemented, steps 2–4 planned |

## Architecture diagrams

Architecture diagrams are maintained directly as PlantUML source files under `docs/diagrams/`. The `.puml` files are the versioned source of truth; generated images are not committed, and there is no parallel Markdown diagram specification.

| PlantUML source | View |
|---|---|
| [build-time-architecture.puml](diagrams/build-time-architecture.puml) | Webpack build and import-replacement sequence |
| [component-architecture.puml](diagrams/component-architecture.puml) | Logical components and boundary directions |
| [deployment-architecture.puml](diagrams/deployment-architecture.puml) | Build, host JavaScript, and QuickJS/WebAssembly deployment view |
| [implementation-architecture.puml](diagrams/implementation-architecture.puml) | Source-package relationships |
| [runtime-architecture.puml](diagrams/runtime-architecture.puml) | Library initialization and mediated host calls |
| [coarse-grained-runtime.puml](diagrams/coarse-grained-runtime.puml) | Optional workload-adapter execution |
| [vm-host-membrane.puml](diagrams/vm-host-membrane.puml) | Reverse membrane calls from the host to isolated exports |
| [authorized-webapi.puml](diagrams/authorized-webapi.puml) | Permission-selected host capability exposure |

Render the diagrams with any compatible PlantUML tool. When architecture changes, update the relevant `.puml` source together with the canonical specification and architectural decision record.

## Performance branch

The instrumented performance implementation is maintained on `feat/sandbox-benchmarking`, not `main`. Use a separate checkout or worktree and follow `performance-harness/README.md` on that branch for native-versus-sandbox collection and analysis. Its commands and instrumented boundary-crossing runtime are intentionally not duplicated in the uninstrumented `main` documentation.
