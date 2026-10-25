import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import webpack from "webpack";
import { runAdvisor, parseArgs } from "../suggest.mjs";
import { buildRequests, createProviderClient, PROVIDER_BASE_URL, requestWithRetry, validateResponse } from "../requests.mjs";
import { analyzeLibrary } from "../evidence.mjs";
import { MODEL, CLASSIFICATIONS } from "../catalogue.mjs";

const require = createRequire(import.meta.url);
require("tsx/cjs");
const { WebpackSandboxPlugin } = require("../../webpack-sandbox-plugin/src/plugin.ts");
const { loadSandboxPolicy } = require("../../webpack-sandbox-plugin/src/build-helpers.ts");
register("../../test-sandbox-redirect/sandbox-loader.mjs", import.meta.url);
const { SandboxManager } = await import("../../.sandbox/core/sandbox-manager.js");
const { exposeWebAPIs } = await import("../../.sandbox/core/webapi-exposure.js");

/** Creates isolated installed-package fixtures without changing repository configuration. */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "advisor-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Writes a minimal npm fixture and declarations for real child compilation and proxy generation. */
function installedPackage(directory, name, code) {
  const target = join(directory, "node_modules", name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  writeFileSync(join(target, "index.js"), code);
  writeFileSync(join(target, "index.d.ts"), "export function probe(): string;\n");
}

/** Returns a schema-valid mocked provider response for the real SDK/CLI integration. */
function decision(request) {
  return { model: MODEL, answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, {
    type: "choice", choice: "optional_feature", confidence: 0.9,
    probabilities: Object.fromEntries(CLASSIFICATIONS.map((key) => [key, key === "optional_feature" ? 0.97 : 0.01])),
  }])), usage: { input_tokens: 100, output_tokens: 0 } };
}

/** Compiles and closes a normal Webpack fixture build. */
function compile(config) {
  return new Promise((resolveBuild, reject) => {
    const compiler = webpack(config);
    compiler.run((error, stats) => compiler.close((closeError) => {
      if (error || closeError || stats?.hasErrors()) reject(error ?? closeError ?? new Error(stats.toString({ all: false, errors: true })));
      else resolveBuild();
    }));
  });
}

