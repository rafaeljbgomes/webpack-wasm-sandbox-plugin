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

Separate wrappers do not make the host object itself private. A host object granted to several libraries is still one object, and assignments to its existing properties go through to the host, so every grantee observes them. Since [AD#30](architectural-decisions.md), only primitive values write through. Assigning a function or an object throws a `TypeError` inside QuickJS and leaves the host property unchanged, so one library can no longer leave code, a live QuickJS object, or its own wrapper where another library will read it ([specification §6.2](sandbox-plugin-spec-v2.md)). `.sandbox/test/membrane-ownership.test.mjs` guards all three cases.

Two forms of sharing remain:

- Primitive values one library writes into a granted object are visible to every other grantee. This is data, not code, but it is still a communication channel between libraries.
- The guard covers property assignment through the membrane, not host methods. A host method that stores its arguments, such as `addEventListener()` on a shared event target, can keep a function from one library and later call it with arguments that originate from another library.

Developers should therefore still avoid granting the same mutable host object to more than one untrusted library. This limitation concerns host state that the developer chose to share; it does not make an unconfigured browser global available to a sandbox.

**Future work:** if a library needs to store structured data in a host property, add an explicit by-value copy for plain data rather than relaxing the primitive-only rule. Mediating callbacks stored by host methods would require per-capability facades, in the style of the constrained `crypto` capability.
