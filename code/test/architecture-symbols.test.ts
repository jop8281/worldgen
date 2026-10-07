/**
 * Architecture rules, part B: symbols, brands and switches.
 *
 * Every rule resolves names with the TypeChecker, never by matching text, so a local
 * variable named `Date` or a local type named `CheckIssue` does not fire. Each rule returns
 * its violations as `<file>:<line> <what>`, sorted by file and line. Every rule has one case
 * over the real source tree and one virtual fixture proving it fires. Rules scan code/src only.
 * Import boundaries are part A (test/architecture.test.ts).
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { FIELD_TYPES } from '../src/engine/fields.ts';
import { CODE_ROOT, VIRTUAL_ROOT, programFromFiles, programFromTree, sourceFilesUnder } from './helpers/ts-program.ts';

type Rule = (program: ts.Program, root: string) => string[];
type Violation = { readonly file: string; readonly line: number; readonly what: string };

const ENGINE_SHELL = new Set(['src/engine/index.ts', 'src/engine/sandbox.ts', 'src/engine/http.ts']);
/**
 * Global names engine core may not reference. Math.random is matched as a member of the global
 * Math. Function and eval compile code that escapes the rule, and Intl reads the host clock and zone.
 */
const BANNED_GLOBALS = new Set(['Date', 'globalThis', 'performance', 'Function', 'eval', 'Intl']);
const DATE_OWNER = 'src/engine/clock.ts';
/** Each branded type, and the one file allowed to assert to it. */
const BRANDS = [
  { name: 'CheckIssue', owner: 'src/engine/issues.ts' },
  { name: 'CheckedWorld', owner: 'src/engine/check.ts' },
  { name: 'TaskVerdict', owner: 'src/engine/tasks.ts' },
] as const;
const NEVER_FILE = 'src/lib/never.ts';

const toPosix = (p: string): string => p.split(path.sep).join('/');
const isEngineCore = (file: string): boolean => file.startsWith('src/engine/') && !ENGINE_SHELL.has(file);

function report(violations: Violation[]): string[] {
  return [...violations]
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.what < b.what ? -1 : a.what > b.what ? 1 : 0)))
    .map((v) => (v.line === 0 ? `${v.file} ${v.what}` : `${v.file}:${v.line} ${v.what}`));
}

/** Each source file under src/ with its path relative to root. */
function srcFiles(program: ts.Program, root: string): { file: string; sf: ts.SourceFile }[] {
  return sourceFilesUnder(program, root, 'src').map((sf) => ({ file: toPosix(path.relative(root, sf.fileName)), sf }));
}

const lineOf = (sf: ts.SourceFile, node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol): ts.Symbol {
  return (sym.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(sym) : sym;
}

/**
 * True when a declaration lives in the global scope: the top level of a script file (lib
 * files) or a `declare global` block (@types/node). Anything in a module, function or block is local.
 */
function isGlobalDeclaration(decl: ts.Node): boolean {
  let stmt: ts.Node = decl;
  if (ts.isVariableDeclaration(decl)) {
    if (!ts.isVariableDeclarationList(decl.parent)) return false; // catch clause or for-of binding
    stmt = decl.parent.parent;
  }
  const scope = stmt.parent;
  if (scope === undefined) return false;
  if (ts.isSourceFile(scope)) return !ts.isExternalModule(scope);
  return ts.isModuleBlock(scope) && (scope.parent.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}

/** `globalThis` is a checker intrinsic with no declarations, so an empty list counts as global. */
const isGlobalSymbol = (sym: ts.Symbol): boolean => (sym.declarations ?? []).every(isGlobalDeclaration);

/** The `random` member of the global `Math`, whether declared in `interface Math` or a type literal on `var Math`. */
function isMathRandom(sym: ts.Symbol): boolean {
  if (sym.name !== 'random') return false;
  return (sym.declarations ?? []).some((d) => {
    const owner = d.parent;
    if (ts.isInterfaceDeclaration(owner)) return owner.name.text === 'Math' && isGlobalDeclaration(owner);
    return (
      ts.isTypeLiteralNode(owner) &&
      ts.isVariableDeclaration(owner.parent) &&
      ts.isIdentifier(owner.parent.name) &&
      owner.parent.name.text === 'Math' &&
      isGlobalDeclaration(owner.parent)
    );
  });
}

/** The member name an object binding element reads: `propertyName` when renamed, else its name. Computed keys yield undefined. */
function bindingKey(node: ts.BindingElement): string | undefined {
  const key = node.propertyName ?? node.name;
  return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
}

/** True when a member is unresolved (read off an `any`) or declared only in declaration files (lib, @types). */
const isLibraryMember = (sym: ts.Symbol | undefined): boolean =>
  sym === undefined || (sym.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile);

/**
 * Engine core never references Date (except clock.ts), globalThis, performance, Math.random,
 * Function, eval or Intl, and never reads `.constructor` off a value whose member comes from a
 * library (`(() => 0).constructor` is the Function constructor) or off an `any`, whether by
 * property access, element access or destructuring (`const { constructor: F } = () => 0`).
 */
const bannedGlobals: Rule = (program, root) => {
  const checker = program.getTypeChecker();
  const out: Violation[] = [];
  for (const { file, sf } of srcFiles(program, root)) {
    if (!isEngineCore(file)) continue;
    const flag = (node: ts.Node, sym: ts.Symbol | undefined): void => {
      if (sym === undefined) return;
      const target = resolveAlias(checker, sym);
      let what: string | undefined;
      if (isMathRandom(target)) what = 'Math.random';
      else if (BANNED_GLOBALS.has(target.name) && isGlobalSymbol(target) && !(target.name === 'Date' && file === DATE_OWNER)) what = target.name;
      if (what !== undefined) out.push({ file, line: lineOf(sf, node), what });
    };
    walk(sf, (node) => {
      const parent = node.parent;
      if (ts.isIdentifier(node)) {
        const shorthand = parent !== undefined && ts.isShorthandPropertyAssignment(parent) && parent.name === node;
        flag(node, shorthand ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node));
      } else if (ts.isStringLiteralLike(node) && parent !== undefined && ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
        flag(node, checker.getSymbolAtLocation(node));
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // `const { random } = Math` or `const { constructor: F } = fn`: the binding is a new local,
        // so look the member up on the pattern's type. A renamed key is an identifier the branch above flags.
        const key = bindingKey(node);
        if (key !== undefined) {
          const sym = checker.getTypeAtLocation(node.parent).getProperty(key);
          if (node.propertyName === undefined) flag(node, sym);
          if (key === 'constructor' && isLibraryMember(sym)) out.push({ file, line: lineOf(sf, node), what: 'Function constructor' });
        }
      }
      const member = ts.isPropertyAccessExpression(node)
        ? node.name
        : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression
          : undefined;
      if (member !== undefined && member.text === 'constructor' && isLibraryMember(checker.getSymbolAtLocation(member))) {
        out.push({ file, line: lineOf(sf, node), what: 'Function constructor' });
      }
    });
  }
  return report(out);
};

/** The brand property declarations of each branded type alias, found in its owner file. */
function brandDeclarations(program: ts.Program, root: string): { brands: Map<string, Set<ts.Node>>; missing: Violation[] } {
  const brands = new Map<string, Set<ts.Node>>();
  const missing: Violation[] = [];
  for (const { name, owner } of BRANDS) {
    const sf = program.getSourceFile(path.join(root, owner));
    const decls = new Set<ts.Node>();
    const alias = sf?.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === name);
    if (alias !== undefined) {
      walk(alias.type, (n) => {
        if (ts.isPropertySignature(n) && ts.isComputedPropertyName(n.name)) decls.add(n);
      });
    }
    if (decls.size === 0) missing.push({ file: owner, line: 0, what: `missing brand ${name}` });
    else brands.set(name, decls);
  }
  return { brands, missing };
}

