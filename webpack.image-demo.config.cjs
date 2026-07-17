const path = require("path");
require("tsx/cjs");
const webpack = require("webpack");
const {
  WebpackSandboxPlugin,
} = require("./webpack-sandbox-plugin/src/plugin.ts");

const projectRoot = __dirname;
const securityApp = path.resolve(projectRoot, "lib-test/security/app");
const demoSandboxConfig = path.resolve(
  securityApp,
  "sandbox-configs/image-demo.js",
);

module.exports = {
  mode: "development",
  target: ["web", "es2022"],
  context: securityApp,
  entry: "./src/image-demo.js",
  output: {
    filename: "image-demo.bundle.js",
    path: path.resolve(projectRoot, "dist"),
    clean: false,
  },
  experiments: { topLevelAwait: true, asyncWebAssembly: true },
  plugins: [
    new WebpackSandboxPlugin({ configPath: "./sandbox-configs/image-demo.js" }),
    /* new webpack.NormalModuleReplacementPlugin(
      /sandbox\.config\.js$/,
      (resource) => {
        resource.request = demoSandboxConfig;
      },
    ), */
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
    new webpack.DefinePlugin({
      __IMAGE_DEMO_MODE__: JSON.stringify("isolated"),
    }),
  ],
  resolve: {
    modules: [
      path.resolve(securityApp, "node_modules"),
      path.resolve(projectRoot, "node_modules"),
    ],
    fallback: { path: false, fs: false, url: false },
    alias: {
      "quickjs-emscripten-sync": path.resolve(
        projectRoot,
        "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
      ),
      "ml-xsadd$": path.resolve(securityApp, "src/shims/ml-xsadd.js"),
      "bresenham-zingl": path.resolve(
        securityApp,
        "node_modules/bresenham-zingl/dist/index.cjs",
      ),
    },
  },
  module: {
    rules: [
      { test: /\.png$/i, type: "asset/bytes" },
      { test: /\.m?js$/, resolve: { fullySpecified: false } },
    ],
  },
};
