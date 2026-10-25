import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeSource, analyzeLibrary } from "../evidence.mjs";
import { buildRequests, validateResponse, classifyRequests, requestWithRetry, STATE_LIMIT, REQUEST_LIMIT, jsonBytes } from "../requests.mjs";
import { createReport, renderDraft } from "../report.mjs";
import { MODEL, CLASSIFICATIONS } from "../catalogue.mjs";
import { parseArgs } from "../suggest.mjs";

/** Creates a complete synthetic library input with locally observable source. */
function library(code, issues = []) {
  return analyzeLibrary({ name: "fixture", packages: [{ name: "fixture", version: "1.0.0" }], issues,
    modules: [{ file: "fixture/index.js", source: code, hash: code }] });
}

/** Returns a schema-valid deterministic Choice response for transport-independent tests. */
function response(request, choice = "optional_feature", probability = 0.95) {
  return { model: MODEL, answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, {
    type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(CLASSIFICATIONS.map((key) =>
      [key, key === choice ? probability : (1 - probability) / 3])),
  }])), usage: { input_tokens: 100, output_tokens: 0 } };
}

/** Creates a disposable cache in a precisely scoped temporary directory. */
function cache(t) {
  const directory = mkdtempSync(join(tmpdir(), "capability-advisor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("scope-aware extraction ignores shadows and object property names, while retaining QuickJS built-ins", () => {
  const result = analyzeSource("function f(document, crypto) { document.createElement('x'); crypto.subtle; } const obj={fetch: 1}; Date.now(); Intl.DateTimeFormat();");
  assert.deepEqual([...new Set(result.references.map((reference) => reference.capability))], ["Intl"]);
  assert.deepEqual(result.issues, []);
});

test("static properties, aliases, destructuring and guarded legacy crypto aliases are detected", () => {
  const result = analyzeSource("const f=globalThis['fetch']; f('x'); const {crypto: c}=globalThis; c.getRandomValues(x); var cr=typeof self !== 'undefined' ? (self.crypto || self.msCrypto) : null; cr.getRandomValues(x);");
  assert.ok(result.references.some((reference) => reference.capability === "fetch"));
  assert.ok(result.references.some((reference) => reference.members[0] === "getRandomValues"));
  assert.ok(result.references.filter((reference) => reference.members[0] === "getRandomValues").length >= 2);
  assert.equal(result.references.some((reference) => ["self", "window", "globalThis"].includes(reference.capability)), false);
});

test("mutable aliases do not falsely retain their initializer capability", () => {
  const result = analyzeSource("let f=globalThis.fetch; f=localFunction; f(x);");
  assert.equal(result.references.some((reference) => reference.code === "f(x);"), false);
});

test("dynamic accesses and parse failures mark evidence incomplete", () => {
  assert.ok(analyzeSource("globalThis[key](x); self.crypto[method](x);").issues.includes("dynamic_global_access"));
  assert.ok(analyzeSource("function (").issues.includes("source_parse_error"));
  assert.ok(analyzeSource("eval('fetch(url)');").issues.includes("dynamic_code_evaluation"));
  assert.equal(analyzeSource("function f(eval) { eval(code); }").issues.includes("dynamic_code_evaluation"), false);
});

test("optional feature source and transitive module locations remain available", () => {
  const result = library("export function load(url) { return fetch(url); } export const add=(x,y)=>x+y;");
  assert.match(result.references[0].code, /function load/);
  assert.equal(result.references[0].initialization, false);
  assert.equal(result.references[0].file, "fixture/index.js");
});

test("batch input budgets are bounded and omitted source blocks new suggestions", () => {
  const analyzed = library(`function large() { ${"/*irrelevant*/".repeat(2000)} TextEncoder; }`);
  const requests = buildRequests(analyzed);
  for (const request of requests) {
    assert.ok(jsonBytes(request.state) <= STATE_LIMIT);
    assert.ok(jsonBytes(request) <= REQUEST_LIMIT);
  }
  const packet = requests.find((request) => request.state.capabilities.TextEncoder).state.capabilities.TextEncoder;
  assert.equal(packet.complete, false);
  assert.equal(packet.omitted, 1);
});

test("draft retains manual permissions and workloads; only complete supported feature needs are added", () => {
  const analyzed = library("Intl.DateTimeFormat(); fetch('x'); crypto.subtle.digest('x', data); TextEncoder;");
  const requests = buildRequests(analyzed);
  const results = requests.map((request) => ({ response: response(request) }));
  const policy = { fixture: { permissions: ["localStorage"], workloads: { test: { entry: "test.js", exports: ["run"] } } } };
  const { draft, report } = createReport(policy, [analyzed], requests, results);
  assert.deepEqual(draft.fixture.permissions, ["localStorage", "Intl", "TextEncoder"]);
  assert.deepEqual(draft.fixture.workloads, policy.fixture.workloads);
  assert.equal(report.libraries[0].capabilities.find((entry) => entry.name === "crypto").reviewReason, "crypto_member_not_exposed");
  assert.equal(policy.fixture.permissions.length, 1);
  assert.match(renderDraft(draft), /export default/);
});

test("threshold boundary is inclusive; missing evidence, analysis issues and low probability prevent additions", () => {
  for (const [probability, issues, expected] of [[0.90, [], ["Intl"]], [0.899, [], []], [0.99, ["local_module_excluded"], []]]) {
    const analyzed = library("Intl.DateTimeFormat();", issues);
    const requests = buildRequests(analyzed);
    const results = requests.map((request) => ({ response: response(request, "core_required", probability) }));
    assert.deepEqual(createReport({ fixture: { permissions: [] } }, [analyzed], requests, results).draft.fixture.permissions, expected);
  }
});

test("malformed, missing and inconsistent provider answers are rejected", () => {
  const request = buildRequests(library("Intl;"))[0];
  for (const mutate of [
    (value) => { value.model = "subq-preview"; },
    (value) => { delete value.answers.Intl; },
    (value) => { value.answers.Intl.probabilities.optional_feature = 2; },
    (value) => { value.answers.Intl.confidence = NaN; },
    (value) => { value.answers.Intl.choice = "unexpected"; },
    (value) => { value.usage.input_tokens = -1; },
  ]) {
    const value = response(request);
    mutate(value);
    assert.throws(() => validateResponse(value, request), /invalid_response/);
  }
});

test("optional SubQ confidence is recorded as null without affecting probability validation", () => {
  const request = buildRequests(library("Intl;"))[0];
  for (const mutate of [(value) => { delete value.answers.Intl.confidence; }, (value) => { value.answers.Intl.confidence = null; }]) {
    const value = response(request);
    mutate(value);
    const answer = validateResponse(value, request).answers.Intl;
    assert.equal(answer.confidence, null);
    assert.equal(answer.probabilities.optional_feature, 0.95);
  }
  const outOfRange = response(request);
  outOfRange.answers.Intl.confidence = 1.5;
  assert.throws(() => validateResponse(outOfRange, request), /invalid_response/);
});

test("transport honors attempt count, terminal authentication errors and sanitized failure messages", async () => {
  let calls = 0;
  const client = { async systemOne(_request, options) {
    calls += 1;
    assert.equal(options.retry.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
    throw Object.assign(new Error("secret-api-key-do-not-log"), { status: 529, headers: new Headers({ "retry-after": "0" }) });
  } };
  await assert.rejects(requestWithRetry(client, {}), /provider_http_529/);
  assert.equal(calls, 3);
  calls = 0;
  client.systemOne = async () => { calls += 1; throw Object.assign(new Error("secret"), { status: 401 }); };
  await assert.rejects(requestWithRetry(client, {}), /provider_http_401/);
  assert.equal(calls, 1);
});

test("Retry-After cannot extend the total deadline", async () => {
  const client = { async systemOne() { throw Object.assign(new Error("busy"), { status: 429, headers: new Headers({ "retry-after": "60" }) }); } };
  await assert.rejects(requestWithRetry(client, {}, { deadline: 50 }), /provider_deadline_exceeded/);
});

test("cache fingerprints invalidate changes; offline never contacts the provider; failures do not contain credentials", async (t) => {
  const directory = cache(t);
  const requests = buildRequests(library("Intl;"));
  let calls = 0;
  const client = { async systemOne(request) { calls += 1; return response(request); } };
  const settings = { cacheDirectory: directory, buildFingerprint: "first", client };
  const first = await classifyRequests(requests, settings);
  assert.ok(first.every((result) => result.response));
  const callCount = calls;
  const second = await classifyRequests(requests, { ...settings, offline: true });
  assert.ok(second.every((result) => result.cached));
  assert.equal(calls, callCount);
  const changed = await classifyRequests(requests, { ...settings, buildFingerprint: "changed", offline: true });
  assert.ok(changed.every((result) => result.error === "offline_cache_miss"));
  assert.equal(calls, callCount);
  const failures = await classifyRequests(requests, { ...settings, refresh: true,
    client: { async systemOne() { throw new Error("secret-api-key-do-not-log"); } } });
  assert.equal(JSON.stringify(failures).includes("secret-api-key"), false);
  for (const file of readdirSync(directory)) assert.equal(readFileSync(join(directory, file), "utf8").includes("secret-api-key"), false);
});

test("invalid offline cache fails closed", async (t) => {
  const directory = cache(t);
  const requests = buildRequests(library("Intl;"));
  await classifyRequests(requests, { cacheDirectory: directory, buildFingerprint: "a", client: { async systemOne(request) { return response(request); } } });
  for (const file of readdirSync(directory)) writeFileSync(join(directory, file), "{bad json");
  const result = await classifyRequests(requests, { cacheDirectory: directory, buildFingerprint: "a", offline: true });
  assert.ok(result.every((entry) => entry.error && !entry.response));
});

test("two workers bound request concurrency", async (t) => {
  const directory = cache(t);
  let active = 0;
  let maximum = 0;
  const requests = ["Intl;", "TextEncoder;", "TextDecoder;"].flatMap((code, index) => buildRequests({ ...library(code), name: `fixture${index}` }));
  const results = await classifyRequests(requests, { cacheDirectory: directory, buildFingerprint: "concurrency", client: {
    async systemOne(request) {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      active -= 1;
      return response(request);
    },
  } });
  assert.equal(maximum, 2);
  assert.ok(results.every((entry) => entry.response));
});

test("CLI rejects contradictory or incomplete options", () => {
  assert.throws(() => parseArgs(["--refresh", "--offline"]));
  assert.throws(() => parseArgs(["--config"]));
  assert.throws(() => parseArgs(["--unknown"]));
  assert.deepEqual(parseArgs(["--env", "mode=sandbox"]).env, { mode: "sandbox" });
});
