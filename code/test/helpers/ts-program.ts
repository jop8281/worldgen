/**
 * TypeScript programs for architecture rules: the real tree from code/tsconfig.json, or
 * a set of virtual files behind an in-memory compiler host. Imports are read from the
 * AST and resolved with the compiler's own module resolution, never matched with a regex.
 */
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** The code/ directory, with symlinks resolved so it matches the compiler's file names. */
export const CODE_ROOT = realpathSync(path.resolve(import.meta.dirname, '..', '..'));
/** Root of every program built by programFromFiles. */
export const VIRTUAL_ROOT = '/virtual';

export type ImportRef = {
  /** The module specifier exactly as written. */
  readonly specifier: string;
  /** Absolute file name the compiler resolved it to, or undefined (builtins without types, missing files). */
  readonly resolved: string | undefined;
  /** True when the import erases at compile time: `import type`, `export type`, `import('x')` in a type. */
  readonly typeOnly: boolean;
  /** Imported names by their exported name; `default` for a default import, `*` for a namespace, star or dynamic import. */
  readonly names: readonly string[];
};

const hosts = new WeakMap<ts.Program, ts.ModuleResolutionHost>();

function readConfig(dir: string): ts.ParsedCommandLine {
  const configPath = path.join(dir, 'tsconfig.json');
  const fail = (d: readonly ts.Diagnostic[]): never => {
    throw new Error(`${configPath}: ${d.map((x) => ts.flattenDiagnosticMessageText(x.messageText, '\n')).join('; ')}`);
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => fail([d]),
  });
  if (parsed === undefined) return fail([]);
  if (parsed.errors.length > 0) return fail(parsed.errors);
  return parsed;
}

/** The program `tsc -p <dir>/tsconfig.json` would build. */
export function programFromTree(dir: string): ts.Program {
  const parsed = readConfig(realpathSync(dir));
  const host = ts.createCompilerHost(parsed.options, true);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });
  hosts.set(program, host);
  return program;
}

/**
 * A program over virtual files keyed by path relative to VIRTUAL_ROOT, compiled with
 * code/tsconfig.json's options. The real code/package.json is added unless given, so
 * `#engine` resolves as it does in the package. Nothing is read from disk but that file.
 */
export function programFromFiles(files: Readonly<Record<string, string>>): ts.Program {
  const all = new Map<string, string>();
  all.set(path.posix.join(VIRTUAL_ROOT, 'package.json'), readFileSync(path.join(CODE_ROOT, 'package.json'), 'utf8'));
  for (const [rel, text] of Object.entries(files)) all.set(path.posix.join(VIRTUAL_ROOT, rel), text);

  const options: ts.CompilerOptions = { ...readConfig(CODE_ROOT).options, noLib: true, types: [] };
  const isDir = (d: string): boolean => {
    const prefix = d.endsWith('/') ? d : `${d}/`;
    return [...all.keys()].some((f) => f.startsWith(prefix));
  };
  const host: ts.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = all.get(fileName);
      return text === undefined ? undefined : ts.createSourceFile(fileName, text, languageVersion, true);
    },
    getDefaultLibFileName: () => path.posix.join(VIRTUAL_ROOT, 'lib.d.ts'),
    writeFile: () => {},
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => all.has(f),
    readFile: (f) => all.get(f),
    directoryExists: isDir,
    getDirectories: () => [],
    realpath: (f) => f,
  };
  const rootNames = [...all.keys()].filter((f) => f.endsWith('.ts'));
  const program = ts.createProgram({ rootNames, options, host });
  hosts.set(program, host);
  return program;
}

/** Source files of the program under `<root>/<dir>/`, excluding declaration files. */
export function sourceFilesUnder(program: ts.Program, root: string, dir: string): ts.SourceFile[] {
  const prefix = path.join(root, dir) + path.sep;
  return program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && path.normalize(sf.fileName).startsWith(prefix) && !sf.fileName.includes('/node_modules/'));
}

function clauseNames(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) return [];
  const names: string[] = [];
  if (clause.name !== undefined) names.push('default');
  const bindings = clause.namedBindings;
  if (bindings !== undefined) {
    if (ts.isNamespaceImport(bindings)) names.push('*');
    else for (const el of bindings.elements) names.push((el.propertyName ?? el.name).text);
  }
  return names;
}

