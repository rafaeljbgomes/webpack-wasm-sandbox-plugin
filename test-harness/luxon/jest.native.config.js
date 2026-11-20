// Upstream jest.config.js plus the harness result sanitizer. The internal-only
// test file english.test.js is excluded in both modes (see jest.sandbox.config.js).
module.exports = {
  testEnvironment: "node",
  testResultsProcessor: "<rootDir>/../../compatibility-harness/sanitize-jest-results.cjs",
  roots: ["test"],
  testPathIgnorePatterns: ["/node_modules/", "/test/impl/english\\.test\\.js$"],
  transform: { "^.+\\.js$": "babel-jest" },
};
