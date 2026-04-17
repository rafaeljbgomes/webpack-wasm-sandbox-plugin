export interface LibraryData {
  exportedNames: string[];
  /** Set when the library uses `export = identifier` (e.g. lodash). The value
   *  is the identifier name (e.g. `"_"`). When present, exportedNames contains
   *  only TypeScript type-level names from the namespace and must not be used
   *  to generate individual proxy exports. */
  callableSingletonExport?: string;
}