function leftmost(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : leftmost(name.left);
}

function sourceFile(program: ts.Program, file: string | ts.SourceFile): ts.SourceFile {
  const sf = typeof file === 'string' ? program.getSourceFile(file) : file;
  if (sf === undefined) throw new Error(`not in program: ${String(file)}`);
  return sf;
}

/** An ImportRef for one module specifier literal of `sf`, resolved with the program's own module resolution. */
function refFor(program: ts.Program, sf: ts.SourceFile, lit: ts.StringLiteralLike, typeOnly: boolean, names: string[]): ImportRef {
  const host = hosts.get(program) ?? ts.sys;
  const mode = program.getModeForUsageLocation(sf, lit);
  const resolved = ts.resolveModuleName(lit.text, sf.fileName, program.getCompilerOptions(), host, undefined, undefined, mode).resolvedModule;
  return { specifier: lit.text, resolved: resolved?.resolvedFileName, typeOnly, names };
}

/** Every static import, re-export, import-require, literal dynamic import and import type of a file, in source order. */
export function importsOf(program: ts.Program, file: string | ts.SourceFile): ImportRef[] {
  const sf = sourceFile(program, file);
  const refs: ImportRef[] = [];
  const add = (lit: ts.StringLiteralLike, typeOnly: boolean, names: string[]): void => {
    refs.push(refFor(program, sf, lit, typeOnly, names));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier, node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword, clauseNames(node.importClause));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const names = clause === undefined || ts.isNamespaceExport(clause) ? ['*'] : clause.elements.map((el) => (el.propertyName ?? el.name).text);
      add(node.moduleSpecifier, node.isTypeOnly, names);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression, node.isTypeOnly, ['*']);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg !== undefined && ts.isStringLiteralLike(arg)) add(arg, false, ['*']);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      add(node.argument.literal, true, [node.qualifier === undefined ? '*' : leftmost(node.qualifier)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

export type Reexport = {
  /** The module the names come from. */
  readonly ref: ImportRef;
  /**
   * `'*'` for `export * from`, which forwards every name but `default`. Otherwise each name this
   * file exports, mapped to its name in the source module; `'*'` as a value is the whole namespace.
   */
  readonly names: '*' | ReadonlyMap<string, string>;
};

/** How a local binding was imported: its import declaration and its name in the source module (`*` for a namespace). */
type ImportedBinding = { readonly decl: ts.ImportDeclaration; readonly lit: ts.StringLiteral; readonly source: string };

/** The import declaration and source name an import alias declaration (specifier, default clause, namespace) stands for. */
function bindingOf(decl: ts.Declaration): ImportedBinding | undefined {
  let source: string;
  let importDecl: ts.Node;
  if (ts.isImportSpecifier(decl)) {
    source = (decl.propertyName ?? decl.name).text;
    importDecl = decl.parent.parent.parent;
  } else if (ts.isImportClause(decl)) {
    source = 'default';
    importDecl = decl.parent;
  } else if (ts.isNamespaceImport(decl)) {
    source = '*';
    importDecl = decl.parent.parent;
  } else return undefined;
  if (!ts.isImportDeclaration(importDecl) || !ts.isStringLiteral(importDecl.moduleSpecifier)) return undefined;
  return { decl: importDecl, lit: importDecl.moduleSpecifier, source };
}

/** An expression with parentheses, `as`, `satisfies`, `<T>` assertions and `!` removed. */
function stripWrappers(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isNonNullExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/**
 * The re-export edges of a file, in source order: `export * from`, `export * as ns from`,
 * `export { a as b } from`, and a value that names an imported binding exported again by a local
 * `export { a }`, by `export default a`, or by `export const b = a`. Names are resolved with the
 * checker: wrappers (parentheses, `as`, `satisfies`, `!`) are stripped, a local variable is
 * followed to its initializer (`const alias = a; export { alias }`), and a member of a namespace
 * import names that module's export (`import * as m from 'x'; export const b = m.a`).
 */
export function reexportsOf(program: ts.Program, file: string | ts.SourceFile): Reexport[] {
  const sf = sourceFile(program, file);
  const checker = program.getTypeChecker();
  const out: Reexport[] = [];
  /** The import a symbol stands for, through local variables initialized with an imported value. */
  const fromSymbol = (sym: ts.Symbol | undefined, seen: Set<ts.Symbol>): ImportedBinding | undefined => {
    if (sym === undefined || seen.has(sym)) return undefined;
    seen.add(sym);
    for (const d of sym.declarations ?? []) {
      const hit = bindingOf(d);
      if (hit !== undefined) return hit;
      if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name) && d.initializer !== undefined && d.getSourceFile() === sf) {
        const via = fromExpression(d.initializer, seen);
        if (via !== undefined) return via;
      }
    }
    return undefined;
  };
  /** The import an expression names: an imported identifier, a local alias of one, or a member of a namespace import. */
  const fromExpression = (expr: ts.Expression, seen: Set<ts.Symbol>): ImportedBinding | undefined => {
    const e = stripWrappers(expr);
    if (ts.isIdentifier(e)) return fromSymbol(checker.getSymbolAtLocation(e), seen);
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      const ns = fromExpression(e.expression, seen);
      return ns?.source === '*' ? { ...ns, source: e.name.text } : undefined;
    }
    return undefined;
  };
  /** One edge per import declaration for `exported -> imported binding` pairs of a local export. */
  const localEdges = (pairs: readonly (readonly [string, ImportedBinding | undefined])[], typeOnlyExport: boolean): void => {
    const byDecl = new Map<ts.ImportDeclaration, { lit: ts.StringLiteral; names: Map<string, string> }>();
    for (const [exported, hit] of pairs) {
      if (hit === undefined) continue;
      const entry = byDecl.get(hit.decl) ?? { lit: hit.lit, names: new Map<string, string>() };
      entry.names.set(exported, hit.source);
      byDecl.set(hit.decl, entry);
    }
    for (const [decl, { lit, names }] of byDecl) {
      const typeOnly = typeOnlyExport || decl.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      out.push({ ref: refFor(program, sf, lit, typeOnly, [...names.values()]), names });
    }
  };
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st) && st.isExportEquals !== true) {
      // `import { a } from 'x'; export default a;` forwards x's `a` as `default`.
      localEdges([['default', fromExpression(st.expression, new Set())]], false);
      continue;
    }
    if (ts.isVariableStatement(st) && (st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      // `import { a } from 'x'; export const b = a;` is a value bridge that forwards x's `a` as `b`.
      const pairs = st.declarationList.declarations.flatMap((d) =>
        ts.isIdentifier(d.name) && d.initializer !== undefined ? [[d.name.text, fromExpression(d.initializer, new Set())] as const] : []);
      localEdges(pairs, false);
      continue;
    }
    if (!ts.isExportDeclaration(st)) continue;
    const clause = st.exportClause;
    if (st.moduleSpecifier !== undefined && ts.isStringLiteral(st.moduleSpecifier)) {
      if (clause === undefined) {
        out.push({ ref: refFor(program, sf, st.moduleSpecifier, st.isTypeOnly, ['*']), names: '*' });
      } else if (ts.isNamespaceExport(clause)) {
        out.push({ ref: refFor(program, sf, st.moduleSpecifier, st.isTypeOnly, ['*']), names: new Map([[clause.name.text, '*']]) });
      } else {
        const names = new Map(clause.elements.map((el) => [el.name.text, (el.propertyName ?? el.name).text] as const));
        out.push({ ref: refFor(program, sf, st.moduleSpecifier, st.isTypeOnly, [...names.values()]), names });
      }
    } else if (clause !== undefined && ts.isNamedExports(clause)) {
      // `import { a } from 'x'; export { a as b };` forwards x's `a` just like `export { a as b } from 'x'`.
      localEdges(
        clause.elements.map((el) => [el.name.text, fromSymbol(checker.getExportSpecifierLocalTargetSymbol(el), new Set())] as const),
        st.isTypeOnly,
      );
    }
  }
  return out;
}
