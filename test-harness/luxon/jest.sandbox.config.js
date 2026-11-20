// Sandbox mode. Tests are unmodified. Imports of the library entry point, and of
// the two public classes some tests import by internal path, resolve to the
// sandbox; every other src/ import except two that only supply constants and
// error classes fails, so no test can silently use the native library.
//
// english.test.js is excluded in both modes: it tests internal helpers
// (src/impl/english, src/impl/formats) that are not reachable through the
// package's entry point, so it would run natively in both modes.
const shim = (name) => `<rootDir>/sandbox-shims/${name}.cjs`;
module.exports = {
  testEnvironment: "<rootDir>/jest.sandbox-environment.cjs",
  testResultsProcessor: "<rootDir>/../../compatibility-harness/sanitize-jest-results.cjs",
  roots: ["test"],
  testPathIgnorePatterns: ["/node_modules/", "/test/impl/english\\.test\\.js$"],
  transform: { "^.+\\.js$": "babel-jest" },
  moduleNameMapper: {
    "^(\\.\\./)+src/luxon(\\.js)?$": shim("luxon"),
    "^(\\.\\./)+src/settings(\\.js)?$": shim("settings"),
    "^(\\.\\./)+src/datetime(\\.js)?$": shim("datetime"),
    "^(\\.\\./)+src/(?!duration(\\.js)?$|errors(\\.js)?$).*$": shim("native-tripwire"),
  },
};
