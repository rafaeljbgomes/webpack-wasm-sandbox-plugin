function clearFailureDetails(assertions) {
  if (!Array.isArray(assertions)) {
    return;
  }

  for (const assertion of assertions) {
    if (assertion && typeof assertion === "object") {
      assertion.failureDetails = [];
    }
  }
}

module.exports = function sanitizeJestResults(results) {
  for (const suite of results.testResults ?? []) {
    suite.failureDetails = [];
    clearFailureDetails(suite.testResults);
    clearFailureDetails(suite.assertionResults);
  }

  return results;
};
