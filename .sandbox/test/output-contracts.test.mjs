import assert from "node:assert/strict";
import test from "node:test";
import { compileContract, withOutputContracts, SandboxOutputError } from "../core/output-contracts.js";

const strip = { default: { sanitize: (s) => s.replace(/<img[^>]*>/g, "") } };

test("html contract sanitizes the result of a declared method", () => {
  const lib = function marked(s) { return `<p>${s}</p><img src=x onerror=alert(1)>`; };
  lib.parse = (s) => `<p>${s}</p><img src=x onerror=alert(1)>`;
  lib.version = "1";
  const enforcers = {
    "marked.parse": compileContract("marked.parse", { type: "html" }, { sanitizer: strip }),
  };
  const view = withOutputContracts("marked", lib, enforcers);
  assert.equal(view.parse("a"), "<p>a</p>");
  assert.equal(view.parse, view.parse, "stable identity for repeated reads");
  assert.equal(view("a"), "<p>a</p><img src=x onerror=alert(1)>", "undeclared path is not checked");
  assert.equal(view.version, "1");
});

test("contracts on promise results apply when they settle", async () => {
  const enforcers = { "default": compileContract("default", { type: "html" }, { sanitizer: strip }) };
  const view = withOutputContracts("default", async () => "<b>x</b><img>", enforcers);
  assert.equal(await view(), "<b>x</b>");
});

test("structural contracts fail closed", () => {
  const e = (c, mods) => compileContract("p", c, mods);
  assert.throws(() => e({ type: "html" }, { sanitizer: strip })({}), SandboxOutputError);
  assert.throws(() => e({ type: "string", pattern: "^[a-z]+/[a-z0-9.+-]+$" })("text/html; x"), SandboxOutputError);
  assert.equal(e({ type: "string", pattern: "^[a-z]+/[a-z0-9.+-]+$" })("text/html"), "text/html");
  assert.throws(() => e({ type: "boolean" })("true"), SandboxOutputError);
  assert.throws(() => e({ type: "bytes", length: 64 })(new Uint8Array(63)), SandboxOutputError);
  assert.throws(() => e({ type: "bytes", length: 64 })([0]), SandboxOutputError);
  const sig = e({ type: "bytes", length: 2 }, { check: { default: (v, args) => v[0] === args[0] } });
  assert.deepEqual(sig(new Uint8Array([7, 0]), [7]), new Uint8Array([7, 0]));
  assert.throws(() => sig(new Uint8Array([8, 0]), [7]), /host check rejected/);
});

test("nested and default paths, and exports without contracts", () => {
  const lib = { sign: Object.assign(() => new Uint8Array(3), { detached: () => new Uint8Array(64) }) };
  const enforcers = { "nacl.sign.detached": compileContract("nacl.sign.detached", { type: "bytes", length: 64 }) };
  const view = withOutputContracts("nacl", lib, enforcers);
  assert.equal(view.sign.detached().length, 64);
  assert.equal(view.sign().length, 3);
  assert.equal(withOutputContracts("other", lib, enforcers), lib);
});
