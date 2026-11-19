import * as fs from "fs";
import * as path from "path";
import { Compiler, NormalModuleReplacementPlugin } from "webpack";
import { ProxyGenerator } from "./proxy-generator";
import { Parser } from "./core/parser";
import { findAllDtsFiles } from "./utils/file-utils";
import { toJsStringLiteral } from "./utils/source-literals";
import { compileLibrary, loadSandboxPolicy, WorkloadConfig } from "./build-helpers";
import { applyClassification, ClassificationOptions } from "./classification";
import { integrityFor, loadAndCheckManifest, ManifestOptions, SandboxManifest } from "./manifest";
import type { BundleIntegrity } from "./proxy-generator";

/** Configuration accepted by {@link WebpackSandboxPlugin}. */
export interface SandboxPluginOptions {
  /** Path to the sandbox policy, resolved from the Webpack compiler context. */
  configPath: string;
  /**
   * Directory for generated proxy modules. Defaults to `.sandbox/proxys`
   * under the process working directory; tests pass a temporary directory.
   */
  proxyDirectory?: string;
  /**
   * Classify-or-fail enforcement for the host bundle. Defaults to
   * `{ mode: "error" }`: every npm package in the host bundle must be
   * explicitly trusted, and no sandboxed package may appear there.
   */
  classification?: ClassificationOptions;
  /**
   * Manifest produced by the separate sandbox stage. When set, the plugin
   * does not compile library code: it checks the policy and grants against
   * the manifest, emits the stage's bundles after verifying their digests,
   * and pins those digests in the generated proxies.
   */
  sandboxManifest?: ManifestOptions;
}

/** Workload definition enriched with its owning library and policy key. */
interface ConfiguredWorkload extends WorkloadConfig {
  libraryName: string;
  workloadName: string;
}

/**
 * Escapes a literal module request for use in a regular expression.
 *
 * @param value Module request to escape.
 * @returns The escaped expression fragment.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Bundles configured dependencies for QuickJS and redirects host imports to
 * generated proxy modules.
 */
export class WebpackSandboxPlugin {
  private options: SandboxPluginOptions;
  private sandboxCacheDir: string;

  /**
   * Creates a plugin instance and selects the generated-proxy directory.
   *
   * @param options Sandbox policy location and optional proxy directory.
   */
  constructor(options: SandboxPluginOptions) {
    this.options = options;
    this.sandboxCacheDir = path.resolve(
      process.cwd(),
      options.proxyDirectory ?? ".sandbox/proxys",
    );
  }

