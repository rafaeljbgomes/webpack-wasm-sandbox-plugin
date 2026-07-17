import { LibraryData } from "./domain/types";

export interface ProxyWorkload {
  workloadName: string;
  exports: string[];
}

export class ProxyGenerator {
  public generate(
    libraryData: LibraryData,
    libraryName: string,
    workloads: ProxyWorkload[] = [],
  ): string {
    let content = `// Auto-generated Sandbox Proxy for ${libraryName}\n`;
    content += `import { SandboxManager } from "../core/sandbox-manager.js";\n\n`;

    // 1. Core Sandbox Initialization using Top-Level Await
    content += `// 1. Load library bundle (Node.js or browser)\n`;
    content += `let libraryCode;\n`;
    content += `if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `  const { readFileSync } = await import('fs');\n`;
    content += `  const { resolve, dirname } = await import('path');\n`;
    content += `  const { fileURLToPath } = await import('url');\n`;
    content += `  const __proxyDir = dirname(fileURLToPath(import.meta.url));\n`;
    content += `  const __projectRoot = resolve(__proxyDir, '..', '..');\n`;
    content += `  libraryCode = readFileSync(resolve(__projectRoot, 'dist', '${libraryName}.bundle.js'), 'utf-8');\n`;
    content += `} else {\n`;
    content += `  libraryCode = await fetch('/dist/${libraryName}.bundle.js').then(r => r.text());\n`;
    content += `}\n`;
    content += `\n`;

    content += `// 2. Initialize QuickJS Wasm Sandbox\n`;
    content += `const librarySandbox = await SandboxManager.createSandbox(\n`;
    content += `  "${libraryName}",\n`;
    content += `  libraryCode\n`;
    content += `);\n\n`;
    content += `// Allow Node.js to exit after initialization (pump was kept ref'd during await)\n`;
    content += `if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `  librarySandbox.unrefPump();\n`;
    content += `}\n\n`;
    content += `const proxyExports = librarySandbox.exports;\n\n`;
    content += this.generateWorkloadAccessHelpers(libraryName, workloads);

    // 2a. Callable singleton export — `export = identifier` pattern (e.g. lodash `_`).
    // proxyExports IS the exported value (e.g. the _ function).  Emit a single default
    // export with apply + get + construct traps so both _(value) and _.map() work.
    if (libraryData.callableSingletonExport) {
      content += `// Callable singleton — library uses \`export = ${libraryData.callableSingletonExport}\`.\n`;
      content += `// proxyExports is the exported value itself; expose it as the default export\n`;
      content += `// with an apply trap so \`_(value)\` works for chaining, and a get trap for\n`;
      content += `// \`_.map\`, \`_.filter\`, etc. (delegated to bindSandboxExport's get trap).\n`;
      content += `let _callFn;\n`;
      content += `function _callable_target() {}\n`;
      content += `export default new Proxy(_callable_target, {\n`;
      content += `  apply(_t, _thisArg, args) {\n`;
      content += `    _callFn ??= librarySandbox.arena.evalCode(\`(...args) => __SANDBOXED_LIB__(...args)\`);\n`;
      content += `    return librarySandbox.wrapResult(_callFn(...args));\n`;
      content += `  },\n`;
      content += `  get(_t, key, receiver) {\n`;
      content += `    if (typeof key === "symbol") return Reflect.get(proxyExports, key, receiver);\n`;
      content += `    if (key === "prototype") return Reflect.get(_t, key, receiver);\n`;
      content += `    return proxyExports[key];\n`;
      content += `  },\n`;
      content += `  construct(_t, args) {\n`;
      content += `    _callFn ??= librarySandbox.arena.evalCode(\`(...args) => __SANDBOXED_LIB__(...args)\`);\n`;
      content += `    return librarySandbox.wrapResult(_callFn(...args));\n`;
      content += `  },\n`;
      content += `});\n\n`;

      content += `// Sandbox Lifecycle Management\n`;
      content += `export function disposeLibrary() {\n`;
      content += `  if (librarySandbox) {\n`;
      content += `    librarySandbox.dispose();\n`;
      content += `  }\n`;
      content += `}\n`;
      return content;
    }

    // Keep track of exported names to handle TS overloads or multiple files
    const exportedNames = new Set<string>();

    // 2b. Export Everything (Functions, Classes, Namespaces, Variables)
    libraryData.exportedNames.forEach((name) => {
      if (exportedNames.has(name)) {
        return; // Skip duplicates
      }
      exportedNames.add(name);

      if (name === "default") {
        // Find the first named (non-default) export to use as a fallback constructor
        // when proxyExports.default is a singleton object rather than a class.
        const fallbackName = libraryData.exportedNames.find((n) => n !== "default") ?? null;
        const fallbackExpr = fallbackName
          ? `(typeof proxyExports.${fallbackName} === "function" ? proxyExports.${fallbackName} : null)`
          : `null`;
        const fallbackCtorKey = fallbackName ?? "default";

        content += `// Default Export\n`;
        content += `// If proxyExports.default is a singleton (not a constructor), fall back to the\n`;
        content += `// first named class export so that both \`new Default()\` and singleton method\n`;
        content += `// access (\`default.someMethod()\`) work via the get-trap fallthrough.\n`;
        content += `const _defaultProxyTarget = typeof proxyExports.default === "function"\n`;
        content += `  ? proxyExports.default\n`;
        content += `  : ${fallbackExpr};\n`;
        content += `const _defaultSingleton = typeof proxyExports.default !== "function" ? proxyExports.default : null;\n`;
        content += `// Plain constructable function as Proxy target: Arena-wrapped QJS functions are\n`;
        content += `// arrow functions (no [[Construct]]), so using them directly as Proxy target\n`;
        content += `// makes the Proxy non-constructable even when a construct trap is present.\n`;
        content += `function _default_target() {}\n`;
        content += `export default _defaultProxyTarget\n`;
        content += `  ? new Proxy(_default_target, {\n`;
        content += `      apply(_target, _thisArg, args) {\n`;
        content += `        return _defaultProxyTarget(...args);\n`;
        content += `      },\n`;
        content += `      construct(_target, args) {\n`;
        content += `        const ctorKey = typeof proxyExports.default === "function" ? "default" : "${fallbackCtorKey}";\n`;
        content += `        return librarySandbox.createInstance(ctorKey, args);\n`;
        content += `      },\n`;
        content += `      get(_target, key, receiver) {\n`;
        content += `        if (typeof key === "symbol") return Reflect.get(_target, key, receiver);\n`;
        content += `        if (key === "prototype") return Reflect.get(_target, key, receiver);\n`;
        content += `        const val = _defaultProxyTarget?.[key];\n`;
        content += `        if (val !== undefined) return val;\n`;
        content += `        return _defaultSingleton?.[key];\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : proxyExports.default;\n\n`;
      } else {
        const safeName = name.replace(/[^a-zA-Z0-9_$]/g, '_');
        const safeIdentifier = `_export_${safeName}`;
        content += `// Export: ${name}\n`;
        content += `// Plain constructable function as Proxy target — see default export comment.\n`;
        content += `function _${safeName}_target() {}\n`;
        content += `const ${safeIdentifier} = typeof proxyExports["${name}"] === "function"\n`;
        content += `  ? new Proxy(_${safeName}_target, {\n`;
        content += `      apply(_target, _thisArg, args) {\n`;
        content += `        return proxyExports["${name}"](...args);\n`;
        content += `      },\n`;
        content += `      construct(_target, args) {\n`;
        content += `        return librarySandbox.createInstance("${name}", args);\n`;
        content += `      },\n`;
        content += `      get(_target, key, receiver) {\n`;
        content += `        if (typeof key === "symbol") return Reflect.get(proxyExports["${name}"], key, receiver);\n`;
        content += `        if (key === "prototype") return Reflect.get(_target, key, receiver);\n`;
        content += `        return proxyExports["${name}"][key];\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : proxyExports["${name}"];\n`;
        // Using quotes in export { _val as "name" } is only supported in very modern ES, but
        // exporting reserved words like export { _val as null } is supported.
        content += `export { ${safeIdentifier} as ${name} };\n\n`;
      }
    });

    // 3. Dispose utility
    content += `// Sandbox Lifecycle Management\n`;
    content += `export function disposeLibrary() {\n`;
    content += `  if (librarySandbox) {\n`;
    content += `    librarySandbox.dispose();\n`;
    content += `  }\n`;
    content += `}\n`;

    return content;
  }

  private generateWorkloadAccessHelpers(
    libraryName: string,
    workloads: ProxyWorkload[],
  ): string {
    if (workloads.length === 0) {
      return "";
    }

    let content = `const workloadManifest = {\n`;
    for (const workload of workloads) {
      content += `  "${workload.workloadName}": {\n`;
      content += `    globalName: "__SANDBOXED_WORKLOAD_${this.toSafeGlobalName(workload.workloadName)}__"\n`;
      content += `  },\n`;
    }
    content += `};\n\n`;

    content += `async function loadWorkloadBundle(workloadName) {\n`;
    content += `  const bundleName = \`${libraryName}.\${workloadName}.workload.bundle.js\`;\n`;
    content += `  if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `    const { readFileSync } = await import('fs');\n`;
    content += `    const { resolve, dirname } = await import('path');\n`;
    content += `    const { fileURLToPath } = await import('url');\n`;
    content += `    const __proxyDir = dirname(fileURLToPath(import.meta.url));\n`;
    content += `    const __projectRoot = resolve(__proxyDir, '..', '..');\n`;
    content += `    return readFileSync(resolve(__projectRoot, 'dist', bundleName), 'utf-8');\n`;
    content += `  }\n`;
    content += `  return fetch(\`/dist/\${bundleName}\`).then(r => r.text());\n`;
    content += `}\n`;
    content += `\n`;
    content += `export async function __getSandboxWorkloadExport(workloadName, exportName) {\n`;
    content += `  const manifest = workloadManifest[workloadName];\n`;
    content += `  if (!manifest) {\n`;
    content += `    throw new Error(\`Sandbox workload not configured: \${workloadName}\`);\n`;
    content += `  }\n`;
    content += `  if (!librarySandbox.workloads[workloadName]) {\n`;
    content += `    librarySandbox.loadWorkload({\n`;
    content += `      name: workloadName,\n`;
    content += `      globalName: manifest.globalName,\n`;
    content += `      code: await loadWorkloadBundle(workloadName)\n`;
    content += `    });\n`;
    content += `  }\n`;
    content += `  const workload = librarySandbox.workloads[workloadName];\n`;
    content += `  if (!workload) {\n`;
    content += `    throw new Error(\`Sandbox workload not found: \${workloadName}\`);\n`;
    content += `  }\n`;
    content += `  const exportedValue = workload[exportName];\n`;
    content += `  if (exportedValue === undefined) {\n`;
    content += `    throw new Error(\`Sandbox workload export not found: \${workloadName}.\${exportName}\`);\n`;
    content += `  }\n`;
    content += `  return exportedValue;\n`;
    content += `}\n\n`;
    return content;
  }

  private toSafeGlobalName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_$]/g, "_");
  }
}