/** How deep brandsIn follows properties and return types. Generic library types instantiate without end. */
const MAX_TYPE_DEPTH = 6;

/** True when the type is declared in project source, not in lib or node_modules declaration files. */
const isProjectType = (t: ts.Type): boolean => {
  const decls = (t.aliasSymbol ?? t.symbol)?.declarations ?? [];
  return decls.length > 0 && decls.every((d) => !d.getSourceFile().isDeclarationFile);
};

/**
 * Names of the brands a type carries anywhere inside it: union and intersection members, type
 * arguments (arrays, tuples, NonEmpty, Result), and the properties and return types of types
 * declared in project source. Library types contribute only their type arguments.
 */
function brandsIn(checker: ts.TypeChecker, type: ts.Type, brands: Map<string, Set<ts.Node>>): Set<string> {
  const found = new Set<string>();
  const seen = new Set<ts.Type>();
  const visit = (t: ts.Type, depth: number): void => {
    if (seen.has(t) || depth > MAX_TYPE_DEPTH) return;
    seen.add(t);
    const props = checker.getPropertiesOfType(t);
    for (const [name, decls] of brands) {
      if (props.some((p) => (p.declarations ?? []).some((d) => decls.has(d)))) found.add(name);
    }
    const next = (u: ts.Type): void => visit(u, depth + 1);
    if (t.isUnionOrIntersection()) t.types.forEach(next);
    t.aliasTypeArguments?.forEach(next);
    if ((t.flags & ts.TypeFlags.Object) !== 0 && ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0) {
      checker.getTypeArguments(t as ts.TypeReference).forEach(next);
    }
    if (!isProjectType(t)) return;
    for (const p of props) next(checker.getTypeOfSymbol(p));
    for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct]) {
      for (const sig of checker.getSignaturesOfType(t, kind)) next(checker.getReturnTypeOfSignature(sig));
    }
  };
  visit(type, 0);
  return found;
}

/**
 * The brands a generic call or `new` invents: ones its result carries that neither the callee's
 * declared result (before type arguments are applied) nor any argument the call actually passes
 * already carries. The callee is a generic function or method, or for `new` a generic class. So
 * `forge<CheckIssue>(x)`, `fill<CheckIssue>(partial)`, `orStr<CheckIssue>('x')` and
 * `new Box<CheckIssue>(1)` invent CheckIssue, while `first(issues)` and `new Holder(issue)` pass
 * one through. Library classes are trusted, so `new Map<string, CheckIssue>()` (an empty
 * container) invents nothing, but library functions are not: `z.custom<CheckIssue>()` invents CheckIssue.
 */
function inventedBrands(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression, brands: Map<string, Set<ts.Node>>): string[] {
  const sig = checker.getResolvedSignature(call);
  if (sig === undefined) return [];
  // A class with no constructor of its own has a signature with no declaration; its class is the callee.
  const sigDecl = sig.getDeclaration() as ts.SignatureDeclaration | undefined;
  const callee = ts.isNewExpression(call) ? checker.getSymbolAtLocation(call.expression) : undefined;
  const classSym = callee === undefined ? undefined : resolveAlias(checker, callee);
  const calleeDecl = classSym?.valueDeclaration;
  const cls = calleeDecl !== undefined && ts.isClassLike(calleeDecl) ? calleeDecl : undefined;
  const fn = sigDecl === undefined || ts.isClassLike(sigDecl) ? undefined : sigDecl;
  const decl = fn ?? cls;
  // A library class is trusted (`new Map<string, CheckIssue>()` is an empty container); a library
  // function is not, since `z.custom<CheckIssue>()` returns T from nothing.
  if (decl === undefined || (ts.isNewExpression(call) && decl.getSourceFile().isDeclarationFile)) return [];
  if ((fn?.typeParameters?.length ?? 0) + (cls?.typeParameters?.length ?? 0) === 0) return [];
  const declared = fn === undefined ? undefined : checker.getSignatureFromDeclaration(fn);
  const declaredResult = declared !== undefined
    ? checker.getReturnTypeOfSignature(declared)
    : classSym === undefined ? undefined : checker.getDeclaredTypeOfSymbol(classSym);
  const known = new Set<string>(declaredResult === undefined ? [] : brandsIn(checker, declaredResult, brands));
  for (const arg of call.arguments ?? []) brandsIn(checker, checker.getTypeAtLocation(arg), brands).forEach((b) => known.add(b));
  return [...brandsIn(checker, checker.getReturnTypeOfSignature(sig), brands)].filter((b) => !known.has(b));
}

