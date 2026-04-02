const Module = require('module');
  const path = require('path');

  // Resolve config relative to the project root (two levels up from test-sandbox-redirect/)
  const projectRoot = path.resolve(__dirname, '..');
  const config = require(path.resolve(projectRoot, '.sandbox/sandbox.config.cjs'));
  const sandboxedLibs = new Set(Object.keys(config));

  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    // Only intercept bare package specifiers that are in the sandbox config.
    // Relative imports (./is-bipartite-by.js) are left untouched.
    if (sandboxedLibs.has(request)) {
      return path.resolve(projectRoot, `.sandbox/${request}-proxy.js`);
    }
    return original.call(this, request, parent, isMain, options);
  };