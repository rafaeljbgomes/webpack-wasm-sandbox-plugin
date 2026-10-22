import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, join, dirname } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import webpack from "webpack";
import { SandboxCapabilityAnalysisPlugin } from "./analysis-plugin.mjs";
import { analyzeLibrary, fingerprint } from "./evidence.mjs";
import { API_KEY_ENV, buildRequests, classifyRequests, createProviderClient } from "./requests.mjs";
import { createReport, renderDraft, renderMarkdown } from "./report.mjs";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { WebpackSandboxPlugin } = require("../webpack-sandbox-plugin/src/plugin.ts");

/** Parses explicit preparation options; combinations never implicitly contact the provider. */
export function parseArgs(argv) {
  const options = { config: "./.sandbox/sandbox.config.js", webpackConfig: "./webpack.bundles.config.cjs",
    outDir: "./capability-advisor-results", env: {}, dryRun: false, offline: false, refresh: false, help: false };
  const valued = { "--config": "config", "--webpack-config": "webpackConfig", "--out-dir": "outDir" };
  const flags = { "--dry-run": "dryRun", "--offline": "offline", "--refresh": "refresh", "--help": "help" };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option in flags) options[flags[option]] = true;
    else if (option in valued || option === "--env") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
      if (option === "--env") {
        const separator = value.indexOf("=");
        if (separator < 1) throw new Error("--env requires key=value");
        Object.defineProperty(options.env, value.slice(0, separator), { value: value.slice(separator + 1), enumerable: true });
      } else options[valued[option]] = value;
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (options.refresh && options.offline) throw new Error("--refresh and --offline cannot be combined");
  return options;
}

/** Encodes effective build settings for hashing only; values never enter generated reports. */
function encodeSettings(value, ancestors = new Set()) {
  if (typeof value === "function") return value.toString();
  if (value instanceof RegExp) return value.toString();
  if (value === undefined) return "[undefined]";
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  const next = new Set([...ancestors, value]);
  if (Array.isArray(value)) return value.map((item) => encodeSettings(item, next));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, encodeSettings(value[key], next)]));
}

/** Rejects lossy draft serialization instead of silently removing executable policy fields. */
function assertDraftSerializable(value, ancestors = new Set()) {
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error("Advisor drafts require JSON-serializable policy fields; the active policy was not modified");
  }
  for (const child of Object.values(value)) assertDraftSerializable(child, new Set([...ancestors, value]));
}

/** Runs and closes a one-shot compiler, treating compilation errors as incomplete analysis. */
function compile(config) {
  return new Promise((resolveRun, reject) => {
    let compiler;
    try {
      compiler = webpack(config);
      compiler.run((error, stats) => {
        compiler.close((closeError) => {
          if (error || closeError || stats?.hasErrors()) reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })));
          else resolveRun();
        });
      });
    } catch (error) { reject(error); }
  });
}

/** Builds evidence, evaluates or previews requests, and writes reviewable artifacts. */
export async function runAdvisor(options, dependencies = {}) {
  const base = dependencies.cwd ?? process.cwd();
  const webpackPath = resolve(base, options.webpackConfig);
  let loaded = require(webpackPath);
  loaded = loaded.default ?? loaded;
  if (typeof loaded === "function") loaded = await loaded(options.env, { mode: undefined });
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) throw new Error("Advisor requires one Webpack configuration object or factory");
  const context = loaded.context ?? base;
  const configPath = resolve(context, options.config);
  const outputRoot = resolve(base, options.outDir);
  const runDirectory = join(outputRoot, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
  const cacheDirectory = join(outputRoot, "cache");
  mkdirSync(runDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  const rawLibraries = [];
  const analysis = new SandboxCapabilityAnalysisPlugin(configPath, rawLibraries);
  // Retain resolver/loader/define plugins; remove only the sandbox's host import/proxy integration.
  const settings = { ...loaded, context, entry: {}, watch: false,
    output: { ...loaded.output, path: join(runDirectory, "bundles"), clean: false },
    plugins: [...(loaded.plugins ?? []).filter((plugin) => !(plugin instanceof WebpackSandboxPlugin)), analysis] };
  assertDraftSerializable(require(configPath).default ?? require(configPath));
  await compile(settings);
  const libraries = rawLibraries.sort((a, b) => a.name.localeCompare(b.name)).map(analyzeLibrary);
  const requests = libraries.flatMap(buildRequests);
  const advisorDirectory = dirname(fileURLToPath(import.meta.url));
  const buildFingerprint = fingerprint({
    webpack: readFileSync(webpackPath, "utf8"), settings: encodeSettings(loaded),
    modules: libraries.map((library) => library.moduleFingerprint),
    implementation: ["evidence.mjs", "analysis-plugin.mjs", "requests.mjs", "report.mjs", "catalogue.mjs", "suggest.mjs"].map((name) => readFileSync(join(advisorDirectory, name), "utf8")),
  });
  writeFileSync(join(runDirectory, "requests.json"), JSON.stringify(requests, null, 2));
  let client = dependencies.client;
  if (!options.dryRun && !options.offline && !client && process.env[API_KEY_ENV]) {
    client = await createProviderClient(process.env[API_KEY_ENV]);
  }
  const results = options.dryRun ? [] : await classifyRequests(requests, {
    cacheDirectory, buildFingerprint, client, offline: options.offline, refresh: options.refresh,
  });
  const { report, draft } = createReport(analysis.policy, libraries, requests, results, {
    dryRun: options.dryRun, offline: options.offline, buildFingerprint,
    policyPath: configPath, webpackConfigPath: webpackPath,
    requestResults: results.map(({ key, cached, error, response }) => ({ key, cached, error, model: response?.model, usage: response?.usage })),
  });
  writeFileSync(join(runDirectory, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(runDirectory, "report.md"), renderMarkdown(report));
  writeFileSync(join(runDirectory, "sandbox.config.suggested.js"), renderDraft(draft));
  return { runDirectory, report, incomplete: !options.dryRun && results.some((result) => result.error) };
}

/** Handles CLI output without printing SDK errors, credentials or response bodies. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run sandbox:suggest -- [--config <policy>] [--webpack-config <config>] [--env key=value] [--out-dir <directory>] [--dry-run | --offline | --refresh]");
    return;
  }
  const result = await runAdvisor(options);
  console.log(`Capability advisor: ${result.report.libraries.length} libraries. Review ${join(result.runDirectory, "report.md")}`);
  if (result.incomplete) {
    console.error("Some classifications are incomplete. See report.json for sanitized failure codes; no permissions were added from failed requests.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`[CapabilityAdvisor] ${error.message}`); process.exitCode = 1; });
}
