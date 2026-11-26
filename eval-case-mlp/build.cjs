// Case study (M3/M7): Markdown Live Preview, a small open-source browser
// application (github.com/tanabe/markdown-live-preview, commit 051369f,
// MIT). Its unmodified src/main.js is built with Webpack, because our plugin
// targets Webpack (the project itself uses Vite), in three modes:
//   native    no isolation
//   sandbox   marked runs in its own QuickJS sandbox with an empty grant,
//             and classify-or-fail checks every other package in the bundle
//   lavamoat  @lavamoat/webpack with a generated policy
// The page is the project's index.html with the Google Analytics tag removed
// (no external requests) and the module script pointed at the bundle.
//
// Usage: APP=<path to the checkout> node eval-case-mlp/build.cjs [mode ...]
//   CLASSIFY=off|error (default error), TRUSTED=<file> (default ./trusted.cjs)
const path = require("path");
const fs = require("fs");
require("tsx/cjs");
const webpack = require("webpack");
const { WebpackSandboxPlugin } = require("../webpack-sandbox-plugin/src/plugin.ts");

const here = __dirname;
const repo = path.resolve(here, "..");
const APP = path.resolve(process.env.APP ?? "");
if (!fs.existsSync(path.join(APP, "src/main.js"))) throw new Error("set APP to the markdown-live-preview checkout");
const OUT = path.join(here, "out");
const loader = (n) => require.resolve(n, { paths: [here] });

// opts (output-integrity study, output-integrity/run.mjs): outName (output
// directory), outputs (output contracts for marked), forget (the app skips its
// DOMPurify call), csp (Content-Security-Policy meta tag added to the page),
// policy (lavamoat mode only): "generate" (default; generate into
// <out>/lavamoat while building), "generate-only" (write policy.json to
// opts.policyDir and emit no bundle), or the directory of an existing policy
// (policy.json plus an optional policy-override.json) to build under.
function config(mode, outRoot, opts = {}) {
  const plugins = [];
  if (mode === "sandbox") {
    const policyPath = path.join(outRoot, "policy.cjs");
    fs.mkdirSync(outRoot, { recursive: true });
    fs.writeFileSync(policyPath, `module.exports = ${JSON.stringify({ marked: { permissions: [], ...(opts.outputs ? { outputs: opts.outputs } : {}) } }, null, 1)};\n`);
    plugins.push(new WebpackSandboxPlugin({
      configPath: policyPath,
      proxyDirectory: path.join(repo, ".sandbox", "proxys"),
      classification: { mode: process.env.CLASSIFY ?? "error", trustedPath: process.env.TRUSTED ?? path.join(here, "trusted.cjs") },
    }));
  }
  if (mode === "lavamoat") {
    const LavaMoatPlugin = require("@lavamoat/webpack");
    const pol = opts.policy ?? "generate";
    plugins.push(new LavaMoatPlugin(
      pol === "generate" ? { generatePolicy: true, policyLocation: path.join(outRoot, "lavamoat"), readableResourceIds: true }
      : pol === "generate-only" ? { generatePolicyOnly: true, policyLocation: path.resolve(opts.policyDir), readableResourceIds: true }
      // emitPolicySnapshot writes the effective policy (override applied) next to the bundle
      : { policyLocation: path.resolve(pol), readableResourceIds: true, emitPolicySnapshot: true }));
  }
  return {
    mode: "production",
    target: ["web", "es2022"],
    context: APP,
    cache: false,
    devtool: false,
    entry: "./src/main.js",
    output: { filename: "bundle.js", path: path.join(outRoot, "dist"), publicPath: "/dist/", clean: true,
      // Pages that enforce Trusted Types need Webpack's chunk-loading policy.
      ...(opts.csp && opts.csp.includes("require-trusted-types-for") ? { trustedTypes: { policyName: "webpack" } } : {}) },
    experiments: { topLevelAwait: true, asyncWebAssembly: true },
    resolve: {
      modules: [path.join(APP, "node_modules"), path.join(repo, "node_modules"), "node_modules"],
      fallback: { path: false, fs: false, url: false },
      alias: { "quickjs-emscripten-sync": path.join(repo, "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js") },
    },
    resolveLoader: { modules: [path.join(here, "node_modules"), path.join(repo, "node_modules")] },
    module: {
      rules: [
        { test: /[\\/]src[\\/]main\.js$/, use: [{ loader: path.join(here, "start-after-load-loader.cjs"), options: { forget: !!opts.forget, bypass: !!opts.bypass } }] },
        { test: /\.css$/, use: [loader("style-loader"), loader("css-loader")] },
        { test: /\.ttf$/, type: "asset/resource" },
        { test: /\.m?js$/, resolve: { fullySpecified: false } },
      ],
    },
    performance: { hints: false },
    plugins,
    stats: "errors-warnings",
    infrastructureLogging: { level: "error" },
  };
}