test("provider client sends bearer-authenticated SubQ System One requests and parses the pinned response without network", async (t) => {
  const input = analyzeLibrary({ name: "fixture", packages: [], issues: [], modules: [{ file: "fixture/index.js", source: "Intl;", hash: "a" }] });
  const request = buildRequests(input)[0];
  // The explicit SubQ base URL must win over SDK environment configuration.
  const previousBaseURL = process.env.TYPESAFE_BASE_URL;
  process.env.TYPESAFE_BASE_URL = "https://attacker.invalid";
  t.after(() => { if (previousBaseURL === undefined) delete process.env.TYPESAFE_BASE_URL; else process.env.TYPESAFE_BASE_URL = previousBaseURL; });
  let calls = 0;
  const client = await createProviderClient("fixture-key-never-log", async (url, init) => {
    calls += 1;
    assert.equal(String(url), `${PROVIDER_BASE_URL}/v1/systemone`);
    assert.equal(String(url), "https://api.subq.ai/v1/systemone");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-key-never-log");
    const sent = JSON.parse(init.body);
    assert.equal(sent.model, "subq-snap-1.1");
    assert.equal(sent.questions.Intl.type, "choice");
    return new Response(JSON.stringify(decision(sent)), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(validateResponse(await requestWithRetry(client, request), request).model, MODEL);
  assert.equal(calls, 1);
});

test("CLI compiles only libraries, includes aliases/transitive source, preserves workload policy and reuses offline cache", async (t) => {
  const directory = fixture(t);
  installedPackage(directory, "advisor-fixture", "exports.probe = () => require('transitive-alias').probe();");
  installedPackage(directory, "advisor-transitive", "exports.probe = () => { require('crypto'); return typeof TextEncoder; };");
  const policy = join(directory, "policy.cjs");
  writeFileSync(policy, 'module.exports={"advisor-fixture": {workloads: { sample: { entry: "missing-local-workload.js", exports: ["run"] }}}};');
  const config = join(directory, "webpack.cjs");
  writeFileSync(config, `module.exports={context:${JSON.stringify(directory)},mode:'development',entry:'./must-not-compile.js',resolve:{fallback:{crypto:false},alias:{'transitive-alias':${JSON.stringify(join(directory, "node_modules/advisor-transitive/index.js"))}}}};`);
  const options = parseArgs(["--config", policy, "--webpack-config", config, "--out-dir", join(directory, "results")]);
  let calls = 0;
  const client = { async systemOne(request) { calls += 1; return decision(request); } };
  const first = await runAdvisor(options, { client });
  assert.equal(first.incomplete, false);
  assert.deepEqual(first.report.libraries[0].issues, []);
  assert.ok(first.report.libraries[0].packages.some((entry) => entry.name === "advisor-transitive"));
  assert.equal(first.report.libraries[0].capabilities.find((entry) => entry.name === "TextEncoder").suggested, true);
  const source = readFileSync(join(first.runDirectory, "sandbox.config.suggested.js"), "utf8");
  assert.match(source, /missing-local-workload/);
  assert.equal(source.includes("fixture-key"), false);
  assert.equal(existsSync(join(directory, ".sandbox/proxys")), false);
  const previousCalls = calls;
  const offline = await runAdvisor({ ...options, offline: true }, { client });
  assert.equal(offline.incomplete, false);
  assert.equal(calls, previousCalls);
  // Developer edits affect the rendered draft, not the cached evidence classification.
  writeFileSync(policy, 'module.exports={"advisor-fixture": {permissions:["console"]}};');
  delete require.cache[require.resolve(policy)];
  const edited = await runAdvisor({ ...options, offline: true }, { client });
  assert.equal(edited.incomplete, false);
  assert.match(readFileSync(join(edited.runDirectory, "sandbox.config.suggested.js"), "utf8"), /console/);
  assert.equal(calls, previousCalls);
});

test("local host/shim source is excluded and blocks new draft authority", async (t) => {
  const directory = fixture(t);
  installedPackage(directory, "advisor-fixture", "exports.probe = () => require('shim').probe();");
  writeFileSync(join(directory, "private-shim.js"), "exports.probe=()=>Intl; // private-host-marker");
  const policy = join(directory, "policy.cjs");
  writeFileSync(policy, 'module.exports={"advisor-fixture": {}};');
  const config = join(directory, "webpack.cjs");
  writeFileSync(config, `module.exports={context:${JSON.stringify(directory)},mode:'development',resolve:{alias:{shim:${JSON.stringify(join(directory, "private-shim.js"))}}}};`);
  const result = await runAdvisor(parseArgs(["--config", policy, "--webpack-config", config, "--out-dir", join(directory, "results"), "--dry-run"]));
  const preview = readFileSync(join(result.runDirectory, "requests.json"), "utf8");
  assert.equal(preview.includes("private-host-marker"), false);
  assert.ok(result.report.libraries[0].issues.includes("local_module_excluded"));
  assert.equal(result.report.libraries[0].capabilities.some((entry) => entry.suggested), false);
});

test("omitted permissions normalize to empty, while malformed values fail", (t) => {
  const directory = fixture(t);
  installedPackage(directory, "advisor-fixture", "exports.probe=()=>1;");
  const policy = join(directory, "policy.cjs");
  for (const permissions of ["null", "'Intl'", "[1]", "['']"]) {
    writeFileSync(policy, `module.exports={'advisor-fixture':{permissions:${permissions}}};`);
    delete require.cache[require.resolve(policy)];
    assert.throws(() => loadSandboxPolicy(policy, directory), /Permissions/);
  }
  writeFileSync(policy, "module.exports={'advisor-fixture':{}};");
  delete require.cache[require.resolve(policy)];
  assert.deepEqual(loadSandboxPolicy(policy, directory)["advisor-fixture"].permissions, []);
});

test("custom compiler permissions reach real generated proxies, including an explicit empty policy", async (t) => {
  const directory = fixture(t);
  const name = `advisor-policy-${randomUUID().slice(0, 8)}`;
  installedPackage(directory, name, "exports.probe=()=>typeof Intl;");
  const policy = join(directory, "policy.cjs");
  const proxy = resolve(".sandbox/proxys", `${name}-proxy.js`);
  const bundle = resolve("dist", `${name}.bundle.js`);
  t.after(() => { rmSync(proxy, { force: true }); rmSync(bundle, { force: true }); });
  for (const permissions of [["Intl"], []]) {
    writeFileSync(policy, `module.exports=${JSON.stringify({ [name]: { permissions } })};`);
    delete require.cache[require.resolve(policy)];
    await compile({ context: directory, mode: "development", entry: {}, output: { path: resolve("dist") },
      plugins: [new WebpackSandboxPlugin({ configPath: policy })] });
    const module = await import(`${pathToFileURL(proxy).href}?policy=${permissions.length}`);
    try { assert.equal(module.probe(), permissions.length ? "object" : "undefined"); }
    finally { module.disposeLibrary(); }
  }
});

test("absent host globals are skipped without membrane conversion", () => {
  let exposed;
  const arena = {
    sync() { assert.fail("An absent host global must not be converted"); },
    expose(value) { exposed = value; },
  };
  exposeWebAPIs(arena, "fixture", ["__advisor_absent_host_global__"]);
  assert.deepEqual(exposed, {});
});

test("allowed functionality and denied host effects in real QuickJS contexts", async () => {
  const code = `var __SANDBOXED_LIB__={probe:()=>({intl:typeof Intl,fetch:typeof fetch,storage:typeof localStorage,date:typeof Date}),format:()=>new Intl.NumberFormat('en').format(1234)};`;
  const sandbox = await SandboxManager.createSandbox("luxon", code, { permissions: ["Intl"] });
  try {
    assert.equal(sandbox.exports.probe().intl, "object");
    assert.equal(sandbox.exports.probe().fetch, "undefined");
    assert.equal(sandbox.exports.probe().storage, "undefined");
    assert.equal(sandbox.exports.probe().date, "function");
    assert.equal(sandbox.exports.format(), "1,234");
  } finally { sandbox.dispose(); }
  const denied = await SandboxManager.createSandbox("luxon", code, { permissions: [] });
  try { assert.equal(denied.exports.probe().intl, "undefined"); }
  finally { denied.dispose(); }
  const legacy = await SandboxManager.createSandbox("luxon", code);
  try { assert.equal(legacy.exports.probe().intl, "object"); }
  finally { legacy.dispose(); }
  await assert.rejects(SandboxManager.createSandbox("luxon", code, { permissions: null }), /permissions/);
});
