export default {
  testEnvironment: "node",
  testResultsProcessor: "<rootDir>/../../compatibility-harness/sanitize-jest-results.cjs",
  roots: ["test"],
  coverageDirectory: "build/coverage",
  collectCoverageFrom: ["src/**/*.js", "!src/zone.js"],
  transform: {
    "^.+\\.js$": [
      "babel-jest",
      {
        configFile: false,
        presets: [["@babel/preset-env", { targets: { node: "current" }, modules: "commonjs" }]],
      },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/test/setupTests.js"],
};
