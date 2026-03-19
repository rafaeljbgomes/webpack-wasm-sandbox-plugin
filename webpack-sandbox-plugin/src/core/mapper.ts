import * as ts from "typescript";
import { VariantData } from "../domain/types.js";
import { toKebabCase } from "../utils/string-utils.js";

function toAlpha(num: number): string {
  let result = "";
  while (num >= 0) {
    result = String.fromCharCode(97 + (num % 26)) + result;
    num = Math.floor(num / 26) - 1;
  }
  return result;
}

export class TypeMapper {
  private checker: ts.TypeChecker;
  public generatedVariants: VariantData[] = [];
  private inlineVariantCounter = 0;

  constructor(checker: ts.TypeChecker) {
    this.checker = checker;
  }

  public map(node: ts.TypeNode | undefined): string {
    if (!node) return "void";

    if (ts.isUnionTypeNode(node)) {
      return this.mapUnion(node);
    }

    switch (node.kind) {
      case ts.SyntaxKind.StringKeyword:
        return "string";
      case ts.SyntaxKind.NumberKeyword:
        return "f64"; // Defaulting to f64
      case ts.SyntaxKind.BooleanKeyword:
        return "bool";
      case ts.SyntaxKind.VoidKeyword:
      case ts.SyntaxKind.UndefinedKeyword:
      case ts.SyntaxKind.NullKeyword:
        return "void";
      case ts.SyntaxKind.AnyKeyword:
        return "unsupported-type";
      case ts.SyntaxKind.TypeReference:
        return this.mapTypeReference(node as ts.TypeReferenceNode);
      case ts.SyntaxKind.ArrayType:
        return this.mapArrayType(node as ts.ArrayTypeNode);
      case ts.SyntaxKind.LiteralType:
        // Handle null literal
        const literal = node as ts.LiteralTypeNode;
        if (literal.literal.kind === ts.SyntaxKind.NullKeyword) return "void";
        return "unsupported-literal";
      default:
        return `unsupported-type`;
    }
  }

  public mapUnion(node: ts.UnionTypeNode): string {
    const suffix = toAlpha(this.inlineVariantCounter++);
    const name = `auto-variant-${suffix}`;

    const cases = node.types.map((t, index) => {
      const typeName = this.map(t);
      let caseName = toKebabCase(typeName);

      if (typeName === "void") caseName = "none";
      else if (caseName.includes("unsupported"))
        caseName = `case-${toAlpha(index)}`;

      // Sanitization
      caseName = caseName.replace(/[^a-z0-9-]/g, "");

      return {
        name: caseName,
        type: typeName === "void" ? undefined : typeName,
      };
    });

    this.generatedVariants.push({ name, cases });
    return name;
  }

  private mapTypeReference(node: ts.TypeReferenceNode): string {
    const typeName = node.typeName.getText();
    if (typeName === "Promise") {
      if (node.typeArguments && node.typeArguments.length > 0) {
        return this.map(node.typeArguments[0]);
      }
      return "void";
    }
    if (typeName === "Uint8Array") return "list<u8>";
    return toKebabCase(typeName);
  }

  private mapArrayType(node: ts.ArrayTypeNode): string {
    const elementType = this.map(node.elementType);
    return `list<${elementType}>`;
  }
}
