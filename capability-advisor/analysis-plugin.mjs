import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fingerprint } from "./evidence.mjs";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { compileLibrary, loadSandboxPolicy } = require("../webpack-sandbox-plugin/src/build-helpers.ts");

/** Collects installed package identity; local host modules are excluded from remote evidence. */
function packageIdentity(resource) {
  const normalized = resource.replaceAll("\\", "/").split("?")[0];
  if (!normalized.includes("/node_modules/")) return null;
  let directory = dirname(resource.split("?")[0]);
  while (directory !== dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      try {
        const data = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof data.name === "string" && typeof data.version === "string") {
          return { name: data.name, version: data.version,
            file: `${data.name}/${normalized.slice(directory.replaceAll("\\", "/").length + 1)}` };
        }
      } catch { /* A malformed manifest is represented as incomplete evidence below. */ }
    }
    directory = dirname(directory);
  }
  return null;
}

/** Reads transformed child modules, including concatenated and transitive modules. */
export function collectCompilation(name, compilation) {
  const modules = [];
  const packages = new Map();
  const issues = [];
  const visited = new Set();
  /** Traverses nested modules once, retaining opaque modules as analysis limitations. */
  function collect(module) {
    if (visited.has(module)) return;
    visited.add(module);
    if (module.modules) {
      for (const nested of module.modules) collect(nested);
      return;
    }
    if (module.type && !module.type.startsWith("javascript")) return;
    // Webpack's resolver can deliberately replace a Node-only branch with an inert ignored module.
    if (module.constructor.name === "RawModule" && module.identifier().startsWith("ignored|")) {
      modules.push({ file: `ignored/${fingerprint(module.identifier())}`, hash: fingerprint("webpack-ignored-module") });
      return;
    }
    const identity = module.resource ? packageIdentity(module.resource) : null;
    const source = module.originalSource()?.source();
    const text = source === undefined ? undefined : source.toString();
    if (!identity) {
      issues.push(module.resource ? "local_module_excluded" : "opaque_module");
      modules.push({ file: `excluded/${fingerprint(module.identifier())}`, hash: fingerprint(text ?? module.identifier()) });
      return;
    }
    packages.set(`${identity.name}@${identity.version}`, { name: identity.name, version: identity.version });
    if (text === undefined) issues.push("missing_module_source");
    modules.push({ file: identity.file, hash: fingerprint(text ?? ""), source: text });
  }
  for (const module of compilation.modules) collect(module);
  return { name, packages: [...packages.values()].sort((a, b) => a.name.localeCompare(b.name)),
    modules: modules.sort((a, b) => a.file.localeCompare(b.file)), issues: [...new Set(issues)] };
}

/** Bundles only selected libraries using the same helper as the runtime plugin. */
export class SandboxCapabilityAnalysisPlugin {
  /** Stores the policy path and the caller-owned evidence sink. */
  constructor(configPath, libraries) {
    this.configPath = configPath;
    this.libraries = libraries;
  }

  /** Registers child compilation without host entry replacement or proxy generation. */
  apply(compiler) {
    this.policy = loadSandboxPolicy(this.configPath, compiler.context);
    compiler.hooks.make.tapPromise("SandboxCapabilityAnalysisPlugin", async (compilation) => {
      await Promise.all(Object.keys(this.policy).map(async (name) => {
        const child = await compileLibrary(compiler, compilation, name);
        this.libraries.push(collectCompilation(name, child));
      }));
    });
  }
}
