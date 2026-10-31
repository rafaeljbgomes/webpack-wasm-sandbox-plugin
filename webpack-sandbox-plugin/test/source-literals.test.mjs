import assert from "node:assert/strict";
import test from "node:test";
import literalsModule from "../src/utils/source-literals.ts";

const { isIdentifierName, toJsStringLiteral, toModuleExportName } = literalsModule;

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

test("string literals round-trip quotes, backslashes and line terminators", () => {
  const value = `a"b\\c\nd\re${LINE_SEPARATOR}f${PARAGRAPH_SEPARATOR}g`;
  const literal = toJsStringLiteral(value);

  assert.equal(new Function(`return ${literal};`)(), value);
  // A raw separator would end a `//` comment in the generated module.
  assert.equal(/[\n\r\u2028\u2029]/.test(literal), false);
});

test("identifier names include reserved words and Unicode identifiers", () => {
  for (const name of ["add", "delete", "$", "_private", "café", "a\u200Cb"]) {
    assert.equal(isIdentifierName(name), true, name);
  }
  for (const name of ["", "a-b", "1st", "a b", 'x"]; y']) {
    assert.equal(isIdentifierName(name), false, name);
  }
});

test("non-identifier export names use the escaped string form", () => {
  assert.equal(toModuleExportName("delete"), "delete");
  assert.equal(toModuleExportName("a-b"), '"a-b"');
  assert.equal(toModuleExportName('x"; y'), '"x\\"; y"');
});

test("export names with lone surrogates fail closed", () => {
  assert.throws(() => toModuleExportName("x\uD800"), /malformed name/);
  assert.equal(toModuleExportName("x\uD83D\uDE00"), '"x\uD83D\uDE00"');
});
