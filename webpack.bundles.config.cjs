/**
 * webpack.bundles.config.cjs
 *
 * Builds only the isolated library bundles needed by the QuickJS sandbox
 * (dist/<lib>.bundle.js), without building the main application.
 *
 * Used as a pre-step for compatibility testing:
 *   npx webpack --config webpack.bundles.config.cjs
 */

const path = require("path");
const {
  WebpackSandboxPlugin,
} = require("./webpack-sandbox-plugin/src/plugin.js");

module.exports = {
  // Minimal entry — nothing is actually bundled here.
  // The SandboxPlugin's child compiler handles building the library bundles.
  entry: "./test-harness/init.js",
  output: {
    filename: "_bundles-trigger.js",
    path: path.resolve(__dirname, "dist"),
  },
  mode: "development",
  resolve: {
    alias: {
      "bresenham-zingl": path.resolve(__dirname, "node_modules/bresenham-zingl/dist/index.mjs"),
    },
  },
  module: {
    rules: [
      {
        test: /\.m?js$/,
        resolve: {
          fullySpecified: false,
        },
      },
    ],
  },
  plugins: [
    new WebpackSandboxPlugin({
      configPath: "./.sandbox/sandbox.config.js",
    }),
  ],
};