/**
 * Brands are minted only in their owner file. Outside it, these report the brands they produce:
 * a type assertion to a type containing a brand (`as CheckIssue`, `<TaskVerdict>x`); an `as any`,
 * `as unknown` or `as never` whose value flows where a brand is expected (`const w: CheckedWorld = x as any`),
 * directly or through variables typed any, unknown or never that it initializes or is assigned to
 * (`const x = {} as any; const w: CheckedWorld = x;`), in any src file; and a generic call or
 * `new` whose result carries a brand that no argument it passes carries (`forge<CheckIssue>(x)`,
 * `new Box<CheckIssue>(x)`), which is an identity cast under another name. Each forge is reported once, at the cast.
 */
const brandCasts: Rule = (program, root) => {
  const checker = program.getTypeChecker();
  const { brands, missing } = brandDeclarations(program, root);
  const owners = new Map<string, string>(BRANDS.map((b) => [b.name, b.owner]));
  const out: Violation[] = [...missing];
  const files = srcFiles(program, root);
  // Every identifier in src by the symbol it names, imports resolved, so a cast's value can be followed.
  const refs = new Map<ts.Symbol, ts.Identifier[]>();
  for (const { sf } of files) {
    walk(sf, (n) => {
      if (!ts.isIdentifier(n)) return;
      const sym = checker.getSymbolAtLocation(n);
      if (sym === undefined) return;
      const key = resolveAlias(checker, sym);
      const list = refs.get(key);
      if (list === undefined) refs.set(key, [n]);
      else list.push(n);
    });
  }
  const outermost = (e: ts.Expression): ts.Expression => {
    let o = e;
    while (ts.isParenthesizedExpression(o.parent)) o = o.parent;
    return o;
  };
  /** any, unknown and never: an assertion to one of these is judged by where its value flows, since never is assignable to every brand. */
  const isOpaque = (t: ts.Type): boolean => (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) !== 0;
  /**
   * The expressions an `as any` / `as unknown` / `as never` value reaches: the cast itself, then every read of a
   * variable typed any, unknown or never that it initializes or is assigned to, transitively.
   */
  const reach = (expr: ts.Expression, seen: Set<ts.Symbol>): ts.Expression[] => {
    const o = outermost(expr);
    const p = o.parent;
    const bound = ts.isVariableDeclaration(p) && p.initializer === o && ts.isIdentifier(p.name)
      ? p.name
      : ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === o && ts.isIdentifier(p.left)
        ? p.left
        : undefined;
    const sym = bound === undefined ? undefined : checker.getSymbolAtLocation(bound);
    if (bound === undefined || sym === undefined || seen.has(sym) || !isOpaque(checker.getTypeOfSymbol(sym))) return [o];
    seen.add(sym);
    const reads = (refs.get(sym) ?? []).filter((r) => {
      const q = r.parent;
      if (r === bound || (ts.isVariableDeclaration(q) && q.name === r)) return false;
      if (ts.isImportSpecifier(q) || ts.isExportSpecifier(q) || ts.isImportClause(q) || ts.isNamespaceImport(q)) return false;
      return !(ts.isBinaryExpression(q) && q.left === r && q.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    });
    return [o, ...reads.flatMap((r) => reach(r, seen))];
  };
  for (const { file, sf } of files) {
    const flagNames = (node: ts.Node, names: Iterable<string>, what: (name: string) => string): void => {
      for (const name of [...new Set(names)].sort()) {
        if (owners.get(name) !== file) out.push({ file, line: lineOf(sf, node), what: what(name) });
      }
    };
    const flag = (node: ts.Node, types: readonly (ts.Type | undefined)[], what: (name: string) => string): void =>
      flagNames(node, types.flatMap((t) => (t === undefined ? [] : [...brandsIn(checker, t, brands)])), what);
    walk(sf, (node) => {
      if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
        if (ts.isConstTypeReference(node.type)) return;
        const asserted = checker.getTypeFromTypeNode(node.type);
        if (!isOpaque(asserted)) {
          flag(node, [asserted], (name) => `as ${name}`);
          return;
        }
        const outer = outermost(node);
        // `x as unknown as T` is judged by its outer assertion.
        if (ts.isAsExpression(outer.parent) || ts.isTypeAssertionExpression(outer.parent)) return;
        const kind = (asserted.flags & ts.TypeFlags.Any) !== 0 ? 'any' : (asserted.flags & ts.TypeFlags.Never) !== 0 ? 'never' : 'unknown';
        // A read that is itself asserted (`x as CheckedWorld`) is judged by that assertion.
        const sinks = reach(node, new Set()).filter((e) => !ts.isAsExpression(e.parent) && !ts.isTypeAssertionExpression(e.parent));
        flag(node, sinks.map((e) => checker.getContextualType(e)), (name) => `as ${kind} to ${name}`);
      } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        flagNames(node, inventedBrands(checker, node, brands), (name) => `generic cast to ${name}`);
      }
    });
  }
  return report(out);
};

/** The clause's statements with blocks opened, so `default: { assertNever(x); }` ends on the call. */
function flatStatements(stmts: readonly ts.Statement[]): ts.Statement[] {
  return stmts.flatMap((s) => (ts.isBlock(s) ? flatStatements(s.statements) : [s]));
}

