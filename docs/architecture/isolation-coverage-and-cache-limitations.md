# Prototype Isolation Coverage and Cache Scope Limitations

**Status:** Current limitations of the prototype. See [sandbox-plugin-spec-v2.md](sandbox-plugin-spec-v2.md) for the implemented boundary and [architectural-decisions.md](architectural-decisions.md) for the related build-time decision.

## Scope

The plugin is a research prototype that isolates the evaluated package requests and exposes only policy-selected host capabilities. The following limitations qualify that statement; they do not change the deny-by-default treatment of ambient host globals for an import that is actually redirected to a sandbox proxy.

## Exact Package-Request Coverage

The current import replacement rule matches the configured package request exactly. Configuring `date-fns`, for example, redirects `import "date-fns"`, but does not redirect `import "date-fns/format"` or another package subpath. Such a subpath remains part of the host bundle and is outside the demonstrated isolation boundary.

Developers should use the configured bare package request when relying on the prototype's isolation claim. A configuration entry must resolve at build time; missing, invalid, or unresolvable policy entries now fail the Webpack build rather than silently disabling isolation. That validation does not extend isolation to unredirected subpath imports.

**Future work:** support an explicit, tested policy for package subpaths, or reject subpath imports for configured packages until a corresponding proxy can be generated. Either approach must preserve the package's export shape and be covered by native-versus-sandbox compatibility tests.

## Shared Host-Object Cache Scope

Each configured library receives a separate QuickJS context. However, the current forward and reverse membrane caches are module-scoped. If two sandboxes receive the same mutable host object identity through their permitted capability graphs, a wrapper created for the first sandbox can be reused by the second. The prototype therefore does not yet guarantee independent membrane wrappers for that narrow shared-object scenario.

Developers should avoid exposing the same mutable host object to more than one untrusted library. This limitation is about membrane-wrapper ownership; it does not make an unconfigured browser global available to a sandbox.

**Future work:** scope forward and reverse caches to the owning Arena or sandbox instance, for example with per-Arena `WeakMap` collections or a membrane factory created by `buildSandbox()`. Disposal must release the same per-sandbox state, and regression coverage must exercise two sandboxes sharing one host object.
