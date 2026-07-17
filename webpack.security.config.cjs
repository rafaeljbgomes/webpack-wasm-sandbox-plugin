const path = require("path");
require("tsx/cjs");
const webpack = require("webpack");
const {
  WebpackSandboxPlugin,
} = require("./webpack-sandbox-plugin/src/plugin.ts");

const scenarios = {
  lodash: "./src/lodash.js",
  "strip-ansi": "./src/strip-ansi.js",
  "image-js": "./src/image-js.js",
};

module.exports = (env = {}) => {
  const scenario = env.scenario;
  const mode = env.mode;
  const entry = scenarios[scenario];

  if (!entry) {
    throw new Error(
      `Unknown security scenario "${scenario ?? ""}". Expected one of: ${Object.keys(scenarios).join(", ")}.`,
    );
  }

  if (!["native", "sandbox"].includes(mode)) {
    throw new Error(
      `Unknown security mode "${mode ?? ""}". Expected native or sandbox.`,
    );
  }

  const projectRoot = __dirname;
  const securityApp = path.resolve(
    projectRoot,
    "lib-test/security/app",
  );
  const securityConfigPath = path.resolve(
    securityApp,
    `sandbox-configs/${scenario}.js`,
  );
  const plugins = [
    new webpack.DefinePlugin({
      __SECURITY_MODE__: JSON.stringify(mode),
    }),
    new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
      resource.request = resource.request.replace(/^node:/, "");
    }),
  ];

  if (mode === "sandbox") {
    plugins.unshift(
      new WebpackSandboxPlugin({
        configPath: `./sandbox-configs/${scenario}.js`,
      }),
      new webpack.NormalModuleReplacementPlugin(
        /sandbox\.config\.js$/,
        (resource) => {
          resource.request = securityConfigPath;
        },
      ),
    );
  }

  return {
    context: securityApp,
    entry,
    output: {
      filename: "bundle.js",
      path: path.resolve(projectRoot, "dist"),
      clean: false,
    },
    mode: "development",
    target: ["web", "es2022"],
    experiments: {
      topLevelAwait: true,
      asyncWebAssembly: true,
    },
    plugins,
    devServer: {
      static: {
        directory: projectRoot,
      },
      compress: true,
      port: 9000,
    },
    resolve: {
      modules: [
        path.resolve(securityApp, "node_modules"),
        path.resolve(projectRoot, "node_modules"),
      ],
      fallback: {
        path: false,
        fs: false,
        url: false,
      },
      alias: {
        "quickjs-emscripten-sync": path.resolve(
          projectRoot,
          "node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
        ),
        "ml-xsadd$": path.resolve(
          securityApp,
          "src/shims/ml-xsadd.js",
        ),
        "bresenham-zingl": path.resolve(
          securityApp,
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
  };
};
