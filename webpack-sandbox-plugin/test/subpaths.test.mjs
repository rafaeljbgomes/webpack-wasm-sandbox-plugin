import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import webpack from "webpack";
import pluginModule from "../src/plugin.ts";
import helpersModule from "../src/build-helpers.ts";

const { WebpackSandboxPlugin } = pluginModule;
const { loadSandboxPolicy } = helpersModule;

const sandboxManagerUrl = pathToFileURL(
  fileURLToPath(new URL("../../.sandbox/core/sandbox-manager.js", import.meta.url)),
).href;

/** Writes a package into the project's `node_modules`. */
function writePackage(root, name, files, manifest = {}) {
  const directory = path.join(root, "node_modules", name);
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), source);
  }
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js", ...manifest }),
  );
}

/**
 * A package whose root and subpaths share a module (`shared.js`) with state
 * and a class. If the root and a subpath ran in different module registries
 * or contexts, `instanceof` would fail and the counter would not be shared.
 */
function writeSubLib(root) {
  writePackage(root, "sub-lib", {
    "shared.js": [
      "let calls = 0;",
      "exports.bump = () => ++calls;",
      "exports.count = () => calls;",
      "class Locale { constructor(name) { this.name = name; } }",
      "exports.Locale = Locale;",
      "",
    ].join("\n"),
    "index.js": [
      "const shared = require('./shared.js');",
      "exports.format = (value, locale) => (locale instanceof shared.Locale ? locale.name : 'foreign') + ':' + value + ':' + shared.bump();",
      "exports.count = shared.count;",
      "",
    ].join("\n"),
    "index.d.ts": [
      "export declare function format(value: string, locale: object): string;",
      "export declare function count(): number;",
      "",
    ].join("\n"),
    "locale.js": [
      "const shared = require('./shared.js');",
      "exports.en = new shared.Locale('en');",
      "exports.Locale = shared.Locale;",
      "exports.bump = shared.bump;",
      "",
    ].join("\n"),
    "locale.d.ts": [
      "export declare class Locale { constructor(name: string); name: string }",
      "export declare const en: Locale;",
      "export declare function bump(): number;",
      "",
    ].join("\n"),
    // Like lodash/get.js: a CommonJS function whose types live in @types.
    "fn.js": "module.exports = (a) => a * 2;\n",
    // No declarations anywhere: the proxy offers the module value as default.
    "raw.js": "module.exports = { k: 1, twice: (a) => a * 2 };\n",
  }, {
    exports: {
      ".": { types: "./index.d.ts", default: "./index.js" },
      "./locale": { types: "./locale.d.ts", default: "./locale.js" },
      "./fn": "./fn.js",
      "./raw": "./raw.js",
      "./other": "./shared.js",
    },
  });
  writePackage(root, "@types/sub-lib", {
    "fn.d.ts": "declare function twice(a: number): number;\nexport = twice;\n",
  });
}

function writeProject(root) {
  writeSubLib(root);
  // A sandboxed library that itself imports a sandboxed package's subpath:
  // inside its sandbox it must get the real package, never a host proxy.
  writePackage(root, "uses-sub", {
    "index.js": "const { en } = require('sub-lib/locale');\nexports.localeName = () => en.name;\n",
    "index.d.ts": "export declare function localeName(): string;\n",
  });
  // Escaping: the policy names `lib.dot`; `libXdot` must not match it.
  writePackage(root, "lib.dot", { "index.js": "exports.who = () => 'lib.dot';\n", "index.d.ts": "export declare function who(): string;\n" });
  writePackage(root, "libXdot", { "index.js": "exports.who = () => 'libXdot';\n" });

  fs.writeFileSync(path.join(root, "sandbox.config.cjs"), `module.exports = {
  "sub-lib": { permissions: [], subpaths: ["locale", "./fn", "raw"] },
  "uses-sub": { permissions: [] },
  "lib.dot": { permissions: [] },
};
`);
  fs.writeFileSync(path.join(root, "entry.js"), [
    'import { format } from "sub-lib";',
    'import { en } from "sub-lib/locale";',
    'import twice from "sub-lib/fn";',
    'import raw from "sub-lib/raw";',
    'import { localeName } from "uses-sub";',
    'import { who } from "lib.dot";',
    'import { who as whoX } from "libXdot";',
    "export const value = [format, en, twice, raw, localeName, who, whoX];",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(root, ".sandbox", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, ".sandbox", "core", "sandbox-manager.js"), `export * from ${JSON.stringify(sandboxManagerUrl)};\n`);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
}

function compileProject(root, entry = "entry.js") {
  return new Promise((resolve, reject) => {
    webpack({
      context: root,
      entry: path.join(root, entry),
      mode: "development",
      devtool: false,
      output: { path: path.join(root, "dist"), filename: "bundle.js" },
      resolve: { fallback: { fs: false, path: false, url: false } },
      externals: { "../core/sandbox-manager.js": "commonjs ../core/sandbox-manager.js" },
      plugins: [
        new WebpackSandboxPlugin({
          configPath: "sandbox.config.cjs",
          proxyDirectory: path.join(root, ".sandbox", "proxys"),
          classification: { trusted: ["libXdot"] },
        }),
      ],
    }, (error, stats) => {
      if (error) reject(error);
      else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })));
      else resolve(stats);
    });
  });
}

const importProxy = (file) => import(pathToFileURL(path.join(root, ".sandbox", "proxys", file)).href);

let root;
let hostModules;
let childModules;
let rootProxy;

