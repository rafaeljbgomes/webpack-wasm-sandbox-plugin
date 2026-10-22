import ts from "typescript";
import { createHash } from "node:crypto";
import { CATALOGUE } from "./catalogue.mjs";

const roots = new Set(["globalThis", "self", "window"]);
const names = new Map(CATALOGUE.flatMap((entry) => [entry.name, ...entry.aliases].map((name) => [name, entry.name])));

/** Hashes local analysis inputs without putting their contents into reports. */
export function fingerprint(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/** Extracts scope-aware global references from one transformed JavaScript module. */
export function analyzeSource(source, file = "module.js") {
  const sf = ts.createSourceFile("evidence.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const host = ts.createCompilerHost({ allowJs: true });
  host.getSourceFile = (name) => name === "evidence.js" ? sf : undefined;
  host.writeFile = () => {};
  const program = ts.createProgram(["evidence.js"], { allowJs: true, noLib: true, noResolve: true, types: [] }, host);
  const checker = program.getTypeChecker();
  const references = [];
  const issues = sf.parseDiagnostics.length ? ["source_parse_error"] : [];
  const reassigned = new Set();
  /** Marks mutable aliases whose initializers no longer identify their later values. */
  function findWrites(node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left)) {
      reassigned.add(checker.getSymbolAtLocation(node.left));
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
      reassigned.add(checker.getSymbolAtLocation(node.operand));
    }
    ts.forEachChild(node, findWrites);
  }
  findWrites(sf);

  /** Resolves static roots and immutable aliases without guessing at dynamic property names. */
  function resolve(node, seen = new Set()) {
    if (ts.isParenthesizedExpression(node)) return resolve(node.expression, seen);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (!symbol || !symbol.declarations?.length) {
        if (roots.has(node.text)) return [];
        if (names.has(node.text)) return [names.get(node.text)];
        return null;
      }
      if (seen.has(symbol)) return null;
      seen = new Set([...seen, symbol]);
      const declaration = symbol.valueDeclaration;
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && !reassigned.has(symbol)) {
        return resolve(declaration.initializer, seen);
      }
      if (declaration && ts.isBindingElement(declaration) && ts.isObjectBindingPattern(declaration.parent)) {
        const variable = declaration.parent.parent;
        if (ts.isVariableDeclaration(variable) && variable.initializer && !reassigned.has(symbol)) {
          const base = resolve(variable.initializer, seen);
          const property = declaration.propertyName ?? declaration.name;
          if (base && (ts.isIdentifier(property) || ts.isStringLiteral(property))) {
            return [...base, base.length === 0 ? (names.get(property.text) ?? property.text) : property.text];
          }
        }
      }
      return null;
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      const left = resolve(node.left, seen);
      const right = resolve(node.right, seen);
      if (left && right && JSON.stringify(left) === JSON.stringify(right)) return left;
    }
    if (ts.isConditionalExpression(node)) {
      if (node.whenFalse.kind === ts.SyntaxKind.NullKeyword) return resolve(node.whenTrue, seen);
      if (node.whenTrue.kind === ts.SyntaxKind.NullKeyword) return resolve(node.whenFalse, seen);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = resolve(node.expression, seen);
      if (!base) return null;
      const property = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      if (!property || !(ts.isIdentifier(property) && ts.isPropertyAccessExpression(node) || ts.isStringLiteral(property))) {
        issues.push("dynamic_global_access");
        return null;
      }
      return [...base, base.length === 0 ? (names.get(property.text) ?? property.text) : property.text];
    }
    return null;
  }

  /** Visits value expressions and records enclosing code, retaining feature guards for review. */
  function visit(node) {
    if (ts.isWithStatement(node)) issues.push("dynamic_scope");
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && ts.isIdentifier(node.expression) &&
        ["eval", "Function"].includes(node.expression.text) && !checker.getSymbolAtLocation(node.expression)?.declarations?.length) {
      issues.push("dynamic_code_evaluation");
    }
    const valueExpression = ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
    const isPropertyName = node.parent && (
      ts.isPropertyAccessExpression(node.parent) && node.parent.name === node ||
      (ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)) && node.parent.name === node ||
      ts.isBindingElement(node.parent) && node.parent.propertyName === node
    );
    if (valueExpression && !isPropertyName) {
      const access = resolve(node);
      if (access && names.has(access[0])) {
        const parentAccess = node.parent && (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node;
        // Record the full path, rather than duplicating each prefix of crypto.getRandomValues.
        if (!parentAccess) {
          let context = node;
          while (context.parent && !ts.isSourceFile(context.parent) && !ts.isFunctionLike(context)) context = context.parent;
          const code = context.getText(sf);
          const position = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          const featureName = ts.isFunctionLike(context)
            ? (context.name?.getText(sf) ?? (ts.isVariableDeclaration(context.parent) ? context.parent.name.getText(sf) : "anonymous callback"))
            : "module initialization";
          references.push({ capability: access[0], members: access.slice(1), file, line: position.line + 1,
            feature: featureName, code, complete: true, initialization: !ts.isFunctionLike(context) });
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { references, issues: [...new Set(issues)] };
}

/** Merges installed module evidence without claiming that static absence proves no need. */
export function analyzeLibrary(library) {
  const references = [];
  const issues = [...library.issues];
  for (const module of library.modules) {
    if (module.source === undefined) continue;
    const analyzed = analyzeSource(module.source, module.file);
    references.push(...analyzed.references);
    issues.push(...analyzed.issues);
  }
  return { name: library.name, packages: library.packages, moduleCount: library.modules.length,
    moduleFingerprint: fingerprint(library.modules.map(({ file, hash }) => ({ file, hash }))),
    issues: [...new Set(issues)], references };
}
