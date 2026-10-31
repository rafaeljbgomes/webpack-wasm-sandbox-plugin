import { LibraryData } from "./domain/types";
import { isIdentifierName, toJsStringLiteral, toModuleExportName } from "./utils/source-literals";

/** Workload metadata used when generating lazy proxy accessors. */
export interface ProxyWorkload {
  /** Policy key identifying the workload within its library sandbox. */
  workloadName: string;
  /** Workload exports made available to host code. */
  exports: string[];
}

/** Produces ESM proxy modules backed by a per-library QuickJS sandbox. */
export class ProxyGenerator {
  /**
   * Generates the complete proxy module for one configured dependency.
   *
   * @param libraryData Runtime export information parsed from declarations.
   * @param libraryName Package request used to locate the isolated bundle.
   * @param workloads Workloads that share the dependency's sandbox.
   * @param permissions Compiler-selected host capabilities, including an explicit empty policy.
   * @returns JavaScript source for the generated proxy module.
   */
  public generate(
    libraryData: LibraryData,
    libraryName: string,
    workloads: ProxyWorkload[] = [],
    permissions: string[] = [],
  ): string {
    let content = `// Auto-generated Sandbox Proxy for ${toJsStringLiteral(libraryName)}\n`;
    content += `import { SandboxManager } from "../core/sandbox-manager.js";\n\n`;

    content += `// Load the isolated bundle from the active runtime.\n`;
    content += `let libraryCode;\n`;
    content += `if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `  const { readFileSync } = await import('fs');\n`;
    content += `  const { resolve, dirname } = await import('path');\n`;
    content += `  const { fileURLToPath } = await import('url');\n`;
    content += `  const __proxyDir = dirname(fileURLToPath(import.meta.url));\n`;
    content += `  const __projectRoot = resolve(__proxyDir, '..', '..');\n`;
    content += `  libraryCode = readFileSync(resolve(__projectRoot, 'dist', ${toJsStringLiteral(`${libraryName}.bundle.js`)}), 'utf-8');\n`;
    content += `} else {\n`;
    content += `  libraryCode = await fetch(${toJsStringLiteral(`/dist/${libraryName}.bundle.js`)}).then(r => r.text());\n`;
    content += `}\n`;
    content += `\n`;

    content += `// Initialize the per-library QuickJS context before exposing exports.\n`;
    content += `const librarySandbox = await SandboxManager.createSandbox(\n`;
    content += `  ${toJsStringLiteral(libraryName)},\n`;
    content += `  libraryCode,\n`;
    content += `  { permissions: ${JSON.stringify(permissions)} }\n`;
    content += `);\n\n`;
    content += `// Initialization needs a referenced job pump; steady-state Node.js usage does not.\n`;
    content += `if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `  librarySandbox.unrefPump();\n`;
    content += `}\n\n`;
    content += `const proxyExports = librarySandbox.exports;\n\n`;
    content += this.generateWorkloadAccessHelpers(libraryName, workloads);

    // An `export =` declaration represents one callable value whose properties
    // must remain accessible through the same default export.
    if (libraryData.callableSingletonExport) {
      content += `// Preserve both calls and property access on the callable singleton export.\n`;
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

      content += `/** Disposes the QuickJS context and its boundary resources. */\n`;
      content += `export function disposeLibrary() {\n`;
      content += `  if (librarySandbox) {\n`;
      content += `    librarySandbox.dispose();\n`;
      content += `  }\n`;
      content += `}\n`;
      return content;
    }

    // Declaration files can report the same runtime export more than once.
    const exportedNames = new Set<string>();

    libraryData.exportedNames.forEach((name, index) => {
      if (exportedNames.has(name)) {
        return;
      }
      exportedNames.add(name);
      // Export names come from the dependency's own declarations. They are
      // embedded only as escaped literals, never as raw source text.
      const nameLiteral = toJsStringLiteral(name);

      if (name === "default") {
        // Some declaration sets describe a singleton default alongside the
        // named class that actually supports construction.
        const fallbackName = libraryData.exportedNames.find((n) => n !== "default") ?? null;
        const fallbackAccess = fallbackName ? `proxyExports[${toJsStringLiteral(fallbackName)}]` : null;
        const fallbackExpr = fallbackAccess
          ? `(typeof ${fallbackAccess} === "function" ? ${fallbackAccess} : null)`
          : `null`;
        const fallbackCtorKey = toJsStringLiteral(fallbackName ?? "default");

        content += `// If proxyExports.default is a singleton (not a constructor), fall back to the\n`;
        content += `// first named class export so that both \`new Default()\` and singleton method\n`;
        content += `// access (\`default.someMethod()\`) work via the get-trap fallthrough.\n`;
        content += `const _defaultProxyTarget = typeof proxyExports.default === "function"\n`;
        content += `  ? proxyExports.default\n`;
        content += `  : ${fallbackExpr};\n`;
        content += `const _defaultSingleton = typeof proxyExports.default !== "function" ? proxyExports.default : null;\n`;
        content += `// Use a constructable target because Arena-wrapped QJS functions are\n`;
        content += `// arrow functions (no [[Construct]]), so using them directly as Proxy target\n`;
        content += `// makes the Proxy non-constructable even when a construct trap is present.\n`;
        content += `function _default_target() {}\n`;
        content += `export default _defaultProxyTarget\n`;
        content += `  ? new Proxy(_default_target, {\n`;
        content += `      apply(_target, _thisArg, args) {\n`;
        content += `        return _defaultProxyTarget(...args);\n`;
        content += `      },\n`;
        content += `      construct(_target, args) {\n`;
        content += `        const ctorKey = typeof proxyExports.default === "function" ? "default" : ${fallbackCtorKey};\n`;
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
        // Identifier names keep readable aliases. Other names get positional
        // aliases under a distinct prefix, so two names never share a binding.
        const aliasSuffix = isIdentifierName(name) ? `_${name}` : `String${index}`;
        const safeIdentifier = `_export${aliasSuffix}`;
        const targetIdentifier = `_target${aliasSuffix}`;
        const exportAccess = `proxyExports[${nameLiteral}]`;
        content += `// Use a constructable host target while routing calls into ${nameLiteral}.\n`;
        content += `function ${targetIdentifier}() {}\n`;
        content += `const ${safeIdentifier} = typeof ${exportAccess} === "function"\n`;
        content += `  ? new Proxy(${targetIdentifier}, {\n`;
        content += `      apply(_target, _thisArg, args) {\n`;
        content += `        return ${exportAccess}(...args);\n`;
        content += `      },\n`;
        content += `      construct(_target, args) {\n`;
        content += `        return librarySandbox.createInstance(${nameLiteral}, args);\n`;
        content += `      },\n`;
        content += `      get(_target, key, receiver) {\n`;
        content += `        if (typeof key === "symbol") return Reflect.get(${exportAccess}, key, receiver);\n`;
        content += `        if (key === "prototype") return Reflect.get(_target, key, receiver);\n`;
        content += `        return ${exportAccess}[key];\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : ${exportAccess};\n`;
        // Aliases also support reserved words; other names use the ES2022 string form.
        content += `export { ${safeIdentifier} as ${toModuleExportName(name)} };\n\n`;
      }
    });

    content += `/** Disposes the QuickJS context and its boundary resources. */\n`;
    content += `export function disposeLibrary() {\n`;
    content += `  if (librarySandbox) {\n`;
    content += `    librarySandbox.dispose();\n`;
    content += `  }\n`;
    content += `}\n`;

    return content;
  }

  /**
   * Generates the lazy loader shared by configured workload proxy modules.
   *
   * @param libraryName Owning dependency's package request.
   * @param workloads Workloads available within the dependency sandbox.
   * @returns JavaScript source for the manifest and access helpers.
   */
  private generateWorkloadAccessHelpers(
    libraryName: string,
    workloads: ProxyWorkload[],
  ): string {
    if (workloads.length === 0) {
      return "";
    }

    let content = `const workloadManifest = {\n`;
    for (const workload of workloads) {
      content += `  ${toJsStringLiteral(workload.workloadName)}: {\n`;
      content += `    globalName: "__SANDBOXED_WORKLOAD_${this.toSafeGlobalName(workload.workloadName)}__"\n`;
      content += `  },\n`;
    }
    content += `};\n\n`;

    content += `/** Loads a workload bundle in Node.js or the browser. */\n`;
    content += `async function loadWorkloadBundle(workloadName) {\n`;
    content += `  const bundleName = ${toJsStringLiteral(`${libraryName}.`)} + workloadName + ".workload.bundle.js";\n`;
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
    content += `/** Loads a workload once and returns one of its sandbox-bound exports. */\n`;
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

  /**
   * Converts a policy key into a valid suffix for a generated global name.
   *
   * @param value Workload name from the sandbox policy.
   * @returns A JavaScript-identifier-safe name fragment.
   */
  private toSafeGlobalName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_$]/g, "_");
  }
}
