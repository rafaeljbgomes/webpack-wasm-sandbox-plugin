import { LibraryData } from "./domain/types.js";

export class ProxyGenerator {
  public generate(libraryData: LibraryData, libraryName: string): string {
    let content = `// Auto-generated Sandbox Proxy for ${libraryName}\n`;
    content += `import { SandboxManager } from "./sandbox-manager.js";\n\n`;

    // 1. Core Sandbox Initialization using Top-Level Await
    content += `// 1. Load library bundle (Node.js or browser)\n`;
    content += `let libraryCode;\n`;
    content += `if (typeof process !== 'undefined' && process.versions?.node) {\n`;
    content += `  const { readFileSync } = await import('fs');\n`;
    content += `  const { resolve, dirname } = await import('path');\n`;
    content += `  const { fileURLToPath } = await import('url');\n`;
    content += `  const __proxyDir = dirname(fileURLToPath(import.meta.url));\n`;
    content += `  libraryCode = readFileSync(resolve(__proxyDir, '..', 'dist', '${libraryName}.bundle.js'), 'utf-8');\n`;
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

    // Keep track of exported names to handle TS overloads or multiple files
    const exportedNames = new Set<string>();

    // 2. Export Everything (Functions, Classes, Namespaces, Variables)
    libraryData.exportedNames.forEach((name) => {
      if (exportedNames.has(name)) {
        return; // Skip duplicates
      }
      exportedNames.add(name);

      if (name === "default") {
        content += `// Default Export\n`;
        content += `let defaultConstructor;\n`;
        content += `export default typeof proxyExports.default === "function"\n`;
        content += `  ? new Proxy(proxyExports.default, {\n`;
        content += `      construct(target, args) {\n`;
        content += `        if (!defaultConstructor) {\n`;
        content += `          defaultConstructor = librarySandbox.arena.evalCode(\`(...args) => new __SANDBOXED_LIB__["default"](...args)\`);\n`;
        content += `        }\n`;
        content += `        return defaultConstructor(...args);\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : proxyExports.default;\n\n`;
      } else {
        content += `// Export: ${name}\n`;
        content += `let ${name}_Constructor;\n`;
        content += `export const ${name} = typeof proxyExports.${name} === "function"\n`;
        content += `  ? new Proxy(proxyExports.${name}, {\n`;
        content += `      construct(target, args) {\n`;
        content += `        if (!${name}_Constructor) {\n`;
        content += `          ${name}_Constructor = librarySandbox.arena.evalCode(\`(...args) => new __SANDBOXED_LIB__["${name}"](...args)\`);\n`;
        content += `        }\n`;
        content += `        return ${name}_Constructor(...args);\n`;
        content += `      }\n`;
        content += `    })\n`;
        content += `  : proxyExports.${name};\n\n`;
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
}