/**
 * True when the statement can leave the clause: a return or throw anywhere in its own control
 * flow, a labeled break or continue, or an unlabeled one not owned by a nested loop or switch.
 */
function canExit(stmt: ts.Statement): boolean {
  const visit = (node: ts.Node, inLoop: boolean, inSwitch: boolean): boolean => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
    if (ts.isBreakStatement(node)) return node.label !== undefined || !(inLoop || inSwitch);
    if (ts.isContinueStatement(node)) return node.label !== undefined || !inLoop;
    const loop = inLoop || ts.isIterationStatement(node, false);
    const sw = inSwitch || ts.isSwitchStatement(node);
    return ts.forEachChild(node, (child) => visit(child, loop, sw) || undefined) ?? false;
  };
  return visit(stmt, false, false);
}

/**
 * Every `default:` clause in src ends on src/lib/never.ts `assertNever`, reached unconditionally:
 * its last statement is `return assertNever(x)`, `throw assertNever(x)` or `assertNever(x);`, no
 * statement before it can leave the clause, and x is a reference the switch narrowed to never.
 */
const exhaustiveSwitches: Rule = (program, root) => {
  const checker = program.getTypeChecker();
  const neverSf = program.getSourceFile(path.join(root, NEVER_FILE));
  const decl = neverSf?.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'assertNever');
  const target = decl?.name === undefined ? undefined : checker.getSymbolAtLocation(decl.name);
  const out: Violation[] = target === undefined ? [{ file: NEVER_FILE, line: 0, what: 'missing assertNever' }] : [];
  const isAssertNever = (call: ts.CallExpression): boolean => {
    const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
    const sym = checker.getSymbolAtLocation(callee);
    return target !== undefined && sym !== undefined && resolveAlias(checker, sym) === target;
  };
  /**
   * The call's one argument is a plain reference (`k`, `e.kind`) whose declared type is not never,
   * so its never type at the call comes from the switch narrowing it. `assertNever(k as never)` or a
   * variable declared never would type-check on a switch that misses a case.
   */
  const narrowedToNever = (call: ts.CallExpression): boolean => {
    const [first] = call.arguments;
    if (first === undefined || call.arguments.length !== 1) return false;
    let arg: ts.Expression = first;
    while (ts.isParenthesizedExpression(arg)) arg = arg.expression;
    const isReference = (e: ts.Expression): boolean =>
      ts.isIdentifier(e) || (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) && isReference(e.expression));
    if (!isReference(arg)) return false;
    const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(arg) ? arg.name : arg);
    if (sym === undefined) return false;
    return (checker.getTypeOfSymbol(sym).flags & ts.TypeFlags.Never) === 0;
  };
  for (const { file, sf } of srcFiles(program, root)) {
    walk(sf, (node) => {
      if (!ts.isDefaultClause(node)) return;
      const flat = flatStatements(node.statements);
      const last = flat[flat.length - 1];
      const expr = last === undefined
        ? undefined
        : ts.isReturnStatement(last) || ts.isThrowStatement(last) || ts.isExpressionStatement(last)
          ? last.expression
          : undefined;
      const endsOnAssert = expr !== undefined && ts.isCallExpression(expr) && isAssertNever(expr) && narrowedToNever(expr);
      if (!endsOnAssert || flat.slice(0, -1).some(canExit)) out.push({ file, line: lineOf(sf, node), what: 'default' });
    });
  }
  return report(out);
};

const FIELD_TYPE_OWNER = 'src/engine/fields.ts';

/**
 * Code outside fields.ts branches on a field type tag: a `switch`, or a `===`, `!==`, `==` or `!=`, on an expression
 * the checker types as two or more field type names. That covers `x.type`, `x['type']` and an alias of either. Per-type behavior is a member of
 * a `KINDS` entry (A-113). Tags of other unions, such as a JSON Schema `type` or a message `type`, do not match.
 */
const fieldTypeBranches: Rule = (program, root) => {
  const checker = program.getTypeChecker();
  const fieldTypes = new Set<string>(Object.keys(FIELD_TYPES));
  const isTag = (expr: ts.Expression): boolean => {
    const t = checker.getNonNullableType(checker.getTypeAtLocation(expr));
    return t.isUnion() && t.types.length >= 2 && t.types.every((m) => m.isStringLiteral() && fieldTypes.has(m.value));
  };
  const COMPARE = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
  const out: Violation[] = [];
  for (const { file, sf } of srcFiles(program, root)) {
    if (file === FIELD_TYPE_OWNER) continue;
    walk(sf, (node) => {
      if (ts.isSwitchStatement(node) && isTag(node.expression)) out.push({ file, line: lineOf(sf, node), what: 'switch on a field type' });
      else if (ts.isBinaryExpression(node) && COMPARE.has(node.operatorToken.kind) && (isTag(node.left) || isTag(node.right))) {
        out.push({ file, line: lineOf(sf, node), what: 'comparison on a field type' });
      }
    });
  }
  return report(out);
};

let realProgram: ts.Program | undefined;
const real = (): ts.Program => (realProgram ??= programFromTree(CODE_ROOT));

/** Globals for virtual programs, which compile with noLib. Every virtual file is a module, so they use `declare global`. */
const VIRTUAL_GLOBALS = [
  'export {};',
  'declare global {',
  '  interface Array<T> { length: number; [n: number]: T }',
  '  interface Boolean {}',
  '  interface CallableFunction {}',
  '  interface Function {}',
  '  interface IArguments {}',
  '  interface NewableFunction {}',
  '  interface Number {}',
  '  interface Object {}',
  '  interface RegExp {}',
  '  interface String {}',
  '  interface Date { getTime(): number }',
  '  var Date: { new (v?: number): Date; now(): number };',
  '  interface Math { random(): number; floor(x: number): number }',
  '  var Math: Math;',
  '  var performance: { now(): number };',
  '  class Error { constructor(message?: string) }',
  '  function String(v: unknown): string;',
  '  type Partial<T> = { [P in keyof T]?: T[P] };',
  '}',
].join('\n');

