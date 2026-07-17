export default {
  testEnvironment: "<rootDir>/jest.sandbox-environment.cjs",
  runner: "<rootDir>/jest.sandbox-runner.cjs",
  testResultsProcessor: "<rootDir>/../../compatibility-harness/sanitize-jest-results.cjs",
  roots: ["test"],
  coverageDirectory: "build/coverage",
  collectCoverageFrom: ["src/**/*.js", "!src/zone.js"],
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        configFile: false,
        presets: [["@babel/preset-env", { targets: { node: "current" }, modules: false }]],
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.\\./)+src/luxon(?:\\.js)?$": "<rootDir>/../../.sandbox/proxys/luxon-proxy.js",
    "^quickjs-emscripten-sync$":
      "<rootDir>/../../node_modules/quickjs-emscripten-sync/dist/quickjs-emscripten-sync.js",
  },
};
