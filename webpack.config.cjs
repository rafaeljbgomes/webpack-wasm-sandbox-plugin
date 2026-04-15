const path = require("path");
require("tsx/cjs");
const {
  WebpackSandboxPlugin,
} = require("./webpack-sandbox-plugin/src/plugin.ts");
const webpack = require('webpack');

module.exports = {
  entry: "./lib-test/test-luxon.js",
  output: {
    filename: "bundle.js",
    path: path.resolve(__dirname, "dist"),
  },
  mode: "development",
  experiments: {
    topLevelAwait: true,
  },
  plugins: [
    new WebpackSandboxPlugin({
      configPath: "./.sandbox/sandbox.config.js",
    }),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, '');
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, "/"),
    },
    compress: true,
    port: 9000,
  },
  resolve: {
    fallback: {
      path: false,
      fs: false,
      url: false,
    },
    alias: {
      "quickjs-emscripten-sync": path.resolve(
        __dirname,
        "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
      ),
      "strip-ansi-native": path.resolve(__dirname, "node_modules/strip-ansi/index.js"),
      "marked-native": path.resolve(__dirname, "node_modules/marked/lib/marked.esm.js"),
      "bresenham-zingl": path.resolve(__dirname, "node_modules/bresenham-zingl/dist/index.cjs"),
    },
  },
};
