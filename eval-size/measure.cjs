// Builds each security scenario in sandbox mode into a fresh directory and
// reports the shipped bytes by category.
const fs = require("fs");
const os = require("os");
const path = require("path");
const webpack = require("webpack");
const makeConfig = require("../webpack.security.config.cjs");

function build(scenario) {
  const out = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `size-${scenario}-`)));
  const config = makeConfig({ scenario, mode: "sandbox" });
  config.output = { ...config.output, path: out, clean: true };
  config.infrastructureLogging = { level: "error" };
  return new Promise((resolve, reject) => webpack(config, (err, stats) => {
    if (err) return reject(err);
    if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
    const files = fs.readdirSync(out);
    const size = (f) => fs.statSync(path.join(out, f)).size;
    const wasm = files.filter((f) => f.endsWith(".wasm"));
    const js = files.filter((f) => f.endsWith(".js"));
    const sandboxBundles = js.filter((f) => /^(?!vendors|node_modules|_)[^/]+\.bundle\.js$/.test(f) && f !== "bundle.js");
    resolve({
      scenario,
      wasmFiles: wasm.length,
      wasmBytes: wasm.reduce((s, f) => s + size(f), 0),
      wasmSizes: wasm.map(size).sort((a, b) => a - b),
      jsFiles: js.length,
      jsBytes: js.reduce((s, f) => s + size(f), 0),
      sandboxBundleBytes: sandboxBundles.reduce((s, f) => s + size(f), 0),
      totalBytes: files.reduce((s, f) => s + size(f), 0),
    });
    fs.rmSync(out, { recursive: true, force: true });
  }));
}

(async () => {
  const results = [];
  for (const s of ["strip-ansi", "lodash", "image-js"]) results.push(await build(s));
  console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