const lines = (...ls: string[]): string => `${ls.join('\n')}\n`;

describe('rule: engine core references no banned global', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(bannedGlobals(real(), CODE_ROOT), []);
  });

  it('fires on Date, globalThis, performance and Math.random in engine core, but not on shadowed names, in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      'src/engine/store.ts': lines(
        'export const now = Date.now();',
        'export const r = Math.random();',
        'export const g = globalThis;',
        'export const p = performance.now();',
        "export const viaIndex = Math['random']();",
        'const { random } = Math;',
        'export const viaDestructure = random();',
        'const M = Math;',
        'export const viaAlias = M.random();',
        'export let typed: Date | undefined;',
        'export const short = { Date };',
        'export const fine = Math.floor(1);',
        'const { random: rnd } = Math;',
        'export const renamed = rnd();',
      ),
      'src/engine/shadow.ts': lines(
        "import { Date as D } from './mydate.ts';",
        'export function param(Date: number): number { return Date + 1; }',
        'export function local(): number { const Date = { now: () => 1 }; return Date.now(); }',
        'export const viaImport = new D();',
        'export const prop = { Date: 1 }.Date;',
        'export class Inner { Date = 1; }',
      ),
      'src/engine/mydate.ts': 'export class Date {}\n',
      'src/engine/api.ts': lines('const Date = (n: number): number => n;', 'export const a = Date(1);'),
      'src/engine/clock.ts': lines('export const at = new Date(0);', 'export const r = Math.random();', 'export type G = typeof globalThis;'),
      'src/engine/nested/clock.ts': 'export const d = Date.now();\n',
      'src/engine/index.ts': lines('export const now = Date.now();', 'export const g = globalThis;'),
      'src/engine/sandbox.ts': 'export const r = Math.random();\n',
      'src/engine/http.ts': 'export const p = performance.now();\n',
      'src/worldgen/run.ts': 'export const d = Date.now();\n',
      'test/clock.test.ts': 'export const d = Math.random();\n',
    });
    assert.deepEqual(bannedGlobals(program, VIRTUAL_ROOT), [
      'src/engine/clock.ts:2 Math.random',
      'src/engine/clock.ts:3 globalThis',
      'src/engine/nested/clock.ts:1 Date',
      'src/engine/store.ts:1 Date',
      'src/engine/store.ts:2 Math.random',
      'src/engine/store.ts:3 globalThis',
      'src/engine/store.ts:4 performance',
      'src/engine/store.ts:5 Math.random',
      'src/engine/store.ts:6 Math.random',
      'src/engine/store.ts:9 Math.random',
      'src/engine/store.ts:10 Date',
      'src/engine/store.ts:11 Date',
      'src/engine/store.ts:13 Math.random',
    ]);
  });

  it('fires on Function, eval, Intl and the Function constructor in engine core, but not on shadowed names, in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      'types/escapes.d.ts': lines(
        'export {};',
        'declare global {',
        '  interface Object { constructor: Function }',
        '  var Function: { new (...args: string[]): () => unknown; (...args: string[]): () => unknown };',
        '  function eval(source: string): unknown;',
        '  namespace Intl { class DateTimeFormat { format(): string } }',
        '}',
      ),
      'src/engine/store.ts': lines(
        "export const viaFunction = Function('return Date.now()')();",
        "export const viaEval = eval('Date.now()');",
        'export const viaIntl = new Intl.DateTimeFormat().format();',
        "export const viaCtor = (() => 0).constructor('return Date.now()');",
        "export const viaIndex = (() => 0)['constructor'];",
        'declare const proto: any;',
        'export const viaAny = proto.constructor;',
        'export type F = Function;',
        'export const { constructor: Renamed } = () => 0;',
        'export const { constructor } = () => 0;',
        "export const { 'constructor': Quoted } = () => 0;",
        'export function fromAny({ constructor: C }: any): unknown { return C; }',
      ),
      'src/engine/shadow.ts': lines(
        'class Box { constructor(readonly n: number) {} }',
        'export const box = new Box(1);',
        'export function param(Function: number, Intl: number): number { return Function + Intl; }',
        'export const own = { constructor: 1 }.constructor;',
        'export const prop = { Intl: 1 }.Intl;',
        'export const { constructor: ownCtor } = { constructor: 1 };',
      ),
      'src/engine/index.ts': "export const f = Function('return 1');\n",
      'src/engine/sandbox.ts': "export const c = (() => 0).constructor;\n",
      'src/worldgen/run.ts': "export const e = eval('1');\n",
    });
    assert.deepEqual(bannedGlobals(program, VIRTUAL_ROOT), [
      'src/engine/store.ts:1 Function',
      'src/engine/store.ts:2 eval',
      'src/engine/store.ts:3 Intl',
      'src/engine/store.ts:4 Function constructor',
      'src/engine/store.ts:5 Function constructor',
      'src/engine/store.ts:7 Function constructor',
      'src/engine/store.ts:8 Function',
      'src/engine/store.ts:9 Function constructor',
      'src/engine/store.ts:10 Function constructor',
      'src/engine/store.ts:11 Function constructor',
      'src/engine/store.ts:12 Function constructor',
    ]);
  });
});

