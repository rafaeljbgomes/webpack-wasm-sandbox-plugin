// Builds one browser page per (scenario, mode), mode in {native, sandbox, lavamoat}.
// The scenarios and workload adapters are the ones of the original evaluation
// (feat/sandbox-benchmarking, performance-harness/browser).
//
// Usage: node eval-perf/build.cjs [scenarioId ...]
const path = require("path");
const fs = require("fs");
require("tsx/cjs");
const webpack = require("webpack");
const { WebpackSandboxPlugin } = require("../webpack-sandbox-plugin/src/plugin.ts");
const LavaMoatPlugin = require("@lavamoat/webpack");

const repo = path.resolve(__dirname, "..");
const H = path.join(__dirname, "performance-harness/browser");
const OUT = path.join(__dirname, "out");

const SCENARIOS = {
  "strip-ansi": "strip-ansi/clean.scenario.js",
  mime: "mime/lookup.scenario.js",
  "date-fns": "date-fns/calendar.scenario.js",
  "image-js": "image-js/transform.scenario.js",
  marked: "marked/parser.scenario.js",
  yup: "yup/validation.scenario.js",
  tweetnacl: "tweetnacl/signature.scenario.js",
  zod: "zod/validation.scenario.js",
  lodash: "lodash/collection.scenario.js",
  luxon: "luxon/scheduling.scenario.js",
  "lodash-adapter": "lodash/collection-adapter.scenario.js",
  "zod-adapter": "zod/validation-adapter.scenario.js",
  "luxon-adapter": "luxon/scheduling-adapter.scenario.js",
  "image-js-adapter": "image-js/transform-adapter.scenario.js",
};

const WORKLOADS = {
  "image-js": { transform: { entry: path.join(H, "workloads/image-js/transform-workload.js"), exports: ["transformImage"] } },
  luxon: { scheduling: { entry: path.join(H, "workloads/luxon/scheduling-workload.js"), exports: ["scheduleMeeting"] } },
  lodash: { collection: { entry: path.join(H, "workloads/lodash/collection-workload.js"), exports: ["summarizeOrders"] } },
  zod: { validation: { entry: path.join(H, "workloads/zod/validation-workload.js"), exports: ["validateOrders"] } },
};
const GRANTS = {
  "strip-ansi": [], marked: [], "image-js": ["Intl", "TextEncoder", "TextDecoder"], luxon: ["Intl"], mime: [],
  tweetnacl: ["crypto"], lodash: [], zod: [], "date-fns": ["Intl"], yup: [],
};

const BOOTSTRAP = `
import run from "__SCENARIO__";
document.__PERF__ = { importMs: null, readyAt: performance.now(), run };
document.title = "ready";
`;

function libraryOf(id) { return id.replace(/-adapter$/, ""); }

// Application-level page: several libraries sandboxed in one page, each in its
// own sandbox; one call runs each library's workload once.
const COMPOSITES = { app3: ["date-fns", "marked", "zod"] };
function compositeScenario(id, buildDir) {
  const libs = COMPOSITES[id];
  const file = path.join(buildDir, "composite.scenario.js");
  fs.writeFileSync(file, libs.map((l, i) => `import run${i} from ${JSON.stringify(path.join(H, "scenarios", SCENARIOS[l]))};`).join("\n") +
    `\nexport default async function run() {\n${libs.map((_, i) => `  await run${i}();`).join("\n")}\n}\n`);
  return file;
}

