// Loads the generated luxon proxy (an ES module with top-level await) once,
// before the tests, and exposes its namespace to the test context.
const { TestEnvironment } = require("jest-environment-node");
const path = require("path");
const { pathToFileURL } = require("url");

let proxy;
class SandboxEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    proxy ??= await import(
      pathToFileURL(path.resolve(__dirname, "../../.sandbox/proxys/luxon-proxy.js")).href
    );
    this.global.__SANDBOX_LUXON__ = proxy;
  }
}
module.exports = SandboxEnvironment;
