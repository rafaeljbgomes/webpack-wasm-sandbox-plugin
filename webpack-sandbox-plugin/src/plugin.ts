import * as fs from "fs";
import * as path from "path";
import { Compiler, NormalModuleReplacementPlugin } from "webpack";
import { ProxyGenerator } from "./proxy-generator";
import { Parser } from "./core/parser";
import { findAllDtsFiles } from "./utils/file-utils";

export interface SandboxPluginOptions {
  configPath: string;
}

interface WorkloadConfig {
  entry: string;
  exports: string[];
}

interface ConfiguredWorkload extends WorkloadConfig {
  libraryName: string;
  workloadName: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class WebpackSandboxPlugin {
  private options: SandboxPluginOptions;
  private sandboxCacheDir: string;

  constructor(options: SandboxPluginOptions) {
    this.options = options;
    this.sandboxCacheDir = path.resolve(process.cwd(), ".sandbox/proxys");
  }

  apply(compiler: Compiler) {
    // 1. Ensure cache directory exists
    if (!fs.existsSync(this.sandboxCacheDir)) {
      fs.mkdirSync(this.sandboxCacheDir, { recursive: true });
    }

    // 2. Load the Sandbox Config to know which libraries to intercept
    const configPath = path.resolve(compiler.context, this.options.configPath);
    let configuredLibraries: string[] = [];
    let configuredWorkloads: ConfiguredWorkload[] = [];

    try {
      if (fs.existsSync(configPath)) {
        // Since we are running in a build environment, we can dynamically require the configuration
        // We use a dynamic import/require query. Assuming it's standard JS (like sandbox.config.js)
        let configModule = require(configPath);
        // Handle both CommonJS and ES Modules default exports
        const sandboxConfig = configModule.default || configModule;

        configuredLibraries = Object.keys(sandboxConfig);
        configuredWorkloads = configuredLibraries.flatMap((libraryName) => {
          const workloads = sandboxConfig[libraryName]?.workloads ?? {};
          return Object.entries(workloads).map(
            ([workloadName, workloadConfig]) => ({
              libraryName,
              workloadName,
              ...(workloadConfig as WorkloadConfig),
            }),
          );
        });
        console.log(
          `[SandboxPlugin] Loaded configuration for ${configuredLibraries.length} libraries: ${configuredLibraries.join(", ")}`,
        );
      } else {
        console.warn(
          `[SandboxPlugin] Warning: Config file not found at ${configPath}`,
        );
      }
    } catch (e) {
      console.error(
        `[SandboxPlugin] Error parsing Sandbox Config at ${configPath}:`,
        e,
      );
    }

    // 3. Generate proxies before the main compilation starts.
    // Use `compile` instead of `beforeCompile` because webpack copies
    // `beforeCompile` taps into child compilers created by `runAsChild()`.
    // That caused proxy generation to run once for the root compiler and
    // again for each child compiler.
    compiler.hooks.compile.tap("WebpackSandboxPlugin", () => {
      configuredLibraries.forEach((libName) => {
        this.generateProxyForLibrary(
          libName,
          compiler.context,
          configuredWorkloads.filter(
            (workload) => workload.libraryName === libName,
          ),
        );
      });
      configuredWorkloads.forEach((workload) => {
        this.generateProxyForWorkload(workload, compiler.context);
      });
    });

    // 4. Intercept imports and replace with proxy
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

    // 5. Setup Child Compiler to bundle the original library into an IIFE/UMD string
    compiler.hooks.make.tapAsync(
      "WebpackSandboxPlugin",
      (compilation, callback) => {
        const libraryBundlePromises = configuredLibraries.map((libName) => {
          return new Promise<void>((resolve, reject) => {
            const outputOptions = {
              filename: `${libName}.bundle.js`,
              path: path.resolve(compiler.options.output.path || "dist"),
              library: {
                type: "var" as const,
                //type: "global" as const,
                name: "__SANDBOXED_LIB__",
              },
              //globalObject: "globalThis",
            };

            const { EnableLibraryPlugin } = compiler.webpack.library;

            const childCompiler = compilation.createChildCompiler(
              `SandboxCompiler-${libName}`,
              outputOptions,
              [new EnableLibraryPlugin("var")],
            );

            // We need to resolve the actual path of the library from node_modules
            // For a simple spike, we resolve the package root.
            let libEntryPath;
            try {
              libEntryPath = require.resolve(libName, {
                paths: [compiler.context],
              });
            } catch (err) {
              console.warn(
                `[SandboxPlugin] Warning: Could not resolve entry for ${libName}. Skipping Child Compilation.`,
              );
              return resolve();
            }

            // Webpack API requires requiring its internal EntryPlugin
            const EntryPlugin = compiler.webpack.EntryPlugin;
            new EntryPlugin(compiler.context, libEntryPath, {
              name: libName,
            }).apply(childCompiler);

            childCompiler.runAsChild((err, entries, childCompilation) => {
              if (err) {
                console.error(
                  `[SandboxPlugin] Child compiler error for ${libName}:`,
                  err,
                );
                reject(err);
              } else if (
                childCompilation &&
                childCompilation.errors &&
                childCompilation.errors.length > 0
              ) {
                console.error(
                  `[SandboxPlugin] Child compilation errors for ${libName}:`,
                  childCompilation.errors,
                );
                reject(childCompilation.errors[0]);
              } else {
                console.log(
                  `[SandboxPlugin] Successfully built isolated bundle for ${libName}`,
                );
                resolve();
              }
            });
          });
        });
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

  private generateProxyForLibrary(
    libraryName: string,
    context: string,
    workloads: ConfiguredWorkload[] = [],
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
    const proxyContent = generator.generate(libraryData, libraryName, workloads);

    fs.writeFileSync(proxyPath, proxyContent);
    console.log(
      `[SandboxPlugin] Generated Sandbox Proxy for ${libraryName} at ${proxyPath}`,
    );
  }

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
        `const ${safeIdentifier} = await __getSandboxWorkloadExport("${workload.workloadName}", "${exportName}");`,
        `export function ${safeName}(...args) {`,
        `  return ${safeIdentifier}(...args);`,
        `}`,
        "",
      ].join("\n");
    });

    const proxyContent = [
      `// Auto-generated Sandbox Workload Proxy for ${workload.libraryName}/${workload.workloadName}`,
      `import { __getSandboxWorkloadExport } from "./${workload.libraryName}-proxy.js";`,
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
