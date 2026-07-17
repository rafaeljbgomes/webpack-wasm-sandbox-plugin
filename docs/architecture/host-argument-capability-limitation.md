# Host Argument Capability Transfer Limitation

## Context

The sandbox design controls the ambient host Web APIs that a sandboxed library can access. A library only receives configured globals such as `console`, `Intl`, `TextEncoder`, `localStorage`, `crypto`, or other browser/Node APIs when they are listed in `.sandbox/sandbox.config.js`.

This document records an important boundary limitation in the current membrane design: values explicitly passed by the host application into a sandboxed library are not governed by the same Web API permission list.

## Current Boundary

The current implementation protects against undeclared ambient API access. For example, if a library is configured with:

```js
"some-library": {
  permissions: []
}
```

then the sandbox runtime does not expose host globals such as `fetch`, `document`, `localStorage`, or `crypto` to that library through the permission membrane.

However, when host code calls a sandboxed library API, the generated proxy forwards the call arguments across the Arena bridge. This path is different from Web API exposure. Configured Web APIs are explicitly wrapped with the forward membrane and passed through `arena.sync(...)`; ordinary call arguments are marshalled by Arena as call inputs.

For ordinary objects, this usually means that Arena creates corresponding values in the QuickJS heap rather than exposing the original host object as a live synchronized object. In that case, mutating the object inside QuickJS does not automatically mutate the original host object.

The capability concern is narrower: if the host passes functions, accessors, prototype methods, or objects whose behavior is represented by callable properties during marshalling, sandboxed code may be able to trigger that host behavior. That is different from saying that every host object becomes a live mutation capability.

In practice:

```js
sandboxedLibrary.process(data, {
  onResult(result) {
    hostState.save(result);
  },
  logger,
  storageClient,
});
```

The sandboxed library cannot reach `hostState`, `logger`, or `storageClient` by itself. Whether the sandbox can directly affect those values depends on how the value is marshalled. Plain data is copied or reconstructed into QuickJS-side values, while callable/accessor behavior may still cross as executable host behavior. This is a capability-transfer caveat around host-provided values, not an escape from the QuickJS heap or a failure of the configured global Web API exposure mechanism.

## Security Interpretation

This limitation should be interpreted precisely:

- The sandbox enforces configured ambient Web API exposure.
- Ordinary host objects passed as arguments are not the same as `arena.sync(...)` Web API exposures.
- Plain object mutation inside QuickJS should not automatically mutate the original host object.
- The sandbox does not automatically strip authority from host-provided callable or accessor behavior.
- Passing a callback, accessor-bearing object, or method-bearing object into a sandboxed library may transfer execution capability.
- The developer using the sandbox is not assumed to be the attacker, but a malicious or compromised dependency can use authority-bearing behavior that the developer passes to it.

This means the current security claim should not be stated as:

> A sandboxed library cannot execute or influence host code under any circumstances.

A more accurate claim is:

> A sandboxed library cannot access ambient host Web APIs unless they are explicitly exposed by configuration. Host-provided callable or accessor behavior may still transfer capabilities, so developers should treat callbacks and behavior-bearing objects passed into sandboxed libraries as intentional authority grants.

## Prototype Pollution Boundary

Prototype pollution that occurs only inside QuickJS should not directly propagate to the host. The sandbox has its own heap and its own intrinsic objects, so changing `Object.prototype` inside the sandbox does not mutate the host `Object.prototype`.

Similarly, when a normal plain host object is passed as an argument, Arena marshalling creates QuickJS-side object state for the call. Mutating that QuickJS-side object, including attempts to assign `__proto__`, should not automatically mutate the original host object's prototype or the host global prototypes.

There are still two caveats:

- If the host explicitly exposes a value through `arena.sync(...)`, synchronization semantics apply and the exposed value should be treated as a deliberate host capability.
- If sandbox-produced data containing keys such as `__proto__`, `constructor`, or `prototype` is later consumed by unsafe host-side merge code, the pollution risk belongs to that later host-side merge operation rather than to automatic propagation through the QuickJS heap boundary.

The current implementation should therefore be described as preventing direct propagation of sandbox-internal prototype pollution to host prototypes under normal marshalling. The remaining concern is executable behavior crossing the boundary, not ordinary object prototype mutation crossing automatically.

## Compatibility Rationale

Rejecting all callbacks and non-plain objects at the host-to-VM boundary would create a stronger security boundary, but it would also significantly reduce compatibility. Many JavaScript libraries legitimately accept:

- callbacks,
- custom comparators,
- parser hooks,
- validators,
- logger objects,
- class instances,
- options objects with methods,
- framework-specific objects.

Because this prototype aims to balance security with transparent developer compatibility, the current behavior favors compatibility and documents the remaining capability-transfer risk rather than blocking these values by default.

## Developer Guidance

When using the current sandbox mode:

- Pass plain data whenever possible.
- Avoid passing service objects, storage clients, network clients, DOM nodes, or application state managers into untrusted libraries unless their methods are intentionally part of the library's authority.
- Treat every callback passed into a sandboxed library as code that the library can trigger.
- Treat getters and setters on argument objects as behavior, not inert data.
- Prefer narrow callbacks over broad objects. For example, pass `onResult(value)` instead of a whole application service object.
- Keep configured Web API permissions and host-passed capabilities conceptually separate.

## Design Consequence

This limitation does not invalidate the core sandbox objective of controlling ambient Web API access. It does mean that the membrane is not a full object-capability attenuation system in the current transparent mode.

Future production-oriented modes can strengthen this boundary, but they should be opt-in or policy-driven so they do not undermine the compatibility goal of the prototype.
