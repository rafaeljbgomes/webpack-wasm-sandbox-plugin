# Sandbox Membrane Architecture

This document visualizes the bidirectional membrane pattern built around the `quickjs-emscripten-sync` Arena. These diagrams explain how objects, functions, and constructors are safely mapped, cached, and executed across the Host and QuickJS boundary.

## 1. Membrane Architecture & Caching Strategy

This component diagram illustrates the static architecture of the boundary. It shows how the Host and QuickJS environments are isolated, and how the specialized caching layers (`WeakMap` and `Map`) ensure object references are stable and infinite recursion is prevented.

```mermaid
classDiagram
    namespace HostContext {
        class HostApp
        class HostWebAPIs {
            +Intl
            +TextEncoder
            +Crypto
        }
    }

    namespace SandboxMembrane {
        class SandboxManager
        class BindWebApi {
            <<Forward Membrane>>
            -wrapperCache: WeakMap
            +makeCallable()
        }
        class BindSandboxExport {
            <<Reverse Membrane>>
            -exportBindCache: WeakMap
            +bindSandboxFunction()
        }
        class WrapReturned {
            <<Instance Wrapper>>
            -returnedObjCache: WeakMap
            -fnCache: Map
            -propGetterCache: Map
            -hostOverrides: Map
        }
    }

    namespace ArenaBridge {
        class Arena {
            +sync(obj)
            +evalCode(code)
            +customMarshaller
            +customUnmarshaller
        }
    }

    namespace QuickJSContext {
        class QuickJSVM {
            +__SANDBOXED_LIB__
            +__SANDBOX_TEMP__: Map
        }
    }

    HostApp --> BindSandboxExport : Imports generated Proxy
    HostApp --> WrapReturned : Interacts with instances
    
    HostWebAPIs --> BindWebApi : Wrapped before exposure
    BindWebApi --> Arena : Passed to VM
    Arena --> QuickJSVM : Exposed as Globals
    
    QuickJSVM --> Arena : Returns handles
    Arena --> BindSandboxExport : Static exports mapped via Proxy
    Arena --> WrapReturned : Method results mapped via Proxy
```

## 2. Reverse Membrane: Host Consuming QuickJS Objects

This sequence diagram details how a Host application creates a sandboxed class instance and accesses its properties/methods. It specifically highlights the `createInstance` bypass and primitive property evaluation, which ensure that ES2022 private fields and prototype getters (like Luxon's `DateTime.year`) evaluate correctly inside the VM.

```mermaid
sequenceDiagram
    autonumber
    participant Host as Host Application
    participant Proxy as wrapReturned (Host Proxy)
    participant Arena as Arena Bridge
    participant QJS as QuickJS VM (__SANDBOX_TEMP__)

    Note over Host, QJS: 1. Instantiation (Bypassing Host round-trip to preserve WeakMap identity)
    Host->>Arena: createInstance("DateTime", constructorArgs)
    Arena->>QJS: evalCode: new __SANDBOXED_LIB__["DateTime"](...args)
    QJS-->>QJS: Initializes object (ES2022 private fields set)
    QJS-->>QJS: Stores instance in globalThis.__SANDBOX_TEMP__.set(id, obj)
    Arena-->>Host: returns QJS Object Handle
    Host->>Proxy: wrapReturned(handle, preStoredId=id)
    Proxy-->>Host: Returns Proxy representing QJS object

    Note over Host, QJS: 2. Primitive Property Access (e.g., dt.year)
    Host->>Proxy: get "year"
    Proxy->>Proxy: Cache miss in propGetterCache
    Proxy->>Arena: evalCode: () => __SANDBOX_TEMP__.get(id)["year"]
    Arena-->>Proxy: Returns getter closure
    Proxy->>Arena: Executes getter closure
    Arena->>QJS: Evaluates property on live object directly
    QJS-->>Arena: Returns raw primitive (e.g., 2024)
    Arena-->>Proxy: 2024
    Proxy-->>Host: 2024

    Note over Host, QJS: 3. Method Call (e.g., dt.toISODate())
    Host->>Proxy: call toISODate()
    Proxy->>Proxy: Cache miss in fnCache
    Proxy->>Arena: evalCode: (...args) => __SANDBOX_TEMP__.get(id)["toISODate"](...args)
    Arena-->>Proxy: Returns bound method closure
    Proxy->>Arena: Executes bound method
    Arena->>QJS: Executes method preserving true 'this' identity
    QJS-->>Arena: Returns result
    Arena-->>Proxy: Result Handle
    Proxy->>Proxy: maybeWrapResult(result)
    Proxy-->>Host: Result (Primitive or new wrapReturned Proxy)
```

## 3. Forward Membrane: QuickJS Consuming Host WebAPIs

This diagram explains how complex Host WebAPIs are safely exposed to QuickJS. It visualizes the `bindWebApi` wrapper protecting native internal slots, and the `makeCallable` dynamic resolution of the `TypeError` caused when QuickJS invokes a Host constructor via the Arena's strict `Reflect.apply` routing.

```mermaid
sequenceDiagram
    autonumber
    participant QJS as QuickJS VM
    participant Arena as Arena Sync Proxy
    participant Callable as makeCallable Wrapper
    participant BindAPI as bindWebApi Proxy
    participant HostAPI as Host WebAPI (e.g., Intl.DateTimeFormat)

    Note over BindAPI, HostAPI: Sandbox Initialization Phase
    BindAPI->>HostAPI: Walks prototype chain to Object.prototype
    HostAPI-->>BindAPI: Extracts methods
    BindAPI->>Callable: Wraps methods in makeCallable(fn, thisArg)
    BindAPI->>Arena: Passes safe, plain object via arena.sync()
    Arena->>QJS: Injects as Global API

    Note over QJS, HostAPI: Runtime Execution Phase
    QJS->>Arena: calls: new Intl.DateTimeFormat('en-US')
    Note right of Arena: Arena ALWAYS routes to host<br/>via Reflect.apply (without 'new')
    Arena->>Callable: Reflect.apply(DateTimeFormat, Intl, args)
    
    Callable->>HostAPI: Reflect.apply(...)
    HostAPI-->>Callable: throws TypeError
    Note right of Callable: Intercept error & check message<br/>against REQUIRES_NEW_RE regex
    
    Callable->>HostAPI: Reflect.construct(DateTimeFormat, args)
    HostAPI-->>Callable: Returns native Host instance
    
    Callable->>BindAPI: Checks if result is non-TypedArray object
    Note right of BindAPI: Recursively wrapping the returned object<br/>protects its internal slots from Sync Proxies
    Callable->>BindAPI: bindWebApi(Native Instance)
    BindAPI-->>Callable: Returns safe wrapped object
    
    Callable-->>Arena: Wrapped object
    Arena-->>QJS: Sync Proxy to QJS
```