before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-subpaths-test-")));
  writeProject(root);
  const previous = process.cwd();
  process.chdir(root);
  let compiled;
  try {
    compiled = await compileProject(root);
  } finally {
    process.chdir(previous);
  }
  const stats = compiled.toJson({ all: false, modules: true, children: true });
  hostModules = stats.modules.map((module) => module.name).filter(Boolean);
  childModules = Object.fromEntries(
    stats.children.map((child) => [child.name, child.modules.map((module) => module.name)]),
  );
});

after(() => {
  rootProxy?.disposeLibrary();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

test("redirects declared subpaths to proxies; no package code runs on the host", () => {
  for (const proxy of ["sub-lib-proxy.js", "sub-lib--locale-proxy.js", "sub-lib--fn-proxy.js", "sub-lib--raw-proxy.js"]) {
    assert.ok(hostModules.includes(`./.sandbox/proxys/${proxy}`), proxy);
  }
  assert.equal(hostModules.some((name) => name.startsWith("./node_modules/sub-lib/")), false);
});

test("the root and its subpaths share one bundle with one copy of each module", () => {
  const modules = childModules["SandboxCompiler-sub-lib"];
  for (const file of ["index.js", "locale.js", "fn.js", "raw.js", "shared.js"]) {
    assert.equal(modules.filter((name) => name === `./node_modules/sub-lib/${file}`).length, 1, file);
  }
  assert.ok(fs.existsSync(path.join(root, "dist", "sub-lib.bundle.js")));
  for (const subpath of ["locale", "fn", "raw"]) {
    assert.equal(fs.existsSync(path.join(root, "dist", `sub-lib.${subpath}.bundle.js`)), false);
  }
});

test("objects passed from a subpath back into the root stay in the sandbox", async () => {
  rootProxy = await importProxy("sub-lib-proxy.js");
  const locale = await importProxy("sub-lib--locale-proxy.js");
  // instanceof holds only if `en` reaches the root as the same QuickJS object.
  assert.equal(rootProxy.format("x", locale.en), "en:x:1");
  // Module state is shared between the root and the subpath.
  assert.equal(locale.bump(), 2);
  assert.equal(rootProxy.count(), 2);
});

test("classes exported by a subpath are constructed inside the same sandbox", async () => {
  rootProxy ??= await importProxy("sub-lib-proxy.js");
  const { Locale } = await importProxy("sub-lib--locale-proxy.js");
  const pt = new Locale("pt");
  assert.equal(pt.name, "pt");
  assert.match(rootProxy.format("y", pt), /^pt:y:\d+$/);
});

test("a callable `export =` subpath typed through @types is callable", async () => {
  const { default: twice } = await importProxy("sub-lib--fn-proxy.js");
  assert.equal(twice(21), 42);
});

test("a subpath without declarations is offered as its default export", async () => {
  const source = fs.readFileSync(path.join(root, ".sandbox", "proxys", "sub-lib--raw-proxy.js"), "utf8");
  assert.match(source, /export default/);
  const { default: raw } = await importProxy("sub-lib--raw-proxy.js");
  assert.equal(raw.k, 1);
  assert.equal(raw.twice(4), 8);
});

test("inside a sandbox, imports of another sandboxed package resolve to the real package", () => {
  const modules = childModules["SandboxCompiler-uses-sub"];
  assert.ok(modules.includes("./node_modules/sub-lib/locale.js"));
  assert.equal(modules.some((name) => name.includes(".sandbox/proxys")), false);
});

test("library names are matched literally: `lib.dot` does not capture `libXdot`", () => {
  assert.ok(hostModules.includes("./.sandbox/proxys/lib.dot-proxy.js"));
  // Before escaping, /^lib.dot$/ also matched "libXdot" and replaced it with lib.dot's proxy.
  assert.ok(hostModules.includes("./node_modules/libXdot/index.js"));
});

test("an undeclared subpath still fails the build (classify-or-fail)", async () => {
  fs.writeFileSync(path.join(root, "entry-undeclared.js"), 'import shared from "sub-lib/other";\nexport default shared;\n');
  const previous = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(compileProject(root, "entry-undeclared.js"), /sub-lib/);
  } finally {
    process.chdir(previous);
  }
});

test("policy validation rejects unsafe subpaths and writable paths for ungranted APIs", (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-subpath-policy-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writePackage(dir, "p", { "index.js": "" });
  const load = (entry, name) => {
    const file = path.join(dir, `${name}.cjs`);
    fs.writeFileSync(file, `module.exports = ${JSON.stringify({ p: entry })};\n`);
    return () => loadSandboxPolicy(file, dir);
  };
  assert.throws(load({ subpaths: ["../escape"] }, "a"), /relative path inside the package/);
  assert.throws(load({ subpaths: ["/abs"] }, "b"), /relative path inside the package/);
  assert.throws(load({ subpaths: ["a/b", "a_b"] }, "c"), /duplicates/);
  assert.throws(load({ subpaths: [""] }, "d"), /nonempty strings/);
  assert.throws(load({ permissions: [], writable: { Cfg: ["x"] } }, "e"), /not in its permissions/);
  assert.throws(load({ permissions: ["Cfg"], writable: { Cfg: ["a..b"] } }, "f"), /dotted property paths/);
  assert.deepEqual(load({ permissions: ["Cfg"], subpaths: ["./locale"], writable: { Cfg: ["x.y"] } }, "g")().p, {
    permissions: ["Cfg"], subpaths: ["locale"], writable: { Cfg: ["x.y"] },
  });
});