  /**
   * Registers proxy generation, import replacement, and isolated child
   * compilations with a Webpack compiler.
   *
   * @param compiler Compiler receiving the sandbox integration.
   */
  apply(compiler: Compiler) {
    if (!fs.existsSync(this.sandboxCacheDir)) {
      fs.mkdirSync(this.sandboxCacheDir, { recursive: true });
    }

    const configPath = path.resolve(compiler.context, this.options.configPath);
    let configuredLibraries: string[] = [];
    let configuredWorkloads: ConfiguredWorkload[] = [];

    const sandboxConfig = loadSandboxPolicy(configPath, compiler.context);
    configuredLibraries = Object.keys(sandboxConfig);

    configuredWorkloads = configuredLibraries.flatMap((libraryName) => {
      const workloads = sandboxConfig[libraryName]?.workloads ?? {};
      return Object.entries(workloads).map(
        ([workloadName, workloadConfig]) => ({
          libraryName,
          workloadName,
          ...workloadConfig,
        }),
      );
    });
    let manifest: SandboxManifest | undefined;
    if (this.options.sandboxManifest) {
      const loaded = loadAndCheckManifest(this.options.sandboxManifest, compiler.context, configPath, sandboxConfig);
      manifest = loaded.manifest;
      compiler.hooks.thisCompilation.tap("WebpackSandboxPlugin/manifest", (compilation) => {
        compilation.hooks.processAssets.tap(
          { name: "WebpackSandboxPlugin/manifest", stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
          () => {
            for (const [file, bytes] of loaded.bundles) {
              compilation.emitAsset(file, new compiler.webpack.sources.RawSource(bytes));
            }
          },
        );
      });
    }

    applyClassification(
      compiler,
      new Set(configuredLibraries),
      this.options.classification,
    );

    console.log(
      `[SandboxPlugin] Loaded configuration for ${configuredLibraries.length} libraries: ${configuredLibraries.join(", ")}`,
    );

    // Use `compile` instead of `beforeCompile` because webpack copies
    // `beforeCompile` taps into child compilers created by `runAsChild()`.
    // That caused proxy generation to run once for the root compiler and
    // again for each child compiler.
    compiler.hooks.compile.tap("WebpackSandboxPlugin", () => {
      configuredLibraries.forEach((libName) => {
        this.generateProxyForLibrary(
          libName,
          compiler.context,
          sandboxConfig[libName].permissions,
          configuredWorkloads.filter(
            (workload) => workload.libraryName === libName,
          ),
          integrityFor(manifest?.libraries[libName]),
        );
      });
      configuredWorkloads.forEach((workload) => {
        this.generateProxyForWorkload(workload, compiler.context);
      });
    });

    configuredLibraries.forEach((libName) => {
      const proxyPath = path.resolve(
        this.sandboxCacheDir,
        `${libName}-proxy.js`,
      );

      new NormalModuleReplacementPlugin(
        new RegExp(`^${libName}$`),
        (resource: any) => {
          console.log(
            `[SandboxPlugin] Intercepted import for ${libName}, redirecting to proxy.`,
          );
          resource.request = proxyPath;
        },
      ).apply(compiler);
    });

    configuredWorkloads.forEach((workload) => {
      const proxyPath = path.resolve(
        this.sandboxCacheDir,
        `${workload.libraryName}-${workload.workloadName}-workload-proxy.js`,
      );
      const requestPattern = `sandbox-workload/${workload.libraryName}/${workload.workloadName}`;

      new NormalModuleReplacementPlugin(
        new RegExp(`^${escapeRegExp(requestPattern)}$`),
        (resource: any) => {
          console.log(
            `[SandboxPlugin] Intercepted workload ${requestPattern}, redirecting to proxy.`,
          );
          resource.request = proxyPath;
        },
      ).apply(compiler);
    });

    // Child compilers keep dependency code out of the host bundle while still
    // participating in the parent compilation lifecycle.
    compiler.hooks.make.tapAsync(
      "WebpackSandboxPlugin",
      (compilation, callback) => {
        // With a manifest, library code is never compiled in this build.
        if (manifest) return callback();
        const libraryBundlePromises = configuredLibraries.map((libName) =>
          compileLibrary(compiler, compilation, libName),
        );
        const workloadBundlePromises = configuredWorkloads.map((workload) => {
          return new Promise<void>((resolve, reject) => {
            const bundleName = `${workload.libraryName}.${workload.workloadName}.workload.bundle.js`;
            const workloadGlobalName = `__SANDBOXED_WORKLOAD_${workload.workloadName.replace(/[^a-zA-Z0-9_$]/g, "_")}__`;
            const outputOptions = {
              filename: bundleName,
              path: path.resolve(compiler.options.output.path || "dist"),
              library: {
                type: "var" as const,
                name: workloadGlobalName,
              },
            };

            const { EnableLibraryPlugin } = compiler.webpack.library;
            const childCompiler = compilation.createChildCompiler(
              `SandboxWorkloadCompiler-${workload.libraryName}-${workload.workloadName}`,
              outputOptions,
              [new EnableLibraryPlugin("var")],
            );

            const workloadEntryPath = path.resolve(
              compiler.context,
              workload.entry,
            );
            if (!fs.existsSync(workloadEntryPath)) {
              console.warn(
                `[SandboxPlugin] Warning: Could not resolve workload entry ${workload.entry}. Skipping workload bundle.`,
              );
              return resolve();
            }

            const { ExternalsPlugin } = compiler.webpack;
            new ExternalsPlugin("var", {
              [`sandbox-real/${workload.libraryName}`]: "__SANDBOXED_LIB__",
            }).apply(childCompiler);

            const EntryPlugin = compiler.webpack.EntryPlugin;
            new EntryPlugin(compiler.context, workloadEntryPath, {
              name: `${workload.libraryName}-${workload.workloadName}-workload`,
            }).apply(childCompiler);

            childCompiler.runAsChild((err, entries, childCompilation) => {
              if (err) {
                console.error(
                  `[SandboxPlugin] Child compiler error for ${workload.libraryName}/${workload.workloadName}:`,
                  err,
                );
                reject(err);
              } else if (
                childCompilation &&
                childCompilation.errors &&
                childCompilation.errors.length > 0
              ) {
                console.error(
                  `[SandboxPlugin] Child compilation errors for ${workload.libraryName}/${workload.workloadName}:`,
                  childCompilation.errors,
                );
                reject(childCompilation.errors[0]);
              } else {
                console.log(
                  `[SandboxPlugin] Successfully built isolated workload bundle for ${workload.libraryName}/${workload.workloadName}`,
                );
                resolve();
              }
            });
          });
        });

        Promise.all([...libraryBundlePromises, ...workloadBundlePromises])
          .then(() => callback())
          .catch((err) => callback(err));
      },
    );
  }

  /**
   * Parses a dependency's declarations and writes its generated sandbox proxy.
   *
   * @param libraryName Package request configured for isolation.
   * @param context Webpack project context used for module resolution.
   * @param permissions Compiler-selected host capabilities.
   * @param workloads Workloads sharing the library's QuickJS context.
   */
  private generateProxyForLibrary(
    libraryName: string,
    context: string,
    permissions: string[],
    workloads: ConfiguredWorkload[] = [],
    integrity?: BundleIntegrity,
  ) {
    const proxyPath = path.resolve(
      this.sandboxCacheDir,
      `${libraryName}-proxy.js`,
    );

    const libPath = path.resolve(context, "node_modules", libraryName);
    let dtsFiles: string[] = [];

    if (fs.existsSync(libPath)) {
      dtsFiles = findAllDtsFiles(libPath);
    } else {
      console.warn(
        `[SandboxPlugin] Target library ${libraryName} not found in node_modules.`,
      );
    }

    if (dtsFiles.length === 0) {
      const atTypesPath = path.resolve(
        context,
        "node_modules",
        "@types",
        libraryName,
      );
      if (fs.existsSync(atTypesPath)) {
        console.log(
          `[SandboxPlugin] No .d.ts files found in ${libraryName} folder. Falling back to @types/${libraryName}.`,
        );
        dtsFiles = findAllDtsFiles(atTypesPath);
      }
    }

    if (dtsFiles.length === 0) {
      console.warn(
        `[SandboxPlugin] No .d.ts files found for ${libraryName}. Generating default minimal proxy.`,
      );
      fs.writeFileSync(
        proxyPath,
        `export default function() { throw new Error("Sandbox Proxy Generation Failed"); }`,
      );
      return;
    }

    const parser = new Parser(dtsFiles);
    const libraryData = parser.parse();

    const generator = new ProxyGenerator();
    const proxyContent = generator.generate(libraryData, libraryName, workloads, permissions, integrity);

    fs.writeFileSync(proxyPath, proxyContent);
    console.log(
      `[SandboxPlugin] Generated Sandbox Proxy for ${libraryName} at ${proxyPath}`,
    );
  }

  /**
   * Writes a proxy that exposes selected workload functions from an owning
   * library sandbox.
   *
   * @param workload Workload definition from the sandbox policy.
   * @param context Webpack project context used to resolve its entry module.
   */
  private generateProxyForWorkload(
    workload: ConfiguredWorkload,
    context: string,
  ) {
    const proxyPath = path.resolve(
      this.sandboxCacheDir,
      `${workload.libraryName}-${workload.workloadName}-workload-proxy.js`,
    );
    const exportLines = workload.exports.map((exportName) => {
      const safeName = exportName.replace(/[^a-zA-Z0-9_$]/g, "_");
      const safeIdentifier = `_workload_${safeName}`;
      return [
        `const ${safeIdentifier} = await __getSandboxWorkloadExport(${toJsStringLiteral(workload.workloadName)}, ${toJsStringLiteral(exportName)});`,
        `export function ${safeName}(...args) {`,
        `  return ${safeIdentifier}(...args);`,
        `}`,
        "",
      ].join("\n");
    });

    const proxyContent = [
      `// Auto-generated Sandbox Workload Proxy for ${toJsStringLiteral(`${workload.libraryName}/${workload.workloadName}`)}`,
      `import { __getSandboxWorkloadExport } from ${toJsStringLiteral(`./${workload.libraryName}-proxy.js`)};`,
      "",
      ...exportLines,
      `export function disposeWorkload() {`,
      `  // Workloads share the owning library sandbox; dispose the library proxy instead.`,
      `}`,
      "",
    ].join("\n");

    fs.writeFileSync(proxyPath, proxyContent);
    console.log(
      `[SandboxPlugin] Generated Sandbox Workload Proxy for ${workload.libraryName}/${workload.workloadName} at ${proxyPath}`,
    );
  }
}
