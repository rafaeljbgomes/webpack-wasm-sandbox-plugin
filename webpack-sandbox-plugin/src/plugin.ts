import * as fs from "fs";
import * as path from "path";
import { Compiler, NormalModuleReplacementPlugin } from "webpack";
import { ProxyGenerator } from "./proxy-generator.js";
import { Parser } from "./core/parser.js";
import { findAllDtsFiles } from "./utils/file-utils.js";

export interface SandboxPluginOptions {
  configPath: string;
}

export class WebpackSandboxPlugin {
  private options: SandboxPluginOptions;
  private sandboxCacheDir: string;

  constructor(options: SandboxPluginOptions) {
    this.options = options;
    this.sandboxCacheDir = path.resolve(process.cwd(), ".sandbox");
  }

  apply(compiler: Compiler) {
    // 1. Ensure cache directory exists
    if (!fs.existsSync(this.sandboxCacheDir)) {
      fs.mkdirSync(this.sandboxCacheDir, { recursive: true });
    }

    // 2. Load the Sandbox Config to know which libraries to intercept
    const configPath = path.resolve(compiler.context, this.options.configPath);
    let configuredLibraries: string[] = [];

    try {
      if (fs.existsSync(configPath)) {
        // Since we are running in a build environment, we can dynamically require the configuration
        // We use a dynamic import/require query. Assuming it's standard JS (like sandbox.config.js)
        let configModule = require(configPath);
        // Handle both CommonJS and ES Modules default exports
        const sandboxConfig = configModule.default || configModule;

        configuredLibraries = Object.keys(sandboxConfig);
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

    // 3. Generate Proxies BEFORE compilation starts
    compiler.hooks.beforeCompile.tapAsync(
      "WebpackSandboxPlugin",
      (params, callback) => {
        try {
          configuredLibraries.forEach((libName) => {
            this.generateProxyForLibrary(libName, compiler.context);
          });
          callback();
        } catch (err: any) {
          callback(err);
        }
      },
    );

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

    // 5. Setup Child Compiler to bundle the original library into an IIFE/UMD string
    compiler.hooks.make.tapAsync(
      "WebpackSandboxPlugin",
      (compilation, callback) => {
        const promises = configuredLibraries.map((libName) => {
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

            /* // Resolve the Node.js entry of the library (not the browser variant).
            // QuickJS is not a browser: it has no DOM or browser globals, and host
            // Web APIs are injected explicitly via the sandbox permissions membrane.
            // Without this, webpack's default target:'web' picks up the `browser`
            // field in package.json, which can produce subtly broken bundles
            // (e.g. nanoid's browser customRandom uses `===` instead of `>=` for
            // the termination check, causing an infinite loop inside QJS when called
            // with a non-integer size argument).
            // QuickJS is not a browser — force Node.js entry points.
            // Child compilers inherit the parent's compiled resolver, so setting
            // resolve options after creation is too late. Instead, we use a
            // NormalModuleReplacementPlugin to rewrite browser entries back to
            // Node entries, and an externals mapping for node:crypto.
            new NormalModuleReplacementPlugin(
              /\.browser\.(c?js|mjs)$/,
              (resource: any) => {
                resource.request = resource.request.replace(/\.browser\.(c?js|mjs)$/, '.$1');
              },
            ).apply(childCompiler);
            // node:crypto (used by nanoid's Node entry and others) is not available
            // inside QuickJS. Map it to the global `crypto` object, which is already
            // injected by the sandbox permissions membrane when the library's config
            // includes the "crypto" permission.
            childCompiler.options.externals = [
              ...(Array.isArray(childCompiler.options.externals)
                ? childCompiler.options.externals
                : childCompiler.options.externals
                  ? [childCompiler.options.externals]
                  : []),
              { "node:crypto": "crypto" },
            ]; */
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

        Promise.all(promises)
          .then(() => callback())
          .catch((err) => callback(err));
      },
    );
  }

  private generateProxyForLibrary(libraryName: string, context: string) {
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
      const atTypesPath = path.resolve(context, "node_modules", "@types", libraryName);
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
    const proxyContent = generator.generate(libraryData, libraryName);

    fs.writeFileSync(proxyPath, proxyContent);
    console.log(
      `[SandboxPlugin] Generated Sandbox Proxy for ${libraryName} at ${proxyPath}`,
    );
  }
}