const BRAND_OWNERS = {
  'src/engine/issues.ts': lines(
    'declare const issueBrand: unique symbol;',
    'export type CheckIssue = { readonly code: string; readonly [issueBrand]: true };',
    'export type NonEmpty<T> = readonly [T, ...T[]];',
    'export function issue(code: string): CheckIssue { return { code } as CheckIssue; }',
    "export const forged = {} as import('./check.ts').CheckedWorld;",
  ),
  'src/engine/check.ts': lines(
    'declare const checked: unique symbol;',
    'export type World = { readonly name: string };',
    'export type CheckedWorld = World & { readonly [checked]: true };',
    'export function checkWorld(w: World): CheckedWorld { return w as CheckedWorld; }',
  ),
  'src/engine/tasks.ts': lines(
    'declare const verdictBrand: unique symbol;',
    'export type TaskVerdict = { readonly taskId: string; readonly [verdictBrand]: true };',
    'export const mint = (taskId: string): TaskVerdict => ({ taskId }) as TaskVerdict;',
  ),
  'src/engine/index.ts': lines(
    "export type { CheckIssue, NonEmpty } from './issues.ts';",
    "export type { CheckedWorld, World } from './check.ts';",
    "export type { TaskVerdict } from './tasks.ts';",
  ),
};

