import * as ts from "typescript";
import * as path from "path";
import { TypeMapper } from "./mapper.js";
import {
  LibraryData,
  FuncData,
  ClassData,
  InterfaceData,
  EnumData,
  VariantData,
  TypeAliasData,
  ParamData,
  FieldData,
} from "../domain/types.js";

function toAlpha(num: number): string {
  let result = "";
  while (num >= 0) {
    result = String.fromCharCode(97 + (num % 26)) + result;
    num = Math.floor(num / 26) - 1;
  }
  return result;
}

export class Parser {
  private program: ts.Program;
  private mapper: TypeMapper;

  constructor(filePaths: string[]) {
    this.program = ts.createProgram(filePaths, {});
    this.mapper = new TypeMapper(this.program.getTypeChecker());
  }

  public parse(): LibraryData {
    const libraryData: LibraryData = {
      functions: [],
      interfaces: [],
      classes: [],
      enums: [],
      variants: [],
      typeAliases: [],
      exportedNames: [],
    };

    const allowedFiles = new Set(
      this.program.getRootFileNames().map((f) => path.resolve(f).toLowerCase()),
    );

    const checker = this.program.getTypeChecker();

    for (const sourceFile of this.program.getSourceFiles()) {
      const resolvedPath = path.resolve(sourceFile.fileName).toLowerCase();
      if (allowedFiles.has(resolvedPath)) {
        this.visit(sourceFile, libraryData);

        const symbol = checker.getSymbolAtLocation(sourceFile);
        if (symbol) {
          const exports = checker.getExportsOfModule(symbol);
          for (const exp of exports) {
             libraryData.exportedNames.push(exp.name);
          }
        }
      }
    }

    if (this.mapper.generatedVariants) {
      libraryData.variants.push(...this.mapper.generatedVariants);
    }

    // Resolve Inheritance (Flattening)
    this.resolveHeritage(libraryData);

    return libraryData;
  }

  private resolveHeritage(data: LibraryData) {
    // 1. Resolve Interfaces
    // Simple multi-pass or just one pass if ordered?
    // Let's do a simple iterative pass until no changes, or just one pass assuming simple hierarchy?
    // For now, let's do a single pass but iterating efficiently.
    // actually, just look up parent. If parent has fields, add them.
    // NOTE: This assumes parents are in the same library or we can't find them.

    const interfaceMap = new Map<string, InterfaceData>();
    data.interfaces.forEach((i) => interfaceMap.set(i.name, i));

    data.interfaces.forEach((iface) => {
      if (iface.parentNames) {
        iface.parentNames.forEach((pName) => {
          const parent = interfaceMap.get(pName);
          if (parent) {
            // Merge fields: Child fields override parent fields? Or just add missing?
            // Usually parent fields come first or strictly aggregate.
            // Let's prepend parent fields to child fields.
            // Filter out duplicates if any (child overrides).
            const childFieldNames = new Set(iface.fields.map((f) => f.name));
            const inheritedFields = parent.fields.filter(
              (f) => !childFieldNames.has(f.name),
            );
            iface.fields = [...inheritedFields, ...iface.fields];
          }
        });
      }
    });

    // 2. Resolve Classes
    // Classes can extend Classes or implement Interfaces.

    const classMap = new Map<string, ClassData>();
    data.classes.forEach((c) => classMap.set(c.name, c));

    data.classes.forEach((cls) => {
      if (cls.parentNames) {
        cls.parentNames.forEach((pName) => {
          // Try finding class first
          const parentClass = classMap.get(pName);
          if (parentClass) {
            // Inherit methods & params
            // Constructor params: usually super() is called.
            // For WIT resource, we probably just want the methods.
            const childMethodNames = new Set(cls.methods.map((m) => m.name));
            const inheritedMethods = parentClass.methods.filter(
              (m) => !childMethodNames.has(m.name),
            );
            cls.methods = [...inheritedMethods, ...cls.methods];
            return;
          }

          // Try finding interface (implements)
          const parentInterface = interfaceMap.get(pName);
          if (parentInterface) {
            // Interface methods?
            // Wait, InterfaceData only has fields (Record).
            // Typescript interfaces can have methods.
            // Our extractInterface currently only maps PropertySignatures as fields.
            // If the interface has methods, we missed them in `extractInterface`.
            // But purely for data structures, we might inherit fields?
            // WIT resources doesn't really "implement" a record.
            // So for now, we only support Class-to-Class inheritance for methods.
          }
        });
      }
    });
  }

