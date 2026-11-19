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
  /**
   * Package subpaths the application imports (`"locale"` for
   * `date-fns/locale`). Each is redirected to a proxy backed by the same
   * QuickJS context and the same bundle as the package root.
   */
  subpaths?: string[];
  /**
   * Host properties the library may assign, keyed by granted global and given
   * as dotted paths from it (`{ config: ["theme", "ui.color"] }`). Grants are
   * read-only otherwise: every other assignment to a granted host object fails.
   */
  writable?: Record<string, string[]>;
  workloads?: Record<string, WorkloadConfig>;
  [key: string]: unknown;
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Validates and normalizes `subpaths`: relative, inside the package, unique. */
export function normalizeSubpaths(name: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new Error(`[SandboxPlugin] Subpaths for ${name} must be an array of nonempty strings`);
  }
  const normalized = value.map((subpath) => subpath.replace(/^\.\//, ""));
  for (const subpath of normalized) {
    if (subpath === "" || subpath.startsWith("/") || subpath.split("/").some((part) => part === ".." || part === "." || part === "")) {
      throw new Error(`[SandboxPlugin] Subpath "${subpath}" for ${name} must be a relative path inside the package`);
    }
  }
  const safe = normalized.map((subpath) => subpath.replace(/[^A-Za-z0-9_.-]/g, "_"));
  if (new Set(safe).size !== safe.length) {
    throw new Error(`[SandboxPlugin] Subpaths for ${name} contain duplicates: ${normalized.join(", ")}`);
  }
  return normalized;
}

/** Validates `writable`: every key must be granted, every path nonempty. */
export function normalizeWritable(name: string, value: unknown, permissions: string[]): Record<string, string[]> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[SandboxPlugin] Writable paths for ${name} must be an object keyed by granted global`);
  }
  const normalized: Record<string, string[]> = {};
  for (const [api, paths] of Object.entries(value)) {
    if (!permissions.includes(api)) {
      throw new Error(`[SandboxPlugin] Writable paths for ${name} name "${api}", which is not in its permissions`);
    }
    if (!Array.isArray(paths) || !paths.every((p) => isNonEmptyString(p) && p.split(".").every(isNonEmptyString))) {
      throw new Error(`[SandboxPlugin] Writable paths for ${name}.${api} must be dotted property paths`);
    }
    normalized[api] = [...paths];
  }
  return normalized;
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
    const subpaths = normalizeSubpaths(name, (value as LibraryPolicy).subpaths);
    const writable = normalizeWritable(name, (value as LibraryPolicy).writable, permissions);
    // The new fields appear only when declared, so existing policies normalize unchanged.
    normalized[name] = {
      ...value,
      permissions: [...permissions],
      ...(subpaths.length ? { subpaths } : {}),
      ...(Object.keys(writable).length ? { writable } : {}),
    };
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

/** Global through which a bundle with subpaths publishes them, keyed by subpath. */
export const SUBPATHS_GLOBAL = "__SANDBOXED_SUBPATHS__";

/**
 * Resolves a module request with the compilation's own resolver, under the
 * conditions of a CommonJS `require` (the form the generated entry uses).
 */
function resolveForBundle(compilation: Compilation, context: string, request: string): Promise<string> {
  const resolver = compilation.resolverFactory.get("normal", { dependencyType: "commonjs" } as any);
  return new Promise((resolve, reject) => {
    resolver.resolve({}, context, request, {}, (error: Error | null, result?: string | false) => {
      if (error || !result) {
        reject(Object.assign(new Error(`[SandboxPlugin] Could not resolve sandbox subpath ${request}`), { cause: error }));
      } else {
        resolve(result);
      }
    });
  });
}

/**
 * Writes the entry module of a library bundle that also carries subpaths.
 *
 * One bundle, one webpack module registry and one QuickJS context serve the
 * root and every subpath, so modules they share are instantiated once and
 * objects passed between them never leave the sandbox. The root stays the
 * bundle's `__SANDBOXED_LIB__`; subpaths are published on a second global.
 */
async function writeSubpathEntry(
  compilation: Compilation,
  context: string,
  libraryName: string,
  subpaths: string[],
  entryDir: string,
): Promise<string> {
  const root = resolveLibraryEntry(libraryName, context);
  const lines = [`// Generated sandbox entry for ${JSON.stringify(libraryName)} and its subpaths.`];
  lines.push(`const subpaths = Object.create(null);`);
  for (const subpath of subpaths) {
    const resolved = await resolveForBundle(compilation, context, `${libraryName}/${subpath}`);
    lines.push(`subpaths[${JSON.stringify(subpath)}] = require(${JSON.stringify(resolved)});`);
  }
  lines.push(`globalThis.${SUBPATHS_GLOBAL} = subpaths;`);
  lines.push(`module.exports = require(${JSON.stringify(root)});`);
  fs.mkdirSync(entryDir, { recursive: true });
  const entry = path.join(entryDir, `${libraryName.replace(/[^A-Za-z0-9_.-]/g, "_")}.sandbox-entry.cjs`);
  fs.writeFileSync(entry, lines.join("\n") + "\n");
  return entry;
}

/** Builds an isolated library with the parent's resolver, loaders and target. */
export async function compileLibrary(
  compiler: Compiler,
  compilation: Compilation,
  libraryName: string,
  subpaths: string[] = [],
  entryDir?: string,
): Promise<Compilation> {
  const entry = subpaths.length
    ? await writeSubpathEntry(compilation, compiler.context, libraryName, subpaths, entryDir ?? path.resolve(compiler.context, ".sandbox"))
    : resolveLibraryEntry(libraryName, compiler.context);
  return new Promise((resolve, reject) => {
    const { EnableLibraryPlugin } = compiler.webpack.library;
    const child = compilation.createChildCompiler(`SandboxCompiler-${libraryName}`, {
      filename: `${libraryName}.bundle.js`,
      path: path.resolve(compiler.options.output.path || "dist"),
      library: { type: "var", name: "__SANDBOXED_LIB__" },
    }, [new EnableLibraryPlugin("var")]);
    new compiler.webpack.EntryPlugin(compiler.context, entry, {
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
