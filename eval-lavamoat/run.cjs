// Runs the three controlled scenarios of the security evaluation under
// LavaMoat's Webpack plugin, next to native and sandbox builds.
//
// Variants:
//   native              no isolation
//   sandbox             this work (policy: sandbox-configs/<scenario>.js)
//   lavamoat-clean      LavaMoat policy generated from the CLEAN release, then
//                       the compromised release is built under that policy
//   lavamoat-regen      LavaMoat policy regenerated from the compromised release
//   lavamoat-reviewed   the regenerated policy after review: each package keeps
//                       only the globals our grant for that library allows,
//                       plus ECMAScript built-ins (which QuickJS provides too);
//                       the removals are written as policy-override.json
//
// VARIANTS=a,b limits the run to some variants and merges the build report.
// Usage: node eval-lavamoat/run.cjs
const path = require("path");
const fs = require("fs");
require("tsx/cjs");
const webpack = require("webpack");
const LavaMoatPlugin = require("@lavamoat/webpack");
const { WebpackSandboxPlugin } = require("../webpack-sandbox-plugin/src/plugin.ts");

const repo = path.resolve(__dirname, "..");
const app = path.join(repo, "lib-test/security/app");
const cleanApp = process.env.CLEAN_APP;
const OUT = path.join(__dirname, "out");
const SCEN = ["lodash", "strip-ansi", "image-js"];
// Our grants (sandbox-configs/<scenario>.js), as global-name prefixes.
const GRANT = { lodash: [], "strip-ansi": [], "image-js": ["Intl", "TextEncoder", "TextDecoder"] };
const ES_BUILTINS = new Set(["Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "Error", "EvalError", "Float32Array", "Float64Array", "Int8Array", "Int16Array", "Int32Array", "JSON", "Map", "Math", "Number", "Object", "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError", "TypeError", "URIError", "Uint8Array", "Uint8ClampedArray", "Uint16Array", "Uint32Array", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt", "decodeURIComponent", "encodeURIComponent"]);
function review(policy, scenario) {
  const reviewed = JSON.parse(JSON.stringify(policy));
  const override = { resources: {} };
  for (const [pkg, res] of Object.entries(reviewed.resources ?? {})) {
    if (!res.globals) continue;
    for (const [g, v] of Object.entries(res.globals)) {
      const root = g.split(".")[0];
      const keep = v !== "write" && (ES_BUILTINS.has(root) || GRANT[scenario].some((a) => g === a || g.startsWith(a + ".")));
      if (!keep) {
        delete res.globals[g];
        ((override.resources[pkg] ??= { globals: {} }).globals)[g] = false;
      }
    }
  }
  return { reviewed, override };
}

function cfg({ scenario, mode, context, outDir, lavamoat }) {
  const plugins = [
    new webpack.DefinePlugin({ __SECURITY_MODE__: JSON.stringify(mode.startsWith("lavamoat") ? "lavamoat" : mode) }),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (r) => { r.request = r.request.replace(/^node:/, ""); }),
  ];
  if (mode === "sandbox") plugins.unshift(new WebpackSandboxPlugin({ configPath: `./sandbox-configs/${scenario}.js`, classification: { mode: "off" }, proxyDirectory: path.join(repo, ".sandbox/proxys") }));
  if (lavamoat) plugins.push(new LavaMoatPlugin(lavamoat));
  const rules = [{ test: /\.m?js$/, resolve: { fullySpecified: false } }];
  if (mode.startsWith("lavamoat")) rules.push({ test: /[\\/]src[\\/](lodash|strip-ansi|image-js)\.js$/, use: [path.join(__dirname, "tla-wrap-loader.cjs")] });
  return {
    context, entry: `./src/${scenario}.js`, mode: "development", devtool: false, target: ["web", "es2022"],
    output: { filename: "bundle.js", path: outDir, publicPath: "/dist/", clean: true },
    experiments: { topLevelAwait: true, asyncWebAssembly: true },
    resolve: {
      modules: [path.join(context, "node_modules"), path.join(repo, "node_modules")],
      fallback: { path: false, fs: false, url: false },
      alias: {
        "quickjs-emscripten-sync": path.join(repo, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js"),
        "ml-xsadd$": path.join(context, "src/shims/ml-xsadd.js"),
        "bresenham-zingl": path.join(context, "node_modules/bresenham-zingl/dist/index.cjs"),
      },
    },
    module: { rules }, plugins, stats: "errors-warnings", infrastructureLogging: { level: "error" },
  };
}
const run = (c) => new Promise((ok, ko) => webpack(c, (e, s) => (e ? ko(e) : s.hasErrors() ? ko(new Error(s.toString({ all: false, errors: true }).slice(0, 2000))) : ok(s))));

