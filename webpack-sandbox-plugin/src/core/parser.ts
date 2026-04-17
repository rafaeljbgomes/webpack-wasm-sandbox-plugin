import * as ts from "typescript";
import * as path from "path";
import { LibraryData } from "../domain/types";

export class Parser {
  private program: ts.Program;

  constructor(filePaths: string[]) {
    this.program = ts.createProgram(filePaths, {});
  }

  public parse(): LibraryData {
    const libraryData: LibraryData = {
      exportedNames: [],
    };

    const allowedFiles = new Set(
      this.program.getRootFileNames().map((f) => path.resolve(f).toLowerCase()),
    );

    const checker = this.program.getTypeChecker();

    for (const sourceFile of this.program.getSourceFiles()) {
      const resolvedPath = path.resolve(sourceFile.fileName).toLowerCase();
      if (allowedFiles.has(resolvedPath)) {
        this.checkSingletonExport(sourceFile, libraryData);

        const symbol = checker.getSymbolAtLocation(sourceFile);
        if (symbol) {
          const exports = checker.getExportsOfModule(symbol);
          for (const exp of exports) {
            libraryData.exportedNames.push(exp.name);
          }
        }
      }
    }

    // For `export = identifier` libraries (e.g. lodash), checker.getExportsOfModule()
    // returns TypeScript type-level names from the namespace declaration — not runtime
    // values. Clear them so the proxy generator doesn't emit stubs for names that
    // don't exist at runtime.
    if (libraryData.callableSingletonExport) {
      libraryData.exportedNames = [];
    }

    return libraryData;
  }

  private checkSingletonExport(node: ts.Node, data: LibraryData) {
    if (ts.isExportAssignment(node) && node.isExportEquals && ts.isIdentifier(node.expression)) {
      // `export = identifier` — CJS-style re-export (e.g. `export = _` in lodash).
      // Use first-wins: index.d.ts is visited before per-function files (e.g. zipWith.d.ts),
      // so the first assignment captures the library's main export identifier.
      if (!data.callableSingletonExport) {
        data.callableSingletonExport = node.expression.text;
      }
    }

    ts.forEachChild(node, (child) => this.checkSingletonExport(child, data));
  }
}