function page(outRoot, mode, opts = {}) {
  let html = fs.readFileSync(path.join(APP, "index.html"), "utf8");
  html = html.replace(/<!-- Google tag[\s\S]*?<\/script>\s*<script>[\s\S]*?gtag\('config'[^<]*<\/script>/, "");
  html = html.replace(/<script async src="https:\/\/www\.googletagmanager\.com[^>]*><\/script>/, "");
  html = html.replace(/<script type="module" src="\/src\/main\.js[^"]*"><\/script>/,
    `${mode === "lavamoat" ? '<script src="/dist/lockdown"></script>' : ""}<script src="/dist/bundle.js"></script>`);
  if (/googletagmanager|gtag\(/.test(html)) throw new Error("analytics tag still present");
  if (opts.csp) html = html.replace(/<head>/, `<head>\n<meta http-equiv="Content-Security-Policy" content="${opts.csp}">`);
  fs.writeFileSync(path.join(outRoot, "index.html"), html);
  fs.cpSync(path.join(APP, "public"), outRoot, { recursive: true });
}

async function build(mode, opts = {}) {
  const outRoot = path.join(OUT, opts.outName ?? mode);
  const t0 = Date.now();
  const stats = await new Promise((ok, ko) => webpack(config(mode, outRoot, opts), (e, s) => (e ? ko(e) : ok(s))));
  const ms = Date.now() - t0;
  if (mode === "lavamoat" && opts.policy === "generate-only") {
    // LavaMoat reports incompatible packages on the console and writes nothing; fail loudly here.
    const file = path.join(path.resolve(opts.policyDir), "policy.json");
    if (!fs.existsSync(file)) throw new Error(`no policy written to ${file} (LavaMoat stopped; see its console output)`);
    return { mode, policy: path.resolve(opts.policyDir), buildMs: ms };
  }
  if (stats.hasErrors()) {
    const text = stats.toString({ all: false, errors: true });
    fs.mkdirSync(outRoot, { recursive: true });
    fs.writeFileSync(path.join(outRoot, "build-errors.txt"), text);
    const flagged = [...new Set([...text.matchAll(/Package "([^"]+)"@(\S+) is neither/g)].map((m) => m[1]))].sort();
    fs.writeFileSync(path.join(outRoot, "flagged.json"), JSON.stringify(flagged, null, 1));
    throw new Error(`${flagged.length} packages flagged by classify-or-fail; see build-errors.txt\n` + text.slice(0, 1500));
  }
  page(outRoot, mode, opts);
  const files = fs.readdirSync(path.join(outRoot, "dist"));
  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(outRoot, "dist", f)).size, 0);
  return { mode, buildMs: ms, files: files.length, bytes };
}

module.exports = { build, OUT };
if (require.main === module) {
  (async () => {
    const modes = process.argv.slice(2).length ? process.argv.slice(2) : ["native", "sandbox"];
    for (const m of modes) {
      try { console.log(JSON.stringify(await build(m))); } catch (e) { console.log(m, "FAILED", String(e.message ?? e).slice(0, 3000)); process.exitCode = 1; }
    }
  })();
}