  private visit(node: ts.Node, data: LibraryData) {
    if (ts.isFunctionDeclaration(node) && this.isExported(node)) {
      const func = this.extractFunction(node);
      if (this.isDefault(node)) {
        func.isDefaultExport = true;
        if (!node.name) func.name = "default";
      }
      data.functions.push(func);
    } else if (ts.isInterfaceDeclaration(node) && this.isExported(node)) {
      data.interfaces.push(this.extractInterface(node));
    } else if (ts.isClassDeclaration(node) && this.isExported(node)) {
      data.classes.push(this.extractClass(node));
    } else if (ts.isEnumDeclaration(node) && this.isExported(node)) {
      data.enums.push(this.extractEnum(node));
    } else if (ts.isTypeAliasDeclaration(node) && this.isExported(node)) {
      if (ts.isUnionTypeNode(node.type)) {
        data.variants.push(this.extractVariant(node.name.text, node.type));
      } else {
        data.typeAliases.push(this.extractTypeAlias(node));
      }
    } else if (ts.isExportAssignment(node)) {
      // Limitation: We only try to handle identifiers or generic default export logic
    }

    ts.forEachChild(node, (child) => this.visit(child, data));
  }

  private extractFunction(node: ts.FunctionDeclaration): FuncData {
    const name = node.name?.text || "anonymous";
    const params = node.parameters.map((p) => ({
      name: p.name.getText(),
      type: this.mapper.map(p.type),
    }));
    const returnType = this.mapper.map(node.type);

    return { name, params, returnType };
  }

  private extractInterface(node: ts.InterfaceDeclaration): InterfaceData {
    const name = node.name.text;
    const parentNames = this.extractParentNames(node);

    // We strictly extract properties (fields) for now.
    // If we want methods, we need InterfaceData to support them.
    const fields: FieldData[] = node.members
      .filter(ts.isPropertySignature)
      .map((m) => ({
        name: m.name.getText(),
        type: this.mapper.map(m.type),
      }));

    return { name, fields, parentNames };
  }

  private extractClass(node: ts.ClassDeclaration): ClassData {
    const name = node.name?.text || "AnonymousClass";
    const parentNames = this.extractParentNames(node);

    const methods: FuncData[] = [];
    let constructorParams: ParamData[] = [];

    node.members.forEach((m) => {
      if (ts.isMethodDeclaration(m) && this.isPublic(m)) {
        methods.push({
          name: m.name.getText(),
          params: m.parameters.map((p) => ({
            name: p.name.getText(),
            type: this.mapper.map(p.type),
          })),
          returnType: this.mapper.map(m.type),
        });
      } else if (ts.isConstructorDeclaration(m)) {
        constructorParams = m.parameters.map((p) => ({
          name: p.name.getText(),
          type: this.mapper.map(p.type),
        }));
      }
    });

    return { name, methods, constructorParams, parentNames };
  }

  private extractParentNames(
    node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  ): string[] {
    if (!node.heritageClauses) return [];

    const names: string[] = [];
    node.heritageClauses.forEach((clause) => {
      clause.types.forEach((typeExpr) => {
        const expr = typeExpr.expression;
        if (ts.isIdentifier(expr)) {
          names.push(expr.text);
        }
      });
    });
    return names;
  }

  private extractEnum(node: ts.EnumDeclaration): EnumData {
    return {
      name: node.name.text,
      cases: node.members.map((m) => {
        if (ts.isEnumMember(m)) {
          return m.name.getText();
        }
        return "unknown";
      }),
    };
  }

  private extractVariant(name: string, node: ts.UnionTypeNode): VariantData {
    const cases = node.types.map((t, index) => {
      const typeName = this.mapper.map(t);
      let caseName = typeName;

      if (typeName === "void") caseName = "none";
      else if (caseName.includes("unsupported"))
        caseName = `case-${toAlpha(index)}`;

      caseName = caseName.replace(/[^a-z0-9-]/g, "");
      if (/^[0-9]/.test(caseName)) caseName = `v${caseName}`;

      return {
        name: caseName,
        type: typeName === "void" ? undefined : typeName,
      };
    });
    return { name, cases };
  }

  private extractTypeAlias(node: ts.TypeAliasDeclaration): TypeAliasData {
    return {
      name: node.name.text,
      targetType: this.mapper.map(node.type),
    };
  }

  private isExported(node: ts.Declaration): boolean {
    return (
      (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0 ||
      (!!node.parent && node.parent.kind === ts.SyntaxKind.SourceFile)
    );
  }

  private isDefault(node: ts.Declaration): boolean {
    return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Default) !== 0;
  }

  private isPublic(node: ts.Declaration): boolean {
    const flags = ts.getCombinedModifierFlags(node);
    return !(
      flags & ts.ModifierFlags.Private || flags & ts.ModifierFlags.Protected
    );
  }
}
