import * as ts from "typescript";
import * as path from "path";
import { LibraryData } from "../domain/types";

/** Extracts runtime-relevant export names from TypeScript declarations. */
export class Parser {
  private program: ts.Program;

  /**
   * Creates a declaration program for the files belonging to one dependency.
   *
   * @param filePaths Declaration files to inspect.
   */
  constructor(filePaths: string[]) {
    this.program = ts.createProgram(filePaths, {});
  }

  /**
   * Collects the dependency exports required by proxy generation.
   *
   * @returns Runtime-relevant export metadata.
   */
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

    // For `export =` libraries, TypeScript reports namespace type members that
    // do not exist as independent runtime exports.
    if (libraryData.callableSingletonExport) {
      libraryData.exportedNames = [];
    }

    return libraryData;
  }

  /**
   * Finds the first CommonJS-style `export = identifier` assignment in a
   * declaration tree.
   *
   * @param node Declaration node to inspect recursively.
   * @param data Export metadata updated when an assignment is found.
   */
  private checkSingletonExport(node: ts.Node, data: LibraryData) {
    if (ts.isExportAssignment(node) && node.isExportEquals && ts.isIdentifier(node.expression)) {
      // Root declarations are visited before supporting declaration files, so
      // first-wins selects the package's primary assignment.
      if (!data.callableSingletonExport) {
        data.callableSingletonExport = node.expression.text;
      }
    }

    ts.forEachChild(node, (child) => this.checkSingletonExport(child, data));
  }
}
