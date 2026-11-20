// Sandbox-mode helper for test-fp.js. The fp tests load lodash ('../lodash.js',
// redirected to the sandbox proxy) and two conversion helpers from '../fp/'.
// The sandbox redirect would send every '../' import under this harness to the
// proxy; the helpers are not part of the lodash entry point, so they load from
// the harness copy (identical to lodash@4.18.1/fp) and convert the sandboxed _.
const Module = require('module');
const path = require('path');
const fpDir = path.join(__dirname, 'fp');
const sandboxResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (/^\.\.\/fp\/_(baseConvert|mapping)\.js$/.test(request)) {
    return path.join(fpDir, path.basename(request));
  }
  return sandboxResolve.call(this, request, parent, isMain, options);
};
