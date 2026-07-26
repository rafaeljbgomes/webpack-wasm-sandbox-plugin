/** Runtime export information used to generate a dependency proxy. */
export interface LibraryData {
  /** Named values that exist on the dependency at runtime. */
  exportedNames: string[];
  /**
   * Identifier assigned through `export =`, when the dependency exposes one
   * callable singleton instead of independent named runtime exports.
   */
  callableSingletonExport?: string;
}
