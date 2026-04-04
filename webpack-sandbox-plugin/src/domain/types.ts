export interface FuncData {
  name: string;
  params: ParamData[];
  returnType: string;
  isDefaultExport?: boolean;
}

export interface ParamData {
  name: string;
  type: string;
}

export interface InterfaceData {
  name: string;
  fields: FieldData[];
  parentNames?: string[]; // For 'extends'
}

export interface FieldData {
  name: string;
  type: string;
}

export interface ClassData {
  name: string;
  methods: FuncData[];
  constructorParams: ParamData[];
  parentNames?: string[]; // For 'extends' or 'implements'
}

export interface TypeAliasData {
  name: string;
  targetType: string;
}

export interface EnumData {
  name: string;
  cases: string[];
}

export interface VariantData {
  name: string;
  cases: {
    name: string; // Case name (e.g., "str", "num")
    type?: string; // Payload type (e.g., "string", "u32") - optional for unit variants
  }[];
}

export interface LibraryData {
  functions: FuncData[];
  interfaces: InterfaceData[];
  classes: ClassData[];
  enums: EnumData[];
  variants: VariantData[];
  typeAliases: TypeAliasData[];
  exportedNames: string[];
  /** Set when the library uses `export = identifier` (e.g. lodash). The value
   *  is the identifier name (e.g. `"_"`). When present, exportedNames contains
   *  only TypeScript type-level names from the namespace and must not be used
   *  to generate individual proxy exports. */
  callableSingletonExport?: string;
}
