const path = require("path");
require("tsx/cjs");
const webpack = require("webpack");
const {
  WebpackSandboxPlugin,
} = require("../../webpack-sandbox-plugin/src/plugin.ts");

function createBrowserWebpackConfig({
  repoRoot,
  buildMode,
  repetitions,
  scenarioPath,
  tempRoot,
}) {
  const plugins = [
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
  ];

  if (buildMode === "sandbox") {
    plugins.unshift(
      new WebpackSandboxPlugin({
        configPath: "./.sandbox/sandbox.config.js",
      }),
    );
  }

  return {
    name: `performance-browser-${buildMode}`,
    mode: "development",
    target: ["web", "es2022"],
    context: repoRoot,
    cache: false,
    devtool: false,
    entry: path.resolve(__dirname, "bootstrap.js"),
    output: {
      filename: "browser-scenario.js",
      path: path.resolve(tempRoot, "dist"),
      publicPath: "/dist/",
      clean: true,
    },
    experiments: {
      topLevelAwait: true,
      asyncWebAssembly: true,
    },
    resolve: {
      fallback: {
        path: false,
        fs: false,
        url: false,
      },
      alias: {
        "__SANDBOX_PERF_SCENARIO__": scenarioPath,
        "sandbox-workload/lodash/collection": path.resolve(
          repoRoot,
          "performance-harness/browser/workloads/lodash/collection-workload.js",
        ),
        "sandbox-workload/zod/validation": path.resolve(
          repoRoot,
          "performance-harness/browser/workloads/zod/validation-workload.js",
        ),
        "sandbox-real/lodash": require.resolve("lodash", {
          paths: [repoRoot],
        }),
        "sandbox-real/zod": require.resolve("zod", {
          paths: [repoRoot],
        }),
        "quickjs-emscripten-sync": path.resolve(
          repoRoot,
          "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
        ),
        "bresenham-zingl": path.resolve(
          repoRoot,
          "node_modules/bresenham-zingl/dist/index.cjs",
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
    plugins: [
      ...plugins,
      new webpack.DefinePlugin({
        __SANDBOX_PERF_REPETITIONS__: JSON.stringify(repetitions),
      }),
    ],
    stats: "errors-warnings",
  };
}

module.exports = {
  createBrowserWebpackConfig,
};
