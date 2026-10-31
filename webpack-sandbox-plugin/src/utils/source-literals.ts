// Declaration metadata comes from the dependency being isolated, so generated
// host code must treat every name it embeds as untrusted data.

const IDENTIFIER_NAME = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Serialises a value as a JavaScript string literal that cannot terminate the
 * surrounding string, comment, or statement.
 *
 * JSON leaves U+2028 and U+2029 unescaped; they are line terminators in
 * JavaScript source and would end a `//` comment, so they are escaped too.
 *
 * @param value Untrusted text to embed.
 * @returns A double-quoted JavaScript string literal.
 */
export function toJsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .split(LINE_SEPARATOR).join("\\u2028")
    .split(PARAGRAPH_SEPARATOR).join("\\u2029");
}

/**
 * Tests whether a name can be written unquoted in an export clause.
 *
 * Reserved words are accepted because `export { x as delete }` is valid.
 *
 * @param value Candidate export name.
 * @returns Whether the value is an ECMAScript IdentifierName.
 */
export function isIdentifierName(value: string): boolean {
  return IDENTIFIER_NAME.test(value);
}

/**
 * Formats a module export name for an export clause.
 *
 * Non-identifier names use the ES2022 string form. Names containing lone
 * surrogates are rejected because a module cannot export them.
 *
 * @param value Export name reported by the dependency declarations.
 * @returns The name as an identifier or an escaped string literal.
 * @throws When the name is not well-formed Unicode.
 */
export function toModuleExportName(value: string): string {
  if (isIdentifierName(value)) {
    return value;
  }
  if (LONE_SURROGATE.test(value)) {
    throw new Error(
      `[SandboxPlugin] Refusing to generate a proxy export for malformed name ${toJsStringLiteral(value)}.`,
    );
  }
  return toJsStringLiteral(value);
}
