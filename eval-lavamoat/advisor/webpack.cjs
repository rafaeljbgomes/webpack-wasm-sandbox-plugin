const path = require("path");
const app = process.env.ADV_APP;
module.exports = { context: app, mode: "development", target: ["web", "es2022"],
  resolve: { modules: [path.join(app, "node_modules"), path.resolve(__dirname, "../../node_modules")], fallback: { path: false, fs: false, url: false },
    alias: { "ml-xsadd$": path.join(app, "src/shims/ml-xsadd.js"), "bresenham-zingl": path.join(app, "node_modules/bresenham-zingl/dist/index.cjs") } },
  module: { rules: [{ test: /\.m?js$/, resolve: { fullySpecified: false } }] } };
