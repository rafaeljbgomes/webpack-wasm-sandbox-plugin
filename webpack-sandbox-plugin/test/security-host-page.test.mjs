import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SECURITY_README = path.join(PROJECT_ROOT, "lib-test/security/app/README.md");
const buildSecurityConfig = require(path.join(PROJECT_ROOT, "webpack.security.config.cjs"));

/**
 * Returns the repository-relative page the security README tells readers to open.
 *
 * @returns {string} Page path taken from the documented localhost URL.
 */
function documentedHostPage() {
  const readme = fs.readFileSync(SECURITY_README, "utf8");
  const match = readme.match(/http:\/\/localhost:9000\/([\w./-]+\.html)/);
  assert.ok(match, "the security README names the page to open");
  return match[1];
}

test("the security README's host page exists and loads the security bundle", () => {
  const page = path.join(PROJECT_ROOT, documentedHostPage());
  assert.ok(fs.existsSync(page), `${path.relative(PROJECT_ROOT, page)} exists`);

  const html = fs.readFileSync(page, "utf8");
  // reporter.js throws when #output is missing.
  assert.match(html, /id="output"/);
  assert.match(html, /<script src="\/dist\/bundle\.js"><\/script>/);
});

for (const scenario of ["lodash", "strip-ansi", "image-js"]) {
  for (const mode of ["native", "sandbox"]) {
    test(`security build ${scenario}/${mode} writes the bundle the host page loads`, () => {
      const config = buildSecurityConfig({ scenario, mode });
      assert.equal(config.output.filename, "bundle.js");
      assert.equal(config.output.path, path.join(PROJECT_ROOT, "dist"));
      assert.equal(config.devServer.static.directory, PROJECT_ROOT);
    });
  }
}
