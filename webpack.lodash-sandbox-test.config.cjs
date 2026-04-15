/**
 * webpack.lodash-sandbox-test.config.cjs
 *
 * Bundles the lodash sandbox shim for use in the Playwright browser test suite.
 *
 * Outputs:
 *   test-harness/lodash/dist/sandbox-shim.js  — loaded by test/index-sandbox.html
 *   test-harness/lodash/dist/lodash.bundle.js  — copy of dist/lodash.bundle.js so
 *       the proxy's fetch('/dist/lodash.bundle.js') resolves when ecstatic serves
 *       from test-harness/lodash/ (requires build:bundles to have run first).
 *
 * Usage:
 *   npm run build:lodash-test
 */

const path = require("path");
const fs = require("fs");
const webpack = require("webpack");

/**
 * Copies dist/lodash.bundle.js → test-harness/lodash/dist/lodash.bundle.js
 * after the shim bundle is emitted, so the ecstatic server can serve it.
 */
class CopyLodashBundlePlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tapAsync("CopyLodashBundlePlugin", (_compilation, callback) => {
      const src = path.resolve(__dirname, "dist", "lodash.bundle.js");
      const dst = path.resolve(__dirname, "test-harness", "lodash", "dist", "lodash.bundle.js");
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        console.log(`[CopyLodashBundlePlugin] Copied lodash.bundle.js → test-harness/lodash/dist/`);
      } else {
        console.warn(`[CopyLodashBundlePlugin] dist/lodash.bundle.js not found — run build:bundles first.`);
      }
      callback();
    });
  }
}

module.exports = {
  entry: "./test-harness/lodash/sandbox-shim.js",
  output: {
    filename: "sandbox-shim.js",
    path: path.resolve(__dirname, "test-harness", "lodash", "dist"),
  },
  mode: "development",
  experiments: {
    topLevelAwait: true,
    asyncWebAssembly: true,
  },
  plugins: [
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
    new CopyLodashBundlePlugin(),
  ],
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
};
