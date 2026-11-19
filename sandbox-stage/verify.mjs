#!/usr/bin/env node
// Deploy gate (prototype). Checks a built application against the manifest
// produced by the sandbox stage before it is deployed:
//   1. every sandbox bundle in the deploy directory matches its pinned digest;
//   2. every pinned digest appears in the application's own scripts, i.e. the
//      proxies that load the bundles verify them;
//   3. the classify-or-fail report exists and passed;
//   4. no sandbox bundle is present that the manifest does not pin.
//
// Usage: node sandbox-stage/verify.mjs --manifest <file> --dist <dir> [--report <file>]
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.manifest || !args.dist) {
  console.error("Usage: verify.mjs --manifest <file> --dist <dir> [--report <file>]");
  process.exit(2);
}

const sri = (bytes) => `sha384-${crypto.createHash("sha384").update(bytes).digest("base64")}`;
const manifest = JSON.parse(fs.readFileSync(args.manifest, "utf8"));
const dist = path.resolve(args.dist);
const failures = [];
const pinned = new Map();

for (const [name, entry] of Object.entries(manifest.libraries)) {
  pinned.set(entry.bundle, entry.integrity);
  for (const workload of Object.values(entry.workloads ?? {})) pinned.set(workload.bundle, workload.integrity);
  void name;
}

// 1. Bundle digests.
for (const [file, expected] of pinned) {
  const full = path.join(dist, file);
  if (!fs.existsSync(full)) {
    failures.push(`missing sandbox bundle ${file}`);
    continue;
  }
  const actual = sri(fs.readFileSync(full));
  if (actual !== expected) failures.push(`sandbox bundle ${file} digest ${actual} != pinned ${expected}`);
}

// 2. Digests pinned by the application's scripts (the proxies).
const appScripts = fs.readdirSync(dist, { recursive: true })
  .filter((f) => /\.m?js$/.test(f) && !pinned.has(path.basename(f)))
  .map((f) => fs.readFileSync(path.join(dist, f), "utf8"));
for (const [file, expected] of pinned) {
  if (!appScripts.some((source) => source.includes(expected))) {
    failures.push(`no application script pins the digest of ${file}`);
  }
}

// 3. Classify-or-fail report.
const reportPath = args.report ?? path.join(dist, "sandbox-classification.json");
if (!fs.existsSync(reportPath)) failures.push(`classification report missing at ${reportPath}`);
else {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (!report.passed) failures.push("classification report did not pass");
  if (report.mode !== "error") failures.push(`classification ran in ${report.mode} mode, not error`);
}

// 4. Unpinned sandbox bundles.
// A sandbox bundle defines the agreed global; other chunks (e.g. the QuickJS
// runtime) merely share the file-name suffix.
// Webpack's "var" library output declares it (`var __SANDBOXED_LIB__;`)
// after an optional banner and assigns it at the end.
const isSandboxBundle = (source) => /(^|[;\s])var __SANDBOXED_(LIB|WORKLOAD_\w+)__\s*[;=]/.test(source.slice(0, 8192));
for (const file of fs.readdirSync(dist).filter((f) => f.endsWith(".js"))) {
  if (pinned.has(file)) continue;
  if (isSandboxBundle(fs.readFileSync(path.join(dist, file), "utf8"))) {
    failures.push(`unpinned sandbox bundle ${file} in deploy directory`);
  }
}

console.log(JSON.stringify({ passed: failures.length === 0, checkedBundles: pinned.size, failures }, null, 1));
process.exit(failures.length === 0 ? 0 : 1);
