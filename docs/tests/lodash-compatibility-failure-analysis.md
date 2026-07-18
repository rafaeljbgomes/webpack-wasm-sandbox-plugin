# Lodash Compatibility Failure Analysis

## Purpose and Evidence

This note consolidates the principal failure categories observed when the Lodash test suite executes through the QuickJS sandbox. It provides an evidence base for later dissertation writing and should not be treated as final thesis prose.

The analysis uses the final output stored in `test-harness/lodash/sandbox-tests-results.txt`. The QUnit summary reports assertion-level counts:

- 6,734 assertions executed;
- 5,397 assertions passed;
- 1,337 assertions failed;
- 80.14% of assertions passed.

The result is consistent with the earlier measurement of 5,403 passing assertions out of 6,734. The difference is six assertions. The final run did not contain the stack overflow, WebAssembly memory corruption, or QuickJS reference-count abort observed while the experimental collection marshaller was enabled.

The `qunit-extras` reporter prints earlier failures in a module again when a later test fails. The counts below therefore result from reconstructing the incremental assertion failures rather than counting every printed `FAIL` line.

## Principal Failure Categories

| Failure category | Failed assertions | Share of failures | Main interpretation |
|---|---:|---:|---|
| Boolean outcomes, identity predicates, and `instanceof` checks | 384 | 28.7% | Predicates that depend on same-realm prototypes or stable reference identity can return a different result across the boundary. |
| Object deep comparison and reference identity | 305 | 22.8% | Values that are logically equivalent can have different host wrappers, prototypes, or identities and therefore fail `deepEqual` or `strictEqual`. |
| Other array, numeric, and value mismatches | 232 | 17.4% | Marshalling, callback wrapping, argument representation, or chained-call behavior can alter the observed shape or value. These failures are heterogeneous and require case-by-case interpretation. |
| Runtime exceptions during a test | 205 | 15.3% | The main causes are returned values that are no longer callable and native built-ins whose internal slots cannot be accessed through a proxy. |
| Assertion-count shortfalls after an exception | 101 | 7.6% | These are secondary failures: a test terminates early and executes fewer assertions than declared. |

The remaining failures are distributed among values unexpectedly becoming `undefined` (33), exception-type identity (24), function identity or source comparison (23), Symbol identity (21), and `null` versus `undefined` (5).

## Relationship to the Sandbox Design

The prototype combines Arena marshalling with a reverse membrane. Primitive values and supported data structures cross the boundary through marshalling. Objects returned by the library can be pinned in the QuickJS context and exposed through host proxies. Method calls are then routed back to the original QuickJS object. This mechanism preserves the QuickJS receiver used as `this`, which is necessary for methods that depend on private fields or internal library state.

This mechanism does not provide complete end-to-end reference identity. The same logical QuickJS value can be represented by different host wrappers after separate crossings. Similarly, a host object passed into QuickJS and later returned is not guaranteed to be the original host reference. This limitation explains failures such as:

- `returnedValue === originalValue` evaluating to `false`;
- aliases of the same function receiving distinct host wrappers;
- cache operations failing when object or Symbol keys depend on reference equality;
- `instanceof` evaluating against a host prototype that differs from the QuickJS prototype;
- deep comparisons observing different prototypes or proxy shells despite equivalent data.

Symbols are especially sensitive because their semantics depend on unique identity. Recreating a Symbol with the same description does not recreate the same Symbol. Native objects such as `Map`, `Set`, `ArrayBuffer`, `DataView`, and boxed primitive objects also contain engine-managed internal slots. A generic proxy cannot reproduce these slots, so native methods can reject the proxy as an incompatible receiver.

Some tests also expect an exception to satisfy checks such as `error instanceof TypeError`. An exception raised inside QuickJS may reach the host as a bridge-specific error representation. The operation can therefore reject the input correctly while the assertion still fails because the host-visible exception has a different identity or constructor.

## Interpretation in the Prototype Context

The result demonstrates broad compatibility across Lodash's large API surface: 80.14% of the evaluated assertions pass while the library executes in an isolated QuickJS context. The failures are concentrated in behavior that is particularly sensitive to crossing an execution-realm boundary, including referential equality, prototype identity, native internal slots, exception identity, and callable composition.

These limitations are acceptable for the current prototype phase because the principal objective is to demonstrate policy-controlled isolation of untrusted third-party code while retaining substantial API compatibility. Sharing the original host objects directly would improve same-realm identity behavior but would weaken the isolation boundary that the prototype is intended to evaluate. The reverse membrane therefore prioritizes executing library methods on their original QuickJS receivers instead of reproducing every host-observable identity property.

This interpretation does not imply production readiness or that every failed assertion is unimportant. Value mismatches and callable failures can affect application behavior and must be assessed according to the APIs used by a concrete application. The result instead establishes that the current design supports a large proportion of Lodash behavior and makes the remaining limitations explicit and technically explainable.

## Future Improvement Areas

The dominant limitations indicate the following future work:

- introduce canonical bidirectional mappings between host references and QuickJS values when end-to-end identity is required;
- preserve function and Symbol identity across repeated crossings;
- translate QuickJS exceptions into the corresponding host error constructors;
- implement focused marshalling for native types such as `ArrayBuffer` and `DataView` without reintroducing the instability of a generic collection marshaller;
- strengthen returned-callable and chained-call handling;
- evaluate compatibility per application workload in addition to using the complete upstream suite.

The complete upstream suite should remain unmodified when reporting the primary compatibility result. Sandbox-aware assertion adaptations may be useful for diagnostics, but they must be reported separately because they change the semantics measured by the original tests.
