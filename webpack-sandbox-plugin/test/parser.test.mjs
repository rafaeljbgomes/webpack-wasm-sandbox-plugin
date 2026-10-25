import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import parserModule from "../src/core/parser.ts";

const { Parser } = parserModule;

/**
 * Writes declaration fixtures into a temporary directory and parses them.
 *
 * The parser runs with the fixture directory as working directory. TypeScript
 * otherwise loads every `@types` package visible from the repository root,
 * which takes over a second per program and adds nothing to the root files.
 * Each test file runs in its own process, so the change stays local.
 *
 * @param {import("node:test").TestContext} t Owning test context.
 * @param {Record<string, string>} files Declaration sources keyed by file name.
 * @param {string[]} [roots] Files passed to the parser, in order; defaults to every fixture.
 * @returns {import("../src/domain/types.ts").LibraryData} Parsed export metadata.
 */
function parseDeclarations(t, files, roots = Object.keys(files)) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-parser-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), source);
  }
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return new Parser(roots.map((name) => path.join(directory, name))).parse();
  } finally {
    process.chdir(previous);
  }
}

test("reports named value exports in declaration order", (t) => {
  const data = parseDeclarations(t, {
    "index.d.ts": [
      "export declare function add(a: number, b: number): number;",
      "export declare class Counter { increment(): number; }",
      "export declare const VERSION: string;",
    ].join("\n"),
  });

  assert.deepEqual(data, { exportedNames: ["add", "Counter", "VERSION"] });
});

test("reports a default export alongside the named class", (t) => {
  // The mime layout behind ADR 12: a singleton default and the class that constructs it.
  const data = parseDeclarations(t, {
    "index.d.ts": [
      "declare const mime: { getType(path: string): string | null };",
      "export default mime;",
      "export declare class Mime { getType(path: string): string | null; }",
    ].join("\n"),
  });

  assert.deepEqual(data.exportedNames, ["default", "Mime"]);
  assert.equal(data.callableSingletonExport, undefined);
});

test("reports a name once per declaration file that exports it", (t) => {
  // Re-exports make one runtime export appear in several roots; the generator removes duplicates.
  const data = parseDeclarations(t, {
    "index.d.ts": "export * from './other';\nexport declare function add(a: number, b: number): number;\n",
    "other.d.ts": "export declare function sub(a: number, b: number): number;\n",
  });

  assert.deepEqual([...data.exportedNames].sort(), ["add", "sub", "sub"]);
});

test("reports overloaded declarations once", (t) => {
  const data = parseDeclarations(t, {
    "index.d.ts": "export declare function add(a: number): number;\nexport declare function add(a: string): string;\n",
  });

  assert.deepEqual(data.exportedNames, ["add"]);
});

test("reports reserved-word export names unchanged", (t) => {
  const data = parseDeclarations(t, {
    "index.d.ts": [
      "declare function _delete(key: string): boolean;",
      "export { _delete as delete };",
      "export declare function get(key: string): unknown;",
    ].join("\n"),
  });

  assert.deepEqual([...data.exportedNames].sort(), ["delete", "get"]);
});

test("records export = as a callable singleton without namespace members", (t) => {
  const data = parseDeclarations(t, {
    "index.d.ts": [
      "declare function double(x: number): number;",
      "declare namespace double { const version: string; function triple(x: number): number; }",
      "export = double;",
    ].join("\n"),
  });

  assert.deepEqual(data, { exportedNames: [], callableSingletonExport: "double" });
});

test("keeps the export = assignment of the first root file", (t) => {
  const files = {
    "a.d.ts": "declare function first(): void;\nexport = first;\n",
    "b.d.ts": "declare function second(): void;\nexport = second;\n",
  };

  assert.equal(parseDeclarations(t, files, ["a.d.ts", "b.d.ts"]).callableSingletonExport, "first");
  assert.equal(parseDeclarations(t, files, ["b.d.ts", "a.d.ts"]).callableSingletonExport, "second");
});

test("ignores exports of declaration files that are only imported", (t) => {
  const data = parseDeclarations(
    t,
    {
      "index.d.ts": "import { Hidden } from './internal';\nexport declare function make(): Hidden;\n",
      "internal.d.ts": "export declare class Hidden {}\nexport declare const secret: number;\n",
    },
    ["index.d.ts"],
  );

  assert.deepEqual(data.exportedNames, ["make"]);
});

test("reports no exports for a global script declaration", (t) => {
  const data = parseDeclarations(t, { "index.d.ts": "declare function globalOnly(): void;\n" });

  assert.deepEqual(data, { exportedNames: [] });
});

test(
  "omits type-only exports",
  { todo: "interfaces and type aliases are reported as runtime exports, so the proxy exports undefined bindings and the default fallback can pick a type name (spec §4)" },
  (t) => {
    const data = parseDeclarations(t, {
      "index.d.ts": [
        "export interface Options { strict: boolean }",
        "export type Mode = 'a' | 'b';",
        "export declare function run(options: Options): Mode;",
      ].join("\n"),
    });

    assert.deepEqual(data.exportedNames, ["run"]);
  },
);
