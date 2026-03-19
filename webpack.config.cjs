const path = require("path");
const {
  WebpackSandboxPlugin,
} = require("./webpack-sandbox-plugin/src/plugin.js");

module.exports = {
  entry: "./lib-test/test-lib-import.js",
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
    },
    alias: {
      "quickjs-emscripten-sync": path.resolve(
        __dirname,
        "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
      ),
      "strip-ansi-native": path.resolve(__dirname, "node_modules/strip-ansi/index.js"),
      "marked-native": path.resolve(__dirname, "node_modules/marked/lib/marked.esm.js"),
    },
  },
};