describe('rule: brands are asserted only in their minter file', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(brandCasts(real(), CODE_ROOT), []);
  });

  it('fires on casts to a brand or a type containing one outside its owner in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      ...BRAND_OWNERS,
      'src/worldgen/judge.ts': lines(
        "import type { CheckIssue, CheckedWorld, NonEmpty, TaskVerdict, World } from '#engine';",
        'export const a = {} as CheckIssue;',
        'export const b = <TaskVerdict>{};',
        'export const c = [] as unknown as NonEmpty<CheckIssue>;',
        'export const d = {} as { readonly world: CheckedWorld };',
        'type V = TaskVerdict;',
        'export const e = {} as V;',
        'export const f = {} as () => CheckedWorld;',
        'export const g = {} as CheckIssue | TaskVerdict;',
        "export const ok1 = { name: 'x' } as World;",
        "export const ok2 = ['a'] as const;",
        'export declare const real: CheckIssue;',
        'export const ok3 = real satisfies CheckIssue;',
      ),
      'src/worldgen/report.ts': lines('type CheckIssue = { readonly code: string };', "export const x = { code: 'a' } as CheckIssue;"),
      'test/judge.test.ts': lines("import type { CheckIssue } from '../src/engine/issues.ts';", 'export const t = {} as CheckIssue;'),
    });
    assert.deepEqual(brandCasts(program, VIRTUAL_ROOT), [
      'src/engine/issues.ts:5 as CheckedWorld',
      'src/worldgen/judge.ts:2 as CheckIssue',
      'src/worldgen/judge.ts:3 as TaskVerdict',
      'src/worldgen/judge.ts:4 as CheckIssue',
      'src/worldgen/judge.ts:5 as CheckedWorld',
      'src/worldgen/judge.ts:7 as TaskVerdict',
      'src/worldgen/judge.ts:8 as CheckedWorld',
      'src/worldgen/judge.ts:9 as CheckIssue',
      'src/worldgen/judge.ts:9 as TaskVerdict',
    ]);
  });

  it('fires on as any and generic identity casts (inferred, class, optional-parameter, Partial, union) that produce a brand outside its owner in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      ...BRAND_OWNERS,
      'src/worldgen/judge.ts': lines(
        "import type { CheckIssue, CheckedWorld, TaskVerdict } from '#engine';",
        'export const viaAny: CheckedWorld = {} as any;',
        'function forge<T>(x: unknown): T { return x as T; }',
        "export const viaGeneric = forge<CheckIssue>({ code: 'x' });",
        'export function ret(): TaskVerdict { return (<any>{}); }',
        'declare function take(w: CheckedWorld): void;',
        'take({} as any);',
        'function cast<T>(x: unknown) { return x as T; }',
        'export const viaInferred: readonly CheckIssue[] = [cast<CheckIssue>(1)];',
        'function first<T>(xs: readonly T[]): T | undefined { return xs[0]; }',
        'export declare const issues: readonly CheckIssue[];',
        'export const ok1 = first(issues);',
        'export const ok2: unknown = {} as any;',
        'export const once = {} as unknown as CheckedWorld;',
        'function wrap<T>(x: unknown) { return { v: x as T }; }',
        'export const viaCompound = wrap<CheckIssue>(1).v;',
        'class Box<T> { x: unknown; constructor(x: unknown) { this.x = x; } get(): T { return this.x as T; } }',
        'export const viaClass: CheckIssue = new Box<CheckIssue>(1).get();',
        'function hinted<T>(x: unknown, _hint?: T): T { return x as T; }',
        'export const viaOptional = hinted<CheckIssue>(1);',
        'export declare const issue: CheckIssue;',
        'export const ok3 = hinted(1, issue);',
        'class Holder<T> { v: T; constructor(v: T) { this.v = v; } }',
        'export const ok4 = new Holder(issue).v;',
        'class Empty<T> { get(): T | undefined { return undefined; } }',
        'export const viaImplicit = new Empty<TaskVerdict>();',
        'function fill<T>(x: Partial<T>): T { return x as T; }',
        "export const viaPartial = fill<CheckIssue>({ code: 'x' });",
        'function orStr<T>(x: T | string): T { return x as T; }',
        "export const viaUnion = orStr<CheckIssue>('x');",
        'export const ok5 = orStr(issue);',
        'function withIssue<T>(x: T): { x: T; issue: CheckIssue } { return { x, issue: issueOf() }; }',
        'declare function issueOf(): CheckIssue;',
        'export const ok6 = withIssue(1);',
      ),
      'src/engine/tasks.ts': lines(
        'declare const verdictBrand: unique symbol;',
        'export type TaskVerdict = { readonly taskId: string; readonly [verdictBrand]: true };',
        'function forge<T>(x: unknown): T { return x as T; }',
        "export const minted: TaskVerdict = forge<TaskVerdict>({ taskId: 'a' });",
        'export const alsoMinted: TaskVerdict = {} as any;',
      ),
    });
    assert.deepEqual(brandCasts(program, VIRTUAL_ROOT), [
      'src/engine/issues.ts:5 as CheckedWorld',
      'src/worldgen/judge.ts:2 as any to CheckedWorld',
      'src/worldgen/judge.ts:4 generic cast to CheckIssue',
      'src/worldgen/judge.ts:5 as any to TaskVerdict',
      'src/worldgen/judge.ts:7 as any to CheckedWorld',
      'src/worldgen/judge.ts:9 generic cast to CheckIssue',
      'src/worldgen/judge.ts:14 as CheckedWorld',
      'src/worldgen/judge.ts:16 generic cast to CheckIssue',
      'src/worldgen/judge.ts:18 generic cast to CheckIssue',
      'src/worldgen/judge.ts:20 generic cast to CheckIssue',
      'src/worldgen/judge.ts:26 generic cast to TaskVerdict',
      'src/worldgen/judge.ts:28 generic cast to CheckIssue',
      'src/worldgen/judge.ts:30 generic cast to CheckIssue',
    ]);
  });

  it('fires on as any that reaches a brand through variables, across files, outside its owner in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      ...BRAND_OWNERS,
      'src/worldgen/judge.ts': lines(
        "import type { CheckedWorld, TaskVerdict } from '#engine';",
        'const x = {} as any;',
        'export const w: CheckedWorld = x;',
        'let y;',
        'y = (<any>{});',
        'const z = y;',
        'export function ret(): TaskVerdict { return z; }',
        'export const loose = {} as any;',
        'const u = {} as any;',
        'export const fine: string = u;',
        'const asserted = {} as any;',
        'export const viaAssert = asserted as CheckedWorld;',
        'const typed: unknown = {} as any;',
        'export const keep: unknown = typed;',
      ),
      'src/worldgen/report.ts': lines(
        "import type { CheckedWorld } from '#engine';",
        "import { loose } from './judge.ts';",
        'export const w2: CheckedWorld = loose;',
      ),
      'src/engine/tasks.ts': lines(
        'declare const verdictBrand: unique symbol;',
        'export type TaskVerdict = { readonly taskId: string; readonly [verdictBrand]: true };',
        'const t = {} as any;',
        'export const minted: TaskVerdict = t;',
      ),
    });
    assert.deepEqual(brandCasts(program, VIRTUAL_ROOT), [
      'src/engine/issues.ts:5 as CheckedWorld',
      'src/worldgen/judge.ts:2 as any to CheckedWorld',
      'src/worldgen/judge.ts:5 as any to TaskVerdict',
      'src/worldgen/judge.ts:8 as any to CheckedWorld',
      'src/worldgen/judge.ts:12 as CheckedWorld',
    ]);
  });

  it('fires on as never and on library generic functions that produce a brand outside its owner in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      'types/schema.d.ts': lines(
        "declare module 'schema' {",
        '  export interface Schema<T> { parse(data: unknown): T }',
        '  export function custom<T>(check?: (data: unknown) => boolean): Schema<T>;',
        '  export function of<T>(value: T): Schema<T>;',
        '  export class Bag<T> { get(): T | undefined }',
        '}',
      ),
      ...BRAND_OWNERS,
      'src/worldgen/judge.ts': lines(
        "import type { CheckIssue, CheckedWorld, TaskVerdict } from '#engine';",
        "import { Bag, custom, of } from 'schema';",
        'export const viaNever: CheckedWorld = {} as never;',
        'export function launder(x: unknown): CheckIssue { return x as never; }',
        'export const twice: TaskVerdict = {} as unknown as never;',
        'const n = {} as never;',
        'export const viaVar: CheckIssue = n;',
        "export const viaLib: CheckIssue = custom<CheckIssue>().parse({ code: 'x' });",
        'export declare const issue: CheckIssue;',
        'export const ok1 = of(issue);',
        'export const ok2 = new Bag<CheckIssue>();',
        'export const ok3: string = {} as never;',
      ),
      'src/engine/tasks.ts': lines(
        'declare const verdictBrand: unique symbol;',
        'export type TaskVerdict = { readonly taskId: string; readonly [verdictBrand]: true };',
        "import { custom } from 'schema';",
        'export const minted: TaskVerdict = {} as never;',
        'export const viaLib = custom<TaskVerdict>();',
      ),
    });
    assert.deepEqual(brandCasts(program, VIRTUAL_ROOT), [
      'src/engine/issues.ts:5 as CheckedWorld',
      'src/worldgen/judge.ts:3 as never to CheckedWorld',
      'src/worldgen/judge.ts:4 as never to CheckIssue',
      'src/worldgen/judge.ts:5 as never to TaskVerdict',
      'src/worldgen/judge.ts:6 as never to CheckIssue',
      'src/worldgen/judge.ts:8 generic cast to CheckIssue',
    ]);
  });

  it('reports a brand it cannot find, so the real-tree case cannot pass vacuously', () => {
    const program = programFromFiles({
      'src/engine/issues.ts': 'export type CheckIssue = { readonly code: string };\n',
      'src/worldgen/judge.ts': "import type { CheckIssue } from '../engine/issues.ts';\nexport const a = {} as CheckIssue;\n",
    });
    assert.deepEqual(brandCasts(program, VIRTUAL_ROOT), [
      'src/engine/check.ts missing brand CheckedWorld',
      'src/engine/issues.ts missing brand CheckIssue',
      'src/engine/tasks.ts missing brand TaskVerdict',
    ]);
  });
});

