# Prototype Isolation Coverage and Cache Scope Limitations

**Status:** Current limitations of the prototype. See [sandbox-plugin-spec-v2.md](sandbox-plugin-spec-v2.md) for the implemented boundary and [architectural-decisions.md](architectural-decisions.md) for the related build-time decision.

## Scope

The plugin is a research prototype that isolates the evaluated package requests and exposes only policy-selected host capabilities. The following limitations qualify that statement; they do not change the deny-by-default treatment of ambient host globals for an import that is actually redirected to a sandbox proxy.

## Exact Package-Request Coverage

The current import replacement rule matches the configured package request exactly. Configuring `date-fns`, for example, redirects `import "date-fns"`, but does not redirect `import "date-fns/format"` or another package subpath. Such a subpath remains part of the host bundle and is outside the demonstrated isolation boundary.

Developers should use the configured bare package request when relying on the prototype's isolation claim. A configuration entry must resolve at build time; missing, invalid, or unresolvable policy entries now fail the Webpack build rather than silently disabling isolation. That validation does not extend isolation to unredirected subpath imports.

**Future work:** support an explicit, tested policy for package subpaths, or reject subpath imports for configured packages until a corresponding proxy can be generated. Either approach must preserve the package's export shape and be covered by native-versus-sandbox compatibility tests.

## Shared Host-Object State

Each configured library receives a separate QuickJS context and, since [AD#29](architectural-decisions.md), its own membrane state: forward and reverse wrapper caches, by-value transfer offers, and `__SANDBOX_TEMP__` identifiers ([specification §6.2](sandbox-plugin-spec-v2.md)). Two sandboxes granted the same mutable host object receive independent wrappers, so a method or property one library adds to its wrapper is not seen or called by another library.

Separate wrappers do not make the host object itself private. A host object granted to several libraries is still one object. Assignments to its existing data properties go through to the host, so every grantee observes them. That includes a function value: if one library writes a function into such a property and another library later calls it, the call runs in the first library's QuickJS context and receives the second library's arguments. The unit suite records this as a `todo` case in `.sandbox/test/membrane-ownership.test.mjs`.

Developers should still avoid granting the same mutable host object to more than one untrusted library. This limitation concerns host state that the developer chose to share; it does not make an unconfigured browser global available to a sandbox.

**Future work:** restrict what QuickJS can write through forward-membrane accessors, for example by rejecting function and non-plain object values or by making write-through an explicit per-capability policy. Either option must preserve the write-through behaviour that the evaluated libraries depend on and be validated by native-versus-sandbox compatibility campaigns.