function config(id, mode, buildDir) {
  const lib = libraryOf(id);
  const entry = path.join(buildDir, "bootstrap.mjs");
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(entry, BOOTSTRAP);
  const policyPath = path.join(buildDir, "policy.cjs");
  const policy = COMPOSITES[id]
    ? Object.fromEntries(COMPOSITES[id].map((l) => [l, { permissions: GRANTS[l] }]))
    : { [lib]: { permissions: GRANTS[lib], ...(id.endsWith("-adapter") ? { workloads: { [Object.keys(WORKLOADS[lib])[0]]: Object.values(WORKLOADS[lib])[0] } } : {}) } };
  fs.writeFileSync(policyPath, `module.exports = ${JSON.stringify(policy, null, 1)};\n`);

  const alias = {
    __SCENARIO__: COMPOSITES[id] ? compositeScenario(id, buildDir) : path.join(H, "scenarios", SCENARIOS[id]),
    "quickjs-emscripten-sync": path.join(repo, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js"),
    "bresenham-zingl": path.join(repo, "node_modules/bresenham-zingl/dist/index.cjs"),
  };
  for (const l of ["lodash", "image-js", "luxon", "zod"]) alias[`sandbox-real/${l}`] = require.resolve(l, { paths: [repo] });
  if (mode !== "sandbox") {
    // Without the sandbox plugin, a workload request is just the workload module.
    for (const [l, ws] of Object.entries(WORKLOADS)) for (const [w, c] of Object.entries(ws)) alias[`sandbox-workload/${l}/${w}`] = c.entry;
  }
  const plugins = [
    new webpack.NormalModuleReplacementPlugin(/^node:/, (r) => { r.request = r.request.replace(/^node:/, ""); }),
  ];
  if (mode === "sandbox") {
    plugins.unshift(new WebpackSandboxPlugin({
      configPath: policyPath,
      proxyDirectory: path.join(repo, ".sandbox", "proxys"),
      classification: { mode: "off" },
    }));
  }
  if (mode === "lavamoat") {
    plugins.push(new LavaMoatPlugin({
      generatePolicy: true,
      policyLocation: path.join(buildDir, "lavamoat"),
      readableResourceIds: true,
    }));
  }
  return {
    mode: "production",
    target: ["web", "es2022"],
    context: repo,
    cache: false,
    devtool: false,
    entry,
    output: { filename: "bundle.js", path: path.join(buildDir, "dist"), publicPath: "/dist/", clean: true },
    experiments: { topLevelAwait: true, asyncWebAssembly: true },
    resolve: { fallback: { path: false, fs: false, url: false }, alias },
    module: { rules: [{ test: /\.png$/i, type: "asset/bytes" }, { test: /\.m?js$/, resolve: { fullySpecified: false } }] },
    plugins,
    stats: "errors-warnings",
    infrastructureLogging: { level: "error" },
  };
}

async function build(id, mode) {
  const buildDir = path.join(OUT, `${id}--${mode}`);
  const stats = await new Promise((res, rej) => webpack(config(id, mode, buildDir), (e, s) => (e ? rej(e) : res(s))));
  if (stats.hasErrors()) throw new Error(stats.toString({ all: false, errors: true }).slice(0, 3000));
  const lockdown = mode === "lavamoat" ? '<script src="/dist/lockdown"></script>' : "";
  fs.writeFileSync(path.join(buildDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"></head><body>${lockdown}<script src="/dist/bundle.js"></script></body></html>`);
  const files = fs.readdirSync(path.join(buildDir, "dist"));
  const size = files.reduce((n, f) => n + fs.statSync(path.join(buildDir, "dist", f)).size, 0);
  return { id, mode, files: files.length, bytes: size };
}

module.exports = { SCENARIOS, COMPOSITES, build, OUT };

if (require.main === module) {
  (async () => {
    const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENARIOS);
    const reportFile = path.join(OUT, process.argv.slice(2).length ? `build-report-${ids.join("_")}.json` : "build-report.json");
    const report = [];
    for (const id of ids) {
      for (const mode of ["native", "sandbox", "lavamoat"]) {
        try { const r = await build(id, mode); report.push(r); console.log("built", JSON.stringify(r)); }
        catch (e) { report.push({ id, mode, error: String(e.message ?? e).slice(0, 1500) }); console.log("FAILED", id, mode, String(e.message ?? e).slice(0, 1500)); }
      }
    }
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
    process.exit(0);
  })();
}
