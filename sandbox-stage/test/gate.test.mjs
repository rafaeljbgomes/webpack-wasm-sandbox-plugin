import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verify = fileURLToPath(new URL("../verify.mjs", import.meta.url));
const sri = (bytes) => `sha384-${crypto.createHash("sha384").update(bytes).digest("base64")}`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** A deploy directory as the application build leaves it, plus the stage outputs. */
function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-gate-test-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  const bundle = Buffer.from("var __SANDBOXED_LIB__;\n__SANDBOXED_LIB__ = { f: () => 1 };\n");
  fs.writeFileSync(path.join(dist, "lib-a.bundle.js"), bundle);
  fs.writeFileSync(path.join(dist, "main.js"), `__loadSandboxBundle("lib-a.bundle.js", "${sri(bundle)}");\n`);
  fs.writeFileSync(path.join(dist, "sandbox-classification.json"), JSON.stringify({ mode: "error", passed: true }));
  const manifestBytes = Buffer.from(JSON.stringify({
    manifestVersion: 1, policySha256: "0".repeat(64),
    libraries: { "lib-a": { bundle: "lib-a.bundle.js", integrity: sri(bundle), grant: [] } },
  }));
  const manifest = path.join(root, "sandbox-manifest.json");
  fs.writeFileSync(manifest, manifestBytes);
  const pin = path.join(root, "sandbox-manifest.sha256");
  fs.writeFileSync(pin, `# reviewed\n${sha256(manifestBytes)}\n`);
  return { root, dist, manifest, pin };
}

const run = (...args) => spawnSync(process.execPath, [verify, ...args], { encoding: "utf8" });

test("passes with the reviewed manifest and writes the deployment headers", (t) => {
  const { root, dist, manifest, pin } = setup(t);
  const headersOut = path.join(root, "headers.json");
  const result = run("--manifest", manifest, "--dist", dist, "--pin", pin, "--headers-out", headersOut);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const headers = JSON.parse(fs.readFileSync(headersOut, "utf8"));
  assert.match(headers.document["Content-Security-Policy"], /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(headers.document["Content-Security-Policy"], /'unsafe-eval'/);
  assert.deepEqual(headers.paths["/dist/lib-a.bundle.js"], {
    "Content-Type": "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  assert.match(fs.readFileSync(`${headersOut}.txt`, "utf8"), /^\/dist\/lib-a\.bundle\.js$/m);
});

test("fails, and writes no headers, when the manifest is not the reviewed one", (t) => {
  const { root, dist, manifest, pin } = setup(t);
  fs.appendFileSync(manifest, " ");
  const headersOut = path.join(root, "headers.json");
  const result = run("--manifest", manifest, "--dist", dist, "--pin", pin, "--headers-out", headersOut);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /!= reviewed pin/);
  assert.equal(fs.existsSync(headersOut), false);
});

test("fails when the pin file is missing or empty", (t) => {
  const { dist, manifest, pin } = setup(t);
  fs.writeFileSync(pin, "# nothing reviewed yet\n");
  const result = run("--manifest", manifest, "--dist", dist, "--pin", pin);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /holds no SHA-256/);
});

test("fails on a tampered bundle and on an unpinned sandbox bundle", (t) => {
  const { dist, manifest, pin } = setup(t);
  fs.writeFileSync(path.join(dist, "extra.bundle.js"), "var __SANDBOXED_LIB__;\n");
  fs.appendFileSync(path.join(dist, "lib-a.bundle.js"), "fetch('//x');\n");
  const result = run("--manifest", manifest, "--dist", dist, "--pin", pin);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /lib-a\.bundle\.js digest/);
  assert.match(result.stdout, /unpinned sandbox bundle extra\.bundle\.js/);
});