function page(outRoot, lavamoat) {
  const html = fs.readFileSync(path.join(repo, "index.html"), "utf8")
    .replace('<script src="/dist/bundle.js"></script>', `${lavamoat ? '<script src="/dist/lockdown"></script>' : ""}<script src="/dist/bundle.js"></script>`);
  fs.writeFileSync(path.join(outRoot, "index.html"), html);
}

(async () => {
  const report = {};
  for (const scenario of SCEN) {
    const VARIANTS = process.env.VARIANTS ? process.env.VARIANTS.split(",") : ["native", "sandbox", "lavamoat-clean", "lavamoat-regen", "lavamoat-reviewed"];
    for (const variant of VARIANTS) {
      const outRoot = path.join(OUT, `${scenario}--${variant}`);
      const outDir = path.join(outRoot, "dist");
      fs.mkdirSync(outRoot, { recursive: true });
      const r = (report[`${scenario}--${variant}`] = {});
      try {
        if (variant === "lavamoat-clean") {
          const polDir = path.join(outRoot, "policy-clean");
          // 1) generate the policy from the clean release
          await run(cfg({ scenario, mode: variant, context: cleanApp, outDir: path.join(outRoot, "gen"), lavamoat: { generatePolicyOnly: true, policyLocation: polDir } }));
          r.policy = JSON.parse(fs.readFileSync(path.join(polDir, "policy.json"), "utf8"));
          // 2) build the compromised release under that policy
          await run(cfg({ scenario, mode: variant, context: app, outDir, lavamoat: { policy: r.policy, readableResourceIds: true } }));
        } else if (variant === "lavamoat-regen") {
          const polDir = path.join(outRoot, "policy-regen");
          await run(cfg({ scenario, mode: variant, context: app, outDir, lavamoat: { generatePolicy: true, policyLocation: polDir, readableResourceIds: true } }));
          r.policy = JSON.parse(fs.readFileSync(path.join(polDir, "policy.json"), "utf8"));
        } else if (variant === "lavamoat-reviewed") {
          const polDir = path.join(outRoot, "policy-regen");
          await run(cfg({ scenario, mode: variant, context: app, outDir: path.join(outRoot, "gen"), lavamoat: { generatePolicyOnly: true, policyLocation: polDir } }));
          const regen = JSON.parse(fs.readFileSync(path.join(polDir, "policy.json"), "utf8"));
          const { reviewed, override } = review(regen, scenario);
          fs.writeFileSync(path.join(outRoot, "policy-override.json"), JSON.stringify(override, null, 1));
          fs.writeFileSync(path.join(outRoot, "policy-reviewed.json"), JSON.stringify(reviewed, null, 1));
          r.policy = reviewed; r.removed = override;
          await run(cfg({ scenario, mode: variant, context: app, outDir, lavamoat: { policy: reviewed, readableResourceIds: true } }));
        } else {
          await run(cfg({ scenario, mode: variant, context: app, outDir }));
        }
        page(outRoot, variant.startsWith("lavamoat"));
        r.built = true;
      } catch (e) {
        r.built = false; r.buildError = String(e.message ?? e).slice(0, 1500);
      }
      console.log(scenario, variant, r.built ? "built" : "BUILD FAILED " + r.buildError);
    }
  }
  const prev = process.env.VARIANTS && fs.existsSync(path.join(OUT, "build-report.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "build-report.json"), "utf8")) : {};
  fs.writeFileSync(path.join(OUT, "build-report.json"), JSON.stringify({ ...prev, ...report }, null, 1));
  process.exit(0);
})();
