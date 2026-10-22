import * as fs from "fs";
import * as path from "path";
import { Compilation, Compiler } from "webpack";

/** Workload bundled in its owning library context. */
export interface WorkloadConfig {
  entry: string;
  exports: string[];
}

/** Normalized developer policy; missing permissions always mean no authority. */
export interface LibraryPolicy {
  permissions: string[];
  workloads?: Record<string, WorkloadConfig>;
  [key: string]: unknown;
}

/** Loads the compiler-selected policy without modifying the developer's module. */
export function loadSandboxPolicy(configPath: string, context: string): Record<string, LibraryPolicy> {
  const absolutePath = path.resolve(context, configPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`[SandboxPlugin] Sandbox policy file was not found at ${absolutePath}`);
  }
  let policy: unknown;
  try {
    const loaded = require(absolutePath);
    policy = loaded.default ?? loaded;
  } catch (error) {
    throw Object.assign(new Error(`[SandboxPlugin] Failed to load sandbox policy at ${absolutePath}`), { cause: error });
  }
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error(`[SandboxPlugin] Sandbox policy at ${absolutePath} must export an object keyed by library name`);
  }
  const normalized = Object.create(null) as Record<string, LibraryPolicy>;
  for (const [name, value] of Object.entries(policy)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`[SandboxPlugin] Policy for ${name} must be an object`);
    }
    const permissions = (value as LibraryPolicy).permissions ?? [];
    if (!Array.isArray(permissions) || permissions.some((item) => typeof item !== "string" || !item)) {
      throw new Error(`[SandboxPlugin] Permissions for ${name} must be an array of nonempty strings`);
    }
    // Null is malformed; only omission gets the deny-by-default normalization.
    if ((value as LibraryPolicy).permissions === null) {
      throw new Error(`[SandboxPlugin] Permissions for ${name} must be an array of nonempty strings`);
    }
    resolveLibraryEntry(name, context);
    normalized[name] = { ...value, permissions: [...permissions] };
  }
  return normalized;
}

/** Preserves the runtime build's Node entry resolution, including its limitations. */
export function resolveLibraryEntry(libraryName: string, context: string): string {
  try {
    return require.resolve(libraryName, { paths: [context] });
  } catch (error) {
    throw Object.assign(new Error(`[SandboxPlugin] Configured sandbox library could not be resolved: ${libraryName}`), { cause: error });
  }
}

/** Builds an isolated library with the parent's resolver, loaders and target. */
export function compileLibrary(compiler: Compiler, compilation: Compilation, libraryName: string): Promise<Compilation> {
  return new Promise((resolve, reject) => {
    const { EnableLibraryPlugin } = compiler.webpack.library;
    const child = compilation.createChildCompiler(`SandboxCompiler-${libraryName}`, {
      filename: `${libraryName}.bundle.js`,
      path: path.resolve(compiler.options.output.path || "dist"),
      library: { type: "var", name: "__SANDBOXED_LIB__" },
    }, [new EnableLibraryPlugin("var")]);
    new compiler.webpack.EntryPlugin(compiler.context, resolveLibraryEntry(libraryName, compiler.context), {
      name: libraryName,
    }).apply(child);
    child.runAsChild((error, _entries, childCompilation) => {
      if (error || childCompilation?.errors.length || !childCompilation) {
        reject(error ?? childCompilation?.errors[0] ?? new Error(`No compilation for ${libraryName}`));
      } else {
        resolve(childCompilation);
      }
    });
  });
}