describe('rule: every default: clause calls assertNever', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(exhaustiveSwitches(real(), CODE_ROOT), []);
  });

  it('fires on a default: without assertNever from src/lib/never.ts in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      'src/lib/never.ts': lines('export function assertNever(value: never): never {', '  throw new Error(String(value));', '}'),
      'src/worldgen/policy.ts': lines(
        "import { assertNever } from '#lib/never';",
        "import { assertNever as unreachable } from '../lib/never.ts';",
        "import * as never from '#lib/never';",
        "type K = 'a' | 'b';",
        "export function direct(k: K): number { switch (k) { case 'a': return 1; case 'b': return 2; default: return assertNever(k); } }",
        "export function block(k: K): number { switch (k) { case 'a': case 'b': return 1; default: { assertNever(k); } } }",
        "export function aliased(k: K): number { switch (k) { case 'a': case 'b': return 1; default: return unreachable(k); } }",
        "export function namespaced(k: K): number { switch (k) { case 'a': case 'b': return 1; default: return never.assertNever(k); } }",
        'export function thrown(k: K): never { switch (k) { default: throw assertNever(k); } }',
        "export function none(k: K): number { switch (k) { case 'a': return 1; case 'b': return 2; } }",
        "export function silent(k: K): number { switch (k) { case 'a': return 1; default: return 0; } }",
        "export function nested(k: K): number { switch (k) { case 'a': case 'b': return 1; default: { const f = () => assertNever(k); return f(); } } }",
        "export function fallsInto(k: K): number { switch (k) { default: case 'a': return 1; case 'b': return 2; } }",
        "export function dead(k: K): number { switch (k) { case 'a': return 1; default: if (k === 'b') assertNever(k as never); return 0; } }",
        "export function early(k: K): number { switch (k) { case 'a': case 'b': return 1; default: return 0; assertNever(k); } }",
        "export function guarded(k: K): number { switch (k) { case 'a': case 'b': return 1; default: { if (k) break; return assertNever(k); } } return 0; }",
        "export function looped(k: K): number { switch (k) { case 'a': case 'b': return 1; default: { for (const x of [1]) { if (x) break; } return assertNever(k); } } }",
        "export function middle(k: K): number { switch (k) { case 'a': case 'b': return 1; default: assertNever(k); return 0; } }",
        "export function cond(k: K): number { switch (k) { case 'a': case 'b': return 1; default: return k ? assertNever(k) : 0; } }",
        "export function castNever(k: K): number { switch (k) { case 'a': return 1; default: return assertNever(k as never); } }",
        "export function angle(k: K): number { switch (k) { case 'a': return 1; default: return assertNever(<never>k); } }",
        "export function viaVar(k: K): number { const n = k as never; switch (k) { case 'a': return 1; default: return assertNever(n); } }",
        "type E = { kind: 'x' } | { kind: 'y' };",
        "export function member(e: E): number { switch (e.kind) { case 'x': case 'y': return 1; default: return assertNever(e); } }",
        "export function field(o: { k: K }): number { switch (o.k) { case 'a': case 'b': return 1; default: return assertNever(o.k); } }",
      ),
      'src/engine/api.ts': lines(
        'function assertNever(x: never): never { throw new Error(String(x)); }',
        "export function f(k: 'a'): number { switch (k) { case 'a': return 1; default: return assertNever(k); } }",
      ),
      'test/policy.test.ts': 'export function t(k: string): number { switch (k) { default: return 0; } }\n',
    });
    assert.deepEqual(exhaustiveSwitches(program, VIRTUAL_ROOT), [
      'src/engine/api.ts:2 default',
      'src/worldgen/policy.ts:11 default',
      'src/worldgen/policy.ts:12 default',
      'src/worldgen/policy.ts:13 default',
      'src/worldgen/policy.ts:14 default',
      'src/worldgen/policy.ts:15 default',
      'src/worldgen/policy.ts:16 default',
      'src/worldgen/policy.ts:18 default',
      'src/worldgen/policy.ts:19 default',
      'src/worldgen/policy.ts:20 default',
      'src/worldgen/policy.ts:21 default',
      'src/worldgen/policy.ts:22 default',
    ]);
  });

  it('reports a missing assertNever, so the real-tree case cannot pass vacuously', () => {
    const program = programFromFiles({ 'src/worldgen/policy.ts': 'export const a = 1;\n' });
    assert.deepEqual(exhaustiveSwitches(program, VIRTUAL_ROOT), ['src/lib/never.ts missing assertNever']);
  });
});

describe('rule: field type behavior lives in fields.ts, not in branches on the type tag', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(fieldTypeBranches(real(), CODE_ROOT), []);
  });

  it('fires on switches and comparisons of a field type tag, directly or through an alias, outside fields.ts in a fixture', () => {
    const program = programFromFiles({
      'types/globals.d.ts': VIRTUAL_GLOBALS,
      'src/engine/fields.ts': lines("export type Field = { type: 'ref' } | { type: 'state' };", 'export const own = (f: Field): boolean => f.type === \'ref\';'),
      'src/engine/api.ts': lines(
        "import type { Field } from './fields.ts';",
        "export const a = (f: Field): boolean => f.type === 'ref';",
        "export const b = (f: Field): boolean => f.type !== 'state';",
        "export function c(f: Field): number { switch (f.type) { case 'ref': return 1; case 'state': return 2; } }",
        "export const d = (f: Field): boolean => 'ref' == f.type;",
        "export const g = (f: Field): boolean => f['type'] === 'ref';",
        "export const h = (f: Field): boolean => { const t = f.type; return t === 'state'; };",
        "export const i = (f: Field | undefined): boolean => f?.type === 'ref';",
      ),
      'src/worldgen/input.ts': lines(
        "type Schema = { type: 'array' | 'object' };",
        "type Msg = { type: 'ref' | 'text_message' };",
        "export const e = (s: Schema): boolean => s.type === 'array';",
        "export const f = (m: Msg): boolean => m.type === 'ref';",
      ),
    });
    assert.deepEqual(fieldTypeBranches(program, VIRTUAL_ROOT), [
      'src/engine/api.ts:2 comparison on a field type',
      'src/engine/api.ts:3 comparison on a field type',
      'src/engine/api.ts:4 switch on a field type',
      'src/engine/api.ts:5 comparison on a field type',
      'src/engine/api.ts:6 comparison on a field type',
      'src/engine/api.ts:7 comparison on a field type',
      'src/engine/api.ts:8 comparison on a field type',
    ]);
  });
});
