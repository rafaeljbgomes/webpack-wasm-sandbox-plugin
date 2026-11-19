import * as fs from "fs";
import * as path from "path";
import { Compilation, Compiler, Module, NormalModule, WebpackError } from "webpack";

/**
 * Classify-or-fail: every npm package whose code ends up in the host bundle
 * must be either sandboxed (and therefore absent from the host bundle) or
 * explicitly trusted to run with the application's ambient authority.
 *
 * Sandboxing is thereby mandatory by construction: a new transitive
 * dependency, a typosquatted or substituted package, or a deep import that
 * bypasses the sandbox redirect fails the build instead of silently running
 * natively.
 */

/** Packages that implement the sandbox itself (trusted computing base). */
export const SANDBOX_RUNTIME_PACKAGES: readonly string[] = [
  "quickjs-emscripten",
  "quickjs-emscripten-core",
  "quickjs-emscripten-sync",
  "@jitl/quickjs-ffi-types",
  "@jitl/quickjs-wasmfile-release-sync",
  "@jitl/quickjs-wasmfile-release-asyncify",
  "@jitl/quickjs-wasmfile-debug-sync",
  "@jitl/quickjs-wasmfile-debug-asyncify",
];

export type ClassificationMode = "error" | "warn" | "off";

/** Options accepted under `classification` in the plugin options. */
export interface ClassificationOptions {
  /** `error` fails the build, `warn` reports only, `off` disables. Default `error`. */
  mode?: ClassificationMode;
  /**
   * Module exporting `{ trusted: string[] }`, resolved from the compiler
   * context. Keep it next to the sandbox policy, under code-owner review.
   */
  trustedPath?: string;
  /** Inline trusted list, merged with `trustedPath` (mainly for tests). */
  trusted?: string[];
  /** Asset name of the emitted JSON report. Default `sandbox-classification.json`. */
  reportAsset?: string;
}

export interface PackageUse {
  name: string;
  versions: string[];
  /** Up to five module requests that pulled the package in, for diagnostics. */
  importedBy: string[];
  moduleCount: number;
}

export interface ClassificationReport {
  mode: ClassificationMode;
  sandboxed: string[];
  trusted: PackageUse[];
  runtime: PackageUse[];
  unclassified: PackageUse[];
  /** Sandboxed packages whose code nevertheless reached the host bundle. */
  sandboxedButNative: PackageUse[];
  passed: boolean;
}

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

/**
 * Derives the package name from the module's install path. The path, not the
 * package's self-declared `name`, is authoritative: a malicious package can
 * claim any name in its own package.json, but its install location is the
 * name under which the application depends on it.
 *
 * @returns The package name, or `undefined` for first-party modules.
 */
export function packageNameFromPath(resource: string): string | undefined {
  const index = resource.lastIndexOf(NODE_MODULES);
  if (index === -1) return undefined;
  const segments = resource.slice(index + NODE_MODULES.length).split(path.sep);
  if (!segments[0]) return undefined;
  if (segments[0].startsWith("@")) {
    return segments[1] ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0];
}

