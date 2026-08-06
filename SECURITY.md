# Security Policy

## Supported Versions

This repository is an experimental research prototype. Security fixes are
considered for the latest release and the current `main` branch on a best-effort
basis. No security support period or service-level agreement is provided.

| Version | Supported |
| --- | --- |
| Latest release | Yes, best effort |
| `main` | Yes, best effort |
| Earlier releases and forks | No |

## Reporting a Vulnerability

Please do not report suspected vulnerabilities in a public GitHub issue,
discussion, pull request, or other public channel.

Use the repository's [private vulnerability reporting form](https://github.com/rafaeljbgomes/webpack-wasm-sandbox-plugin/security/advisories/new).
If private reporting is unavailable, contact the maintainer using the contact
details on [Rafael Gomes's GitHub profile](https://github.com/rafaeljbgomes)
and ask for a private reporting channel. Do not include exploit details in a
public message.

Include, where possible:

- a clear description of the affected component and security impact;
- the affected revision, package version, browser, and operating system;
- minimal reproduction steps or a proof of concept;
- the expected and observed behaviour; and
- any proposed remediation or disclosure constraints.

Reports are acknowledged on a best-effort basis. The maintainer will assess
reproducibility and impact, discuss a fix or mitigation where appropriate, and
coordinate disclosure with the reporter. Please allow reasonable time for a
response before publishing details.

## Scope and Security Model

`webpack-wasm-sandbox-plugin` is a browser-side Webpack plugin that executes
configured npm libraries in separate QuickJS WebAssembly contexts. Its intended
security property is that a configured library does not automatically inherit
the host page's global authority. Host globals are deny-by-default and are
exposed only when selected in `.sandbox/sandbox.config.js`.

In scope are vulnerabilities that cause an attacker-controlled or compromised
configured library to cross that boundary, including:

- access to an unconfigured host global or browser capability;
- mutation of host-realm globals or prototypes from an isolated QuickJS context;
- escape from the configured library's QuickJS context into the host page or
  another library context;
- bypass of exact configured-package import replacement that exposes a
  configured library to the host realm; and
- unsafe capability exposure, membrane, marshalling, or lifecycle behaviour
  with a realistic host-page security effect.

Reports should identify the attacker-controlled input, the boundary crossed,
and the observable host impact. The browser security validation fixture under
`lib-test/security/app/` is a safe place to add or adapt reproducible scenarios;
its patches are controlled simulations, not evidence that an unmodified
dependency is malicious.

## Known Limitations and Out of Scope

The prototype is not a production security product and does not currently
provide CPU, memory, execution-time, process, or browser-level quotas. It does
not establish the safety or integrity of arbitrary npm packages, offer complete
cross-realm JavaScript equivalence, or guarantee compatibility for every
package.

The following limitations are documented design boundaries rather than, by
themselves, vulnerabilities:

- an object deliberately supplied by the host to a library can convey the
  authority reachable through that object;
- only exact configured bare package imports are redirected; package subpath
  imports are not covered by the current isolation boundary;
- shared mutable host objects exposed to multiple sandboxes do not yet receive
  independently guaranteed membrane wrappers; and
- a configured capability may be unsafe if the host application grants more
  authority than the library requires.

These limitations may still be reportable when a vulnerability allows an
attacker to exceed the documented boundary without an explicit host grant, or
when there is a materially different and previously undocumented impact.

For the authoritative architecture and limitation details, see the
[sandbox plugin specification](docs/architecture/sandbox-plugin-spec-v2.md),
[host-argument capability limitation](docs/architecture/host-argument-capability-limitation.md),
and [import coverage and cache limitations](docs/architecture/isolation-coverage-and-cache-limitations.md).
