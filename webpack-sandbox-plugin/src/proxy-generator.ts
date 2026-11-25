import { LibraryData } from "./domain/types";
import { isIdentifierName, toJsStringLiteral, toModuleExportName } from "./utils/source-literals";
import type { OutputContract } from "./build-helpers";

/** Workload metadata used when generating lazy proxy accessors. */
export interface ProxyWorkload {
  /** Policy key identifying the workload within its library sandbox. */
  workloadName: string;
  /** Workload exports made available to host code. */
  exports: string[];
}

/**
 * Expected digests of the bundles a proxy loads, in Subresource Integrity
 * form (`sha384-<base64>`). Produced by the separate sandbox stage.
 */
export interface BundleIntegrity {
  library?: string;
  workloads?: Record<string, string>;
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
    integrity?: BundleIntegrity,
    writable: Record<string, string[]> = {},
    hasSubpaths = false,
    limits?: { callTimeMs?: number; memoryBytes?: number },
    outputs: Record<string, OutputContract> = {},
  ): string {
    let content = `// Auto-generated Sandbox Proxy for ${toJsStringLiteral(libraryName)}\n`;
    content += `import { SandboxManager } from "../core/sandbox-manager.js";\n`;
    content += this.generateOutputContracts(outputs);
    content += `\n`;

    content += this.generateBundleLoader(integrity);
    content += `// Load the isolated bundle from the active runtime.\n`;
    content += `const libraryCode = await __loadSandboxBundle(${toJsStringLiteral(`${libraryName}.bundle.js`)}, ${toJsStringLiteral(integrity?.library ?? "")});\n\n`;

    content += `// Initialize the per-library QuickJS context before exposing exports.\n`;
    content += `const librarySandbox = await SandboxManager.createSandbox(\n`;
    content += `  ${toJsStringLiteral(libraryName)},\n`;
    content += `  libraryCode,\n`;
    const writableOption = Object.keys(writable).length ? `, writable: ${JSON.stringify(writable)}` : "";
    const limitsOption = limits && Object.keys(limits).length ? `, limits: ${JSON.stringify(limits)}` : "";
    content += `  { permissions: ${JSON.stringify(permissions)}${writableOption}${limitsOption} }\n`;
    content += `);\n\n`;
    content += `// Initialization needs a referenced job pump; steady-state Node.js usage does not.\n`;
    content += `if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `  librarySandbox.unrefPump();\n`;
    content += `}\n\n`;
    content += `const proxyExports = librarySandbox.exports;\n`;
    content += `/** Creates an instance of a root export inside QuickJS. */\n`;
    content += `const __createInstance = (ctorKey, args) => librarySandbox.createInstance(ctorKey, args);\n`;
    content += `let _callFn;\n`;
    content += `/** Calls the root export when the package exports one callable value. */\n`;
    content += `const __callSingleton = (args) => {\n`;
    content += `  _callFn ??= librarySandbox.arena.evalCode(\`(...args) => __SANDBOXED_LIB__(...args)\`);\n`;
    content += `  return librarySandbox.wrapResult(_callFn(...args));\n`;
    content += `};\n\n`;
    if (hasSubpaths) {
      content += `/** Host view of a declared subpath, served by this library's sandbox. */\n`;
      content += `export function __getSandboxSubpath(subpath) {\n`;
      content += `  return librarySandbox.loadSubpath(subpath);\n`;
      content += `}\n\n`;
    }
    content += this.generateWorkloadAccessHelpers(libraryName, workloads, integrity);
    content += this.generateExports(libraryData, Object.keys(outputs).length > 0);
    content += `/** Disposes the QuickJS context and its boundary resources. */\n`;
    content += `export function disposeLibrary() {\n`;
    content += `  if (librarySandbox) {\n`;
    content += `    librarySandbox.dispose();\n`;
    content += `  }\n`;
    content += `}\n`;
    return content;
  }

  /**
   * Generates the proxy module of a declared subpath (`<library>/<subpath>`).
   * It creates no sandbox: it reads the subpath from the owning library's
   * sandbox, so both share one QuickJS context and one module registry.
   *
   * @param libraryData Export information parsed from the subpath's declarations.
   * @param libraryName Owning package.
   * @param subpath Declared subpath.
   * @param rootProxyRequest Relative request of the library's root proxy.
   * @returns JavaScript source for the subpath proxy module.
   */
  public generateSubpath(
    libraryData: LibraryData,
    libraryName: string,
    subpath: string,
    rootProxyRequest: string,
  ): string {
    let content = `// Auto-generated Sandbox Proxy for ${toJsStringLiteral(`${libraryName}/${subpath}`)}\n`;
    content += `import { __getSandboxSubpath } from ${toJsStringLiteral(rootProxyRequest)};\n\n`;
    content += `const __subpath = __getSandboxSubpath(${toJsStringLiteral(subpath)});\n`;
    content += `const proxyExports = __subpath.exports;\n`;
    content += `const __createInstance = (ctorKey, args) => __subpath.createInstance(ctorKey, args);\n`;
    content += `const __callSingleton = (args) => __subpath.callSingleton(args);\n\n`;
    if (!libraryData.callableSingletonExport && libraryData.exportedNames.length === 0) {
      // Without declarations only the module value itself can be offered.
      content += `export default (typeof proxyExports === "function"\n`;
      content += `  ? new Proxy(function _subpath_target() {}, {\n`;
      content += `      apply(_t, _thisArg, args) { return __callSingleton(args); },\n`;
      content += `      get(_t, key, receiver) {\n`;
      content += `        if (typeof key === "symbol" || key === "prototype") return Reflect.get(_t, key, receiver);\n`;
      content += `        return proxyExports[key];\n`;
      content += `      },\n`;
      content += `    })\n`;
      content += `  : proxyExports);\n`;
      return content;
    }
    content += this.generateExports(libraryData);
    return content;
  }

  /**
   * Generates the export bindings of a proxy. The surrounding module defines
   * `proxyExports`, `__createInstance(ctorKey, args)` and
   * `__callSingleton(args)`.
   *
   * @param libraryData Runtime export information parsed from declarations.
   * @returns JavaScript source for the export bindings.
   */
  private generateExports(libraryData: LibraryData, contracted = false): string {
    let content = "";
    // With output contracts, every export binding passes through the wrapper,
    // which leaves exports without a declared path unchanged.
    const W = (name: string, expr: string) => (contracted ? `__withOutputContracts(${toJsStringLiteral(name)}, ${expr}, __outputEnforcers)` : expr);
    // An `export =` declaration represents one callable value whose properties
    // must remain accessible through the same default export.
    if (libraryData.callableSingletonExport) {
      content += `// Preserve both calls and property access on the callable singleton export.\n`;
      content += `function _callable_target() {}\n`;
      content += contracted ? `const _callable_default = new Proxy(_callable_target, {\n` : `export default new Proxy(_callable_target, {\n`;
      content += `  apply(_t, _thisArg, args) {\n`;
      content += `    return __callSingleton(args);\n`;
      content += `  },\n`;
      content += `  get(_t, key, receiver) {\n`;
      content += `    if (typeof key === "symbol") return Reflect.get(proxyExports, key, receiver);\n`;
      content += `    if (key === "prototype") return Reflect.get(_t, key, receiver);\n`;
      content += `    return proxyExports[key];\n`;
      content += `  },\n`;
      content += `  construct(_t, args) {\n`;
      content += `    return __callSingleton(args);\n`;
      content += `  },\n`;
      content += `});\n`;
      if (contracted) content += `export default ${W("default", "_callable_default")};\n`;
      content += `\n`;
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
        content += contracted ? `const _default_view = _defaultProxyTarget\n` : `export default _defaultProxyTarget\n`;
        content += `  ? new Proxy(_default_target, {\n`;
        content += `      apply(_target, _thisArg, args) {\n`;
        content += `        return _defaultProxyTarget(...args);\n`;
        content += `      },\n`;
        content += `      construct(_target, args) {\n`;
        content += `        const ctorKey = typeof proxyExports.default === "function" ? "default" : ${fallbackCtorKey};\n`;
        content += `        return __createInstance(ctorKey, args);\n`;
        content += `      },\n`;
        content += `      get(_target, key, receiver) {\n`;
        content += `        if (typeof key === "symbol") return Reflect.get(_target, key, receiver);\n`;
        content += `        if (key === "prototype") return Reflect.get(_target, key, receiver);\n`;
        content += `        const val = _defaultProxyTarget?.[key];\n`;
        content += `        if (val !== undefined) return val;\n`;
        content += `        return _defaultSingleton?.[key];\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : proxyExports.default;\n`;
        if (contracted) content += `export default ${W("default", "_default_view")};\n`;
        content += `\n`;
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
        content += `        return __createInstance(${nameLiteral}, args);\n`;
        content += `      },\n`;
        content += `      get(_target, key, receiver) {\n`;
        content += `        if (typeof key === "symbol") return Reflect.get(${exportAccess}, key, receiver);\n`;
        content += `        if (key === "prototype") return Reflect.get(_target, key, receiver);\n`;
        content += `        return ${exportAccess}[key];\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : ${exportAccess};\n`;
        if (contracted) content += `const ${safeIdentifier}_out = ${W(name, safeIdentifier)};\n`;
        // Aliases also support reserved words; other names use the ES2022 string form.
        content += `export { ${contracted ? `${safeIdentifier}_out` : safeIdentifier} as ${toModuleExportName(name)} };\n\n`;
      }
    });

    return content;
  }


  /**
   * Generates the imports and enforcers of a library's output contracts.
   * Sanitizer and check modules are host modules the developer named; they
   * are imported as ordinary (non-sandboxed) dependencies of the proxy.
   */
  private generateOutputContracts(outputs: Record<string, OutputContract>): string {
    const paths = Object.keys(outputs);
    if (paths.length === 0) return "";
    let content = `import { compileContract as __compileContract, withOutputContracts as __withOutputContracts } from "../core/output-contracts.js";\n`;
    const modules = new Map<string, string>();
    const binding = (request: string) => {
      if (!modules.has(request)) {
        const id = `__contractModule${modules.size}`;
        modules.set(request, id);
        content += `import * as ${id} from ${toJsStringLiteral(request)};\n`;
      }
      return modules.get(request)!;
    };
    const entries = paths.map((p) => {
      const c = outputs[p];
      const mods = [
        c.sanitizer ? `sanitizer: ${binding(c.sanitizer)}` : "",
        c.check ? `check: ${binding(c.check)}` : "",
      ].filter(Boolean).join(", ");
      const { sanitizer, check, ...plain } = c;
      return `  ${toJsStringLiteral(p)}: __compileContract(${toJsStringLiteral(p)}, ${JSON.stringify(plain)}, { ${mods} }),\n`;
    });
    content += `/** Output contracts declared in the sandbox policy, keyed by export path. */\n`;
    content += `const __outputEnforcers = {\n${entries.join("")}};\n`;
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
    integrity?: BundleIntegrity,
  ): string {
    if (workloads.length === 0) {
      return "";
    }

    let content = `const workloadManifest = {\n`;
    for (const workload of workloads) {
      content += `  ${toJsStringLiteral(workload.workloadName)}: {\n`;
      content += `    globalName: "__SANDBOXED_WORKLOAD_${this.toSafeGlobalName(workload.workloadName)}__",\n`;
      content += `    integrity: ${toJsStringLiteral(integrity?.workloads?.[workload.workloadName] ?? "")}\n`;
      content += `  },\n`;
    }
    content += `};\n\n`;

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
    content += `      code: await __loadSandboxBundle(${toJsStringLiteral(`${libraryName}.`)} + workloadName + ".workload.bundle.js", manifest.integrity)\n`;
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
   * Generates the bundle loader. When an expected digest is given, the raw
   * bytes are hashed before decoding and a mismatch fails closed: no code is
   * evaluated in QuickJS unless it is exactly the bundle the sandbox stage
   * produced.
   *
   * @param integrity Expected digests; when absent, bundles are not verified.
   * @returns JavaScript source defining `__loadSandboxBundle`.
   */
  private generateBundleLoader(integrity?: BundleIntegrity): string {
    let content = `/** Loads a sandbox bundle and verifies its digest when one is pinned. */\n`;
    content += `async function __loadSandboxBundle(bundleName, expected) {\n`;
    content += `  let bytes;\n`;
    content += `  if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `    const { readFileSync } = await import('fs');\n`;
    content += `    const { resolve, dirname } = await import('path');\n`;
    content += `    const { fileURLToPath } = await import('url');\n`;
    content += `    const __proxyDir = dirname(fileURLToPath(import.meta.url));\n`;
    content += `    const __projectRoot = resolve(__proxyDir, '..', '..');\n`;
    content += `    bytes = new Uint8Array(readFileSync(resolve(__projectRoot, 'dist', bundleName)));\n`;
    content += `  } else {\n`;
    content += `    bytes = new Uint8Array(await fetch(\`/dist/\${bundleName}\`).then(r => r.arrayBuffer()));\n`;
    content += `  }\n`;
    content += `  if (expected) {\n`;
    content += `    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-384', bytes));\n`;
    content += `    let binary = '';\n`;
    content += `    for (const byte of digest) binary += String.fromCharCode(byte);\n`;
    content += `    const actual = 'sha384-' + btoa(binary);\n`;
    content += `    if (actual !== expected) {\n`;
    content += `      throw new Error(\`Sandbox bundle integrity check failed for \${bundleName}: expected \${expected}, got \${actual}\`);\n`;
    content += `    }\n`;
    content += `  }\n`;
    content += `  return new TextDecoder().decode(bytes);\n`;
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