/** Reads a package's version from the package root derived from the path. */
function packageVersion(resource: string, name: string): string {
  const index = resource.lastIndexOf(NODE_MODULES);
  const root = path.join(resource.slice(0, index + NODE_MODULES.length), ...name.split("/"));
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Loads and validates the trusted-package list. */
export function loadTrustedList(options: ClassificationOptions, context: string): Set<string> {
  const trusted = new Set<string>(options.trusted ?? []);
  if (options.trustedPath) {
    const absolutePath = path.resolve(context, options.trustedPath);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`[SandboxPlugin] Trusted-package list was not found at ${absolutePath}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(absolutePath);
    const list = (loaded.default ?? loaded).trusted;
    if (!Array.isArray(list) || list.some((item: unknown) => typeof item !== "string" || !item)) {
      throw new Error(`[SandboxPlugin] ${absolutePath} must export { trusted: string[] }`);
    }
    list.forEach((name: string) => trusted.add(name));
  }
  return trusted;
}

/** Returns the absolute resource path of a module, if it has one. */
function resourceOf(module: Module): string | undefined {
  const resource = (module as NormalModule).resource;
  if (typeof resource === "string" && resource) return resource.split("?")[0];
  const named = module.nameForCondition?.();
  return named ?? undefined;
}

/** Builds the report for the modules of one (host) compilation. */
export function classifyModules(
  compilation: Compilation,
  sandboxed: Set<string>,
  trusted: Set<string>,
  mode: ClassificationMode,
): ClassificationReport {
  const uses = new Map<string, { versions: Set<string>; importedBy: Set<string>; moduleCount: number }>();

  for (const module of compilation.modules) {
    // Only modules that ship in a chunk can run; modules pruned by
    // side-effect-free optimization are in the graph but never emitted.
    if (compilation.chunkGraph && compilation.chunkGraph.getNumberOfModuleChunks(module) === 0) continue;
    const resource = resourceOf(module);
    if (!resource) continue;
    const name = packageNameFromPath(resource);
    if (!name) continue;
    let use = uses.get(name);
    if (!use) {
      use = { versions: new Set(), importedBy: new Set(), moduleCount: 0 };
      uses.set(name, use);
    }
    use.moduleCount += 1;
    use.versions.add(packageVersion(resource, name));
    if (use.importedBy.size < 5) {
      for (const connection of compilation.moduleGraph.getIncomingConnections(module)) {
        const origin = connection.originModule;
        const dependency = connection.dependency as { request?: string } | null;
        if (!origin || !dependency?.request) continue;
        const originResource = resourceOf(origin);
        // Report only how the package is entered, not its internal requires.
        if (originResource && packageNameFromPath(originResource) === name) continue;
        const where = originResource ? path.relative(compilation.compiler.context, originResource) : "?";
        use.importedBy.add(`${dependency.request} (from ${where})`);
        if (use.importedBy.size >= 5) break;
      }
    }
  }

  const report: ClassificationReport = {
    mode,
    sandboxed: [...sandboxed].sort(),
    trusted: [],
    runtime: [],
    unclassified: [],
    sandboxedButNative: [],
    passed: true,
  };
  const runtime = new Set(SANDBOX_RUNTIME_PACKAGES);

  for (const [name, use] of [...uses].sort(([a], [b]) => a.localeCompare(b))) {
    const entry: PackageUse = {
      name,
      versions: [...use.versions].sort(),
      importedBy: [...use.importedBy],
      moduleCount: use.moduleCount,
    };
    // A sandboxed package in the host bundle is always a violation, even if it
    // is also listed as trusted: the policy says it must not run natively.
    if (sandboxed.has(name)) report.sandboxedButNative.push(entry);
    else if (runtime.has(name)) report.runtime.push(entry);
    else if (trusted.has(name)) report.trusted.push(entry);
    else report.unclassified.push(entry);
  }
  report.passed = report.unclassified.length === 0 && report.sandboxedButNative.length === 0;
  return report;
}

/** Formats violations as build diagnostics. */
export function describeViolations(report: ClassificationReport): string[] {
  const messages: string[] = [];
  for (const use of report.sandboxedButNative) {
    messages.push(
      `[SandboxPlugin] Sandboxed package "${use.name}" reached the host bundle natively ` +
        `(${use.moduleCount} module(s)) via: ${use.importedBy.join("; ") || "unknown request"}. ` +
        `Import it through its root specifier or sandbox the subpath.`,
    );
  }
  for (const use of report.unclassified) {
    messages.push(
      `[SandboxPlugin] Package "${use.name}"@${use.versions.join(",")} is neither sandboxed nor trusted ` +
        `but is bundled into the host via: ${use.importedBy.join("; ") || "unknown request"}. ` +
        `Add it to the sandbox policy or to the trusted list.`,
    );
  }
  return messages;
}

/**
 * Registers classify-or-fail on the host compilation only. Child compilations
 * (the sandboxed bundles) are deliberately not checked: their contents run
 * inside the owning library's sandbox with its grant.
 */
export function applyClassification(
  compiler: Compiler,
  sandboxed: Set<string>,
  options: ClassificationOptions = {},
) {
  const mode = options.mode ?? "error";
  if (mode === "off") return;
  const trusted = loadTrustedList(options, compiler.context);
  const reportAsset = options.reportAsset ?? "sandbox-classification.json";

  compiler.hooks.thisCompilation.tap("WebpackSandboxPlugin/classify", (compilation) => {
    let report: ClassificationReport | undefined;

    // Runs after chunk optimization so that only shipped modules are classified.
    compilation.hooks.afterOptimizeChunkModules.tap("WebpackSandboxPlugin/classify", () => {
      report = classifyModules(compilation, sandboxed, trusted, mode);
      for (const message of describeViolations(report)) {
        const diagnostic = new WebpackError(message);
        if (mode === "error") compilation.errors.push(diagnostic);
        else compilation.warnings.push(diagnostic);
      }
    });

    compilation.hooks.processAssets.tap(
      { name: "WebpackSandboxPlugin/classify", stage: Compilation.PROCESS_ASSETS_STAGE_REPORT },
      () => {
        if (!report) return;
        compilation.emitAsset(
          reportAsset,
          new compiler.webpack.sources.RawSource(JSON.stringify(report, null, 2) + "\n"),
        );
      },
    );
  });
}
