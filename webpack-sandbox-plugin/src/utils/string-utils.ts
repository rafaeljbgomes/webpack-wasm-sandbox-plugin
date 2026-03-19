export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function toCamelCase(str: string): string {
  return str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
}

const WIT_KEYWORDS = new Set([
  "u8",
  "u16",
  "u32",
  "u64",
  "s8",
  "s16",
  "s32",
  "s64",
  "float32",
  "float64",
  "char",
  "bool",
  "string",
  "tuple",
  "list",
  "option",
  "result",
  "record",
  "variant",
  "enum",
  "resource",
  "flags",
  "func",
  "interface",
  "world",
  "package",
  "import",
  "export",
  "include",
  "use",
  "type",
  "borrow",
  "own",
  "default",
]);

export function escapeWitKeyword(str: string): string {
  if (WIT_KEYWORDS.has(str)) {
    return `%${str}`;
  }
  return str;
}
