/**
 * Contract test for engine/ctx.ts (decision A-19).
 *
 * Each ctx registry entry documents a member as `{ sig, doc }`. The model reads `sig`; the
 * snippet receives the TS interface member. This test translates every `sig` into a TS type and
 * compiles, in memory against the real ctx.ts, one declaration per member that assigns a value of
 * that type to the interface member. It also compares parameter counts, checks typed parameters
 * and narrowed types in both directions, reports members a sig documents that the interface lacks
 * and interface members a written-out sig shape leaves out, and compares member lists.
 *
 * Sig notation (see research/spec-calls/engine-ctx-contract.md):
 * - `name(params) => ret; ...` is an object of methods. A method without `=> ret` returns void.
 * - `(params) => ret` is a function. Anything else is a TS type as written.
 * - Untyped params and shorthand shape fields (`{ status, body }`) are `any`.
 * - A param written as an object shape becomes a positional param of that shape type.
 * - A param written as a string example (`"15m"`) is a string.
 * - Vocabulary: `entity` is a string, `iso` is `Iso`, `x` is any element.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CODE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CTX_PATH = resolve(CODE_DIR, 'src/engine/ctx.ts');
const VIRTUAL_PATH = resolve(CODE_DIR, 'src/engine/__ctx_contract__.ts');
const CTX_SOURCE = readFileSync(CTX_PATH, 'utf8');

type Failure = { readonly member: string; readonly message: string };
type KindReport = {
  readonly kind: string;
  readonly interfaceMembers: readonly string[];
  readonly registryMembers: readonly string[];
};
type Report = { readonly kinds: readonly KindReport[]; readonly failures: readonly Failure[] };

// ---------- sig notation -> TS type ----------

/** Index of the bracket that closes the one at `open`. */
function closing(s: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']', '<': '>' };
  const stack: string[] = [];
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=' && s[i + 1] === '>') {
      i++;
      continue;
    }
    if (c in pairs) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`unbalanced brackets in sig: ${s}`);
}

/** Split on `sep` outside brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=' && s[i + 1] === '>') {
      i++;
      continue;
    }
    if ('({[<'.includes(c)) depth++;
    else if (')}]>'.includes(c)) depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

function params(list: string): string {
  return splitTop(list, ',')
    .map((p, i) => {
      if (p.startsWith('{')) {
        const end = closing(p, 0);
        const optional = p.slice(end + 1).trim() === '?' ? '?' : '';
        return `p${i}${optional}: ${p.slice(0, end + 1)}`;
      }
      if (p.startsWith('"') || p.startsWith("'")) return `p${i}: string`;
      return p;
    })
    .join(', ');
}

/** `(params) => ret` or `name(params) => ret`, split into parts. */
function callParts(s: string): { name: string; params: string; ret: string | null } | null {
  const m = /^([A-Za-z_$][\w$]*)?\s*\(/.exec(s);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = closing(s, open);
  const rest = s.slice(close + 1).trim();
  if (rest !== '' && !rest.startsWith('=>')) return null;
  return {
    name: m[1] ?? '',
    params: s.slice(open + 1, close),
    ret: rest === '' ? null : rest.slice(2).trim(),
  };
}

function sigToType(sig: string): string {
  const s = sig.trim();
  const first = callParts(s);
  if (first && first.name !== '') {
    const methods = splitTop(s, ';').map((entry) => {
      const c = callParts(entry);
      if (!c || c.name === '') throw new Error(`not a method: ${entry}`);
      return `${c.name}(${params(c.params)}): ${c.ret ?? 'void'}`;
    });
    return `{ ${methods.join('; ')} }`;
  }
  if (first && first.ret !== null) return `(${params(first.params)}) => ${first.ret}`;
  return s;
}

// ---------- reading ctx.ts ----------

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

function topConsts(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) out.set(d.name.text, d.initializer);
    }
  }
  return out;
}

function propName(p: ts.ObjectLiteralElementLike): string {
  if (!p.name || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) throw new Error(`unsupported key: ${p.getText()}`);
  return p.name.text;
}

function objectOf(e: ts.Expression, consts: Map<string, ts.Expression>): ts.ObjectLiteralExpression {
  const u = unwrap(e);
  if (ts.isObjectLiteralExpression(u)) return u;
  if (ts.isIdentifier(u) && consts.has(u.text)) return objectOf(consts.get(u.text)!, consts);
  throw new Error(`expected an object literal: ${e.getText()}`);
}

function stringOf(e: ts.Expression, consts: Map<string, ts.Expression>): string {
  const u = unwrap(e);
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text;
  if (ts.isTemplateExpression(u)) {
    return u.head.text + u.templateSpans.map((sp) => stringOf(sp.expression, consts) + sp.literal.text).join('');
  }
  if (ts.isIdentifier(u) && consts.has(u.text)) return stringOf(consts.get(u.text)!, consts);
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return stringOf(u.left, consts) + stringOf(u.right, consts);
  }
  throw new Error(`expected a constant string: ${e.getText()}`);
}

function entries(obj: ts.ObjectLiteralExpression): [string, ts.Expression][] {
  return obj.properties.map((p): [string, ts.Expression] => {
    if (ts.isPropertyAssignment(p)) return [propName(p), unwrap(p.initializer)];
    if (ts.isShorthandPropertyAssignment(p)) return [p.name.text, p.name];
    throw new Error(`unsupported registry entry: ${p.getText()}`);
  });
}

/** kind -> (member -> sig), read from CTX_BY_KIND and the registries it names. */
function registries(sf: ts.SourceFile): Map<string, Map<string, string>> {
  const consts = topConsts(sf);
  const byKind = consts.get('CTX_BY_KIND');
  if (!byKind) throw new Error('CTX_BY_KIND not found in ctx.ts');
  const out = new Map<string, Map<string, string>>();
  for (const [kind, regExpr] of entries(objectOf(byKind, consts))) {
    const members = new Map<string, string>();
    for (const [name, memberExpr] of entries(objectOf(regExpr, consts))) {
      const sigProp = objectOf(memberExpr, consts).properties.find((p) => propName(p) === 'sig');
      if (!sigProp || !ts.isPropertyAssignment(sigProp)) throw new Error(`${kind}.${name} has no sig`);
      members.set(name, stringOf(sigProp.initializer, consts));
    }
    out.set(kind, members);
  }
  return out;
}

// ---------- in-memory program ----------

const baseOptions: ts.CompilerOptions = (() => {
  const cfgPath = resolve(CODE_DIR, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, (p) => ts.sys.readFile(p));
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, CODE_DIR, undefined, cfgPath);
  return { ...parsed.options, noEmit: true, types: [], noImplicitAny: false, noUnusedLocals: false };
})();
const sourceCache = new Map<string, ts.SourceFile>();

function createProgram(files: ReadonlyMap<string, string>): ts.Program {
  const host = ts.createCompilerHost(baseOptions, true);
  const own = (f: string) => files.get(resolve(f));
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, lang, onError, shouldCreate) => {
    const text = own(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, lang, true);
    const key = resolve(fileName);
    let sf = sourceCache.get(key);
    if (!sf) {
      sf = getSourceFile(fileName, lang, onError, shouldCreate);
      if (sf) sourceCache.set(key, sf);
    }
    return sf;
  };
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (f) => own(f) !== undefined || fileExists(f);
  host.readFile = (f) => own(f) ?? readFile(f);
  return ts.createProgram({ rootNames: [VIRTUAL_PATH], options: baseOptions, host });
}

const PRELUDE = [
  "import type { SnippetKinds } from './ctx.ts';",
  "import type { Row } from './store.ts';",
  "import type { Iso } from './clock.ts';",
  'type entity = string;',
  'type iso = Iso;',
  'type x = any;',
  '',
].join('\n');

/** Callable parameter count of a type, or null when it is not callable. */
function arity(t: ts.Type): number | null {
  const sigs = t.getCallSignatures();
  return sigs.length === 0 ? null : sigs[0]!.getParameters().length;
}

function arityProblems(checker: ts.TypeChecker, sigT: ts.Type, memT: ts.Type, at: ts.Node): string[] {
  const top = arity(memT);
  if (top !== null) {
    const got = arity(sigT);
    return got !== null && got !== top ? [`sig takes ${got} parameter(s), interface takes ${top}`] : [];
  }
  const out: string[] = [];
  for (const prop of memT.getProperties()) {
    const want = arity(checker.getTypeOfSymbolAtLocation(prop, at));
    const sp = sigT.getProperty(prop.name);
    if (want === null || !sp) continue;
    const got = arity(checker.getTypeOfSymbolAtLocation(sp, at));
    if (got !== null && got !== want) out.push(`${prop.name}: sig takes ${got} parameter(s), interface takes ${want}`);
  }
  return out;
}

/** Return type of the first call signature, or null when the type is not callable. */
function returnOf(t: ts.Type): ts.Type | null {
  const sigs = t.getCallSignatures();
  return sigs.length === 0 ? null : sigs[0]!.getReturnType();
}

type Param = { readonly name: string; readonly type: ts.Type; readonly optional: boolean; readonly any: boolean };

/**
 * Parameters of the first call signature. An optional parameter's type drops the `undefined`
 * its `?` adds, so a sig `{ where? }` compares against the interface `q?: { where?: Where }` by
 * value type, and optionality is compared on its own.
 */
function paramsOf(checker: ts.TypeChecker, t: ts.Type, at: ts.Node): Param[] {
  const sigs = t.getCallSignatures();
  if (sigs.length === 0) return [];
  return sigs[0]!.getParameters().map((sym) => {
    const decl = sym.valueDeclaration;
    const optional = decl !== undefined && ts.isParameter(decl) && checker.isOptionalParameter(decl);
    const declared = checker.getTypeOfSymbolAtLocation(sym, at);
    const type = optional ? checker.getNonNullableType(declared) : declared;
    return { name: sym.name, type, optional, any: (declared.flags & ts.TypeFlags.Any) !== 0 };
  });
}

/** `null` and `undefined` flags present in a type, so two nullable types can be compared by what remains. */
function nullish(t: ts.Type): number {
  const mask = ts.TypeFlags.Null | ts.TypeFlags.Undefined;
  return (t.isUnion() ? t.types : [t]).reduce((f, x) => f | (x.flags & mask), 0);
}

/**
 * True when the sig itself writes this shape out, not when it names a type such as `Row`. TS
 * types every `{}` as one shared empty literal with no declaration, so that counts as written out.
 */
function writtenInSig(t: ts.Type): boolean {
  const decls = t.symbol?.declarations ?? [];
  if (decls.length === 0) return t.getProperties().length === 0;
  return decls.some((d) => d.getSourceFile().fileName === VIRTUAL_PATH);
}

/**
 * Members on which a sig shape and the interface disagree by name. Assignability catches neither
 * kind: `sig_i` is a declared variable, not a fresh literal, so TS runs no excess-property check,
 * and a shape that leaves out an optional member is still assignable both ways. Walks every object
 * shape the sig writes out (`{ ... }` or `name(...) => ...; ...`), recursing into shared
 * properties, parameters, return types and array elements. Each property the interface lacks is
 * reported by path, and so is each interface property (optional ones included) that a shape
 * written out in the sig leaves out, so the model is never left without a documented option.
 */
function shapeProblems(checker: ts.TypeChecker, sigType: ts.Type, memT: ts.Type, at: ts.Node, path = '', depth = 0): string[] {
  if (depth > 6) return [];
  const sigT = checker.getNonNullableType(sigType);
  const mem = checker.getNonNullableType(memT);
  const sigRet = returnOf(sigT);
  const memRet = returnOf(mem);
  if (sigRet && memRet) {
    const memParams = paramsOf(checker, mem, at);
    const out = paramsOf(checker, sigT, at).flatMap((sp, i) => {
      const mp = memParams[i];
      return mp ? shapeProblems(checker, sp.type, mp.type, at, `${path}(${mp.name}).`, depth + 1) : [];
    });
    return [...out, ...shapeProblems(checker, sigRet, memRet, at, `${path}return.`, depth + 1)];
  }
  if (checker.isArrayType(sigT) && checker.isArrayType(mem)) {
    const [sigEl] = checker.getTypeArguments(sigT as ts.TypeReference);
    const [memEl] = checker.getTypeArguments(mem as ts.TypeReference);
    return sigEl && memEl ? shapeProblems(checker, sigEl, memEl, at, `${path}[].`, depth + 1) : [];
  }
  if (!sigT.symbol || (sigT.symbol.flags & ts.SymbolFlags.TypeLiteral) === 0) return [];
  const out: string[] = [];
  for (const sp of sigT.getProperties()) {
    const mp = mem.getProperty(sp.name);
    if (!mp) {
      out.push(`${path}${sp.name}: sig documents a member the interface does not have`);
      continue;
    }
    out.push(
      ...shapeProblems(
        checker,
        checker.getTypeOfSymbolAtLocation(sp, at),
        checker.getTypeOfSymbolAtLocation(mp, at),
        at,
        `${path}${sp.name}.`,
        depth + 1,
      ),
    );
  }
  if (writtenInSig(sigT)) {
    for (const mp of mem.getProperties()) {
      if (!sigT.getProperty(mp.name)) out.push(`${path}${mp.name}: sig leaves out a member the interface has`);
    }
  }
  return out;
}

/**
 * Places where the sig promises a narrower type than the interface delivers, such as a `get`
 * documented as `=> Row` when it returns `Row | null`. `member_i = sig_i` cannot catch these:
 * return and value types are covariant, so it only proves the sig is a subtype. This checks the
 * other direction, interface to sig. It walks the same structure as shapeProblems (return types,
 * array elements, string index signatures, properties of object shapes the sig writes out) so a field the interface lacks
 * is reported once, there, and compares everything else whole. Two types that are nullable the
 * same way are compared without the null, so an optional `string[]` field matches an optional
 * `readonly string[]` one. Parameters get their own check, paramProblems.
 */
function narrowProblems(checker: ts.TypeChecker, sigT: ts.Type, memT: ts.Type, at: ts.Node, path = '', depth = 0): string[] {
  if (depth > 6) return [];
  const show = (t: ts.Type) => checker.typeToString(t);
  const differs = () => `${path === '' ? '' : `${path.slice(0, -1)}: `}sig documents ${show(sigT)}, interface has ${show(memT)}`;
  if (nullish(sigT) !== 0 && nullish(sigT) === nullish(memT)) {
    const sigNN = checker.getNonNullableType(sigT);
    const memNN = checker.getNonNullableType(memT);
    if ((sigNN.flags & ts.TypeFlags.Never) === 0 && (memNN.flags & ts.TypeFlags.Never) === 0) {
      return narrowProblems(checker, sigNN, memNN, at, path, depth);
    }
  }
  const sigRet = returnOf(sigT);
  const memRet = returnOf(memT);
  if (sigRet && memRet) {
    return [
      ...paramProblems(checker, sigT, memT, at, path, depth),
      ...narrowProblems(checker, sigRet, memRet, at, `${path}return.`, depth + 1),
    ];
  }
  if (sigRet || memRet) return [];
  if (checker.isArrayType(sigT) && checker.isArrayType(memT)) {
    const [sigEl] = checker.getTypeArguments(sigT as ts.TypeReference);
    const [memEl] = checker.getTypeArguments(memT as ts.TypeReference);
    return sigEl && memEl ? narrowProblems(checker, sigEl, memEl, at, `${path}[].`, depth + 1) : [];
  }
  const sigIdx = sigT.getStringIndexType();
  const memIdx = memT.getStringIndexType();
  if (sigIdx && memIdx && sigT.getProperties().length === 0) {
    return narrowProblems(checker, sigIdx, memIdx, at, `${path}[string].`, depth + 1);
  }
  const mapped = (sigT.flags & ts.TypeFlags.Object) !== 0 && ((sigT as ts.ObjectType).objectFlags & ts.ObjectFlags.Mapped) !== 0;
  if (mapped || !sigT.symbol || (sigT.symbol.flags & ts.SymbolFlags.TypeLiteral) === 0) {
    return checker.isTypeAssignableTo(memT, sigT) ? [] : [differs()];
  }
  const mem = checker.getNonNullableType(memT);
  const out = mem === memT ? [] : [differs()];
  for (const sp of sigT.getProperties()) {
    const mp = mem.getProperty(sp.name);
    if (!mp) continue;
    out.push(
      ...narrowProblems(
        checker,
        checker.getTypeOfSymbolAtLocation(sp, at),
        checker.getTypeOfSymbolAtLocation(mp, at),
        at,
        `${path}${sp.name}.`,
        depth + 1,
      ),
    );
  }
  return out;
}

/**
 * Typed parameters that differ from the interface. Interface members use method syntax, so
 * `member_i = sig_i` compares parameters bivariantly and catches neither a sig that widens a
 * parameter (`status: number` for `ErrorStatus`, which tells the model 500 is valid) nor one that
 * narrows it. Each parameter the sig types (not `any`) must be assignable to the interface
 * parameter, and the interface parameter to it, with optional parameters compared by value type.
 * A sig that marks a parameter optional when the interface requires it also fails.
 */
function paramProblems(checker: ts.TypeChecker, sigT: ts.Type, memT: ts.Type, at: ts.Node, path: string, depth: number): string[] {
  const show = (t: ts.Type) => checker.typeToString(t);
  const memParams = paramsOf(checker, memT, at);
  const out: string[] = [];
  paramsOf(checker, sigT, at).forEach((sp, i) => {
    const mp = memParams[i];
    if (!mp) return;
    const where = `${path}(${mp.name})`;
    if (sp.optional && !mp.optional) out.push(`${where}: sig marks it optional, interface requires it`);
    if (sp.any) return;
    if (!checker.isTypeAssignableTo(sp.type, mp.type)) {
      out.push(`${where}: sig documents ${show(sp.type)}, interface has ${show(mp.type)}`);
      return;
    }
    out.push(...narrowProblems(checker, sp.type, mp.type, at, `${where}.`, depth + 1));
  });
  return out;
}

function checkContract(ctxSource: string = CTX_SOURCE): Report {
  const ctxSf = ts.createSourceFile(CTX_PATH, ctxSource, ts.ScriptTarget.ES2023, true);
  const regs = registries(ctxSf);
  const failures: Failure[] = [];

  // One declaration pair per registry member; remember its span for diagnostics.
  let text = PRELUDE;
  const spans: { member: string; start: number; end: number; sigVar: string; memVar: string }[] = [];
  let i = 0;
  for (const [kind, members] of regs) {
    for (const [name, sig] of members) {
      const member = `${kind}.${name}`;
      let type: string;
      try {
        type = sigToType(sig);
      } catch (e) {
        failures.push({ member, message: `sig not in the documented notation: ${(e as Error).message}` });
        continue;
      }
      const start = text.length;
      text += `declare const sig_${i}: ${type};\nexport const member_${i}: SnippetKinds[${JSON.stringify(kind)}]['ctx'][${JSON.stringify(name)}] = sig_${i};\n`;
      spans.push({ member, start, end: text.length, sigVar: `sig_${i}`, memVar: `member_${i}` });
      i++;
    }
  }

  const program = createProgram(new Map([[CTX_PATH, ctxSource], [VIRTUAL_PATH, text]]));
  const sf = program.getSourceFile(VIRTUAL_PATH)!;
  const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
  for (const d of diags) {
    const span = spans.find((s) => d.start !== undefined && d.start >= s.start && d.start < s.end);
    failures.push({ member: span?.member ?? '<prelude>', message: ts.flattenDiagnosticMessageText(d.messageText, '\n') });
  }

  // Arity, and the interface member list per kind, from the checker.
  const checker = program.getTypeChecker();
  const decls = new Map<string, ts.VariableDeclaration>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) decls.set(d.name.text, d);
  }
  for (const s of spans) {
    const sigDecl = decls.get(s.sigVar)!;
    const memDecl = decls.get(s.memVar)!;
    const sigT = checker.getTypeAtLocation(sigDecl.name);
    const memT = checker.getTypeFromTypeNode(memDecl.type!);
    for (const message of arityProblems(checker, sigT, memT, memDecl)) failures.push({ member: s.member, message });
    for (const message of shapeProblems(checker, sigT, memT, memDecl)) failures.push({ member: s.member, message });
    for (const message of narrowProblems(checker, sigT, memT, memDecl)) failures.push({ member: s.member, message });
  }

  const ctxProgramSf = program.getSourceFile(CTX_PATH)!;
  const kindsDecl = ctxProgramSf.statements.find(
    (st): st is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(st) && st.name.text === 'SnippetKinds',
  );
  if (!kindsDecl) throw new Error('SnippetKinds not found in ctx.ts');
  const kindsType = checker.getTypeAtLocation(kindsDecl);
  const kinds: KindReport[] = [];
  for (const kindSym of kindsType.getProperties()) {
    const kind = kindSym.name;
    const ctxSym = checker.getTypeOfSymbolAtLocation(kindSym, kindsDecl).getProperty('ctx');
    const interfaceMembers = ctxSym ? checker.getTypeOfSymbolAtLocation(ctxSym, kindsDecl).getProperties().map((p) => p.name) : [];
    const registryMembers = [...(regs.get(kind)?.keys() ?? [])];
    for (const m of interfaceMembers) {
      if (!registryMembers.includes(m)) failures.push({ member: `${kind}.${m}`, message: 'interface member has no registry entry' });
    }
    for (const m of registryMembers) {
      if (!interfaceMembers.includes(m)) failures.push({ member: `${kind}.${m}`, message: 'registry entry has no interface member' });
    }
    kinds.push({ kind, interfaceMembers, registryMembers });
  }
  for (const kind of regs.keys()) {
    if (!kinds.some((k) => k.kind === kind)) failures.push({ member: kind, message: 'registry kind missing from SnippetKinds' });
  }
  return { kinds, failures };
}

/**
 * Drift this test finds in the real ctx.ts that this unit may not fix (ctx.ts is out of scope).
 * Fixture rows come from CSV and carry no branded `id`, but the sig documents them as `Row`.
 * Fix the sig in ctx.ts, then empty this list.
 */
const KNOWN_DRIFT: readonly Failure[] = [
  { member: 'seed.fixtures', message: '[string].[]: sig documents Row, interface has Readonly<Record<string, Value>>' },
];
const isKnown = (f: Failure) => KNOWN_DRIFT.some((k) => k.member === f.member && k.message === f.message);
/** Failures other than KNOWN_DRIFT, so each drifted-copy case sees only the drift it introduced. */
const newFailures = (r: Report) => r.failures.filter((f) => !isKnown(f));
const failingMembers = (r: Report) => [...new Set(newFailures(r).map((f) => f.member))];
const explain = (r: Report) => newFailures(r).map((f) => `${f.member}: ${f.message}`).join('\n');

/** ctx.ts with one exact substring replaced; throws if the substring is absent, so a stale mutation cannot pass silently. */
function mutate(from: string, to: string): string {
  assert.ok(CTX_SOURCE.includes(from), `ctx.ts no longer contains ${from}`);
  return CTX_SOURCE.replace(from, to);
}

// ---------- tests ----------

describe('ctx registry contract', () => {
  const real = checkContract();

  it('every sig in the real ctx.ts compiles against its interface member', () => {
    assert.deepEqual(failingMembers(real), [], explain(real));
  });

  it('the real ctx.ts fails only on the known drift, word for word', () => {
    assert.deepEqual(real.failures, [
      { member: 'seed.fixtures', message: '[string].[]: sig documents Row, interface has Readonly<Record<string, Value>>' },
    ]);
  });

  it('covers every snippet kind', () => {
    assert.deepEqual(real.kinds.map((k) => k.kind), ['handler', 'job', 'seed', 'grader', 'client', 'test']);
  });

  it('interface members and registry entries match per kind', () => {
    const expected: Record<string, string[]> = {
      handler: ['params', 'query', 'body', 'db', 'now', 'time', 'fail'],
      job: ['db', 'now', 'time'],
      seed: ['rng', 'pick', 'int', 'rows', 'fixtures', 'now', 'time'],
      grader: ['db', 'seed', 'changes', 'guardChanges', 'trace', 'goal', 'guard', 'score', 'now', 'time'],
      client: ['api', 'assert', 'now'],
      test: ['advance', 'api', 'assert', 'now'],
    };
    for (const k of real.kinds) {
      assert.deepEqual(k.interfaceMembers, expected[k.kind], `${k.kind} interface`);
      assert.deepEqual(k.registryMembers, expected[k.kind], `${k.kind} registry`);
    }
  });
});

describe('ctx registry contract on a drifted copy of ctx.ts', () => {
  it('fails a sig whose return type no longer matches, naming the member', () => {
    const r = checkContract(mutate("rng: { sig: '() => number'", "rng: { sig: '() => string'"));
    assert.deepEqual(failingMembers(r), ['seed.rng']);
  });

  it('fails a sig that documents a narrower return type than the interface', () => {
    const r = checkContract(mutate("const DB_SIG = 'get(entity, id) => Row | null;", "const DB_SIG = 'get(entity, id) => Row;"));
    assert.deepEqual(failingMembers(r), ['handler.db', 'job.db', 'grader.db', 'grader.seed']);
    assert.deepEqual([...new Set(newFailures(r).map((f) => f.message))], [
      'get.return: sig documents Row, interface has Row | null',
    ]);
  });

  it('fails a sig that documents a narrower value type than the interface', () => {
    const r = checkContract(mutate("query: { sig: 'Record<string, string>'", "query: { sig: 'Record<string, \"asc\" | \"desc\">'"));
    assert.deepEqual(newFailures(r), [
      { member: 'handler.query', message: '[string]: sig documents "asc" | "desc", interface has string' },
    ]);
  });

  it('fails a sig that drops a parameter', () => {
    const r = checkContract(mutate("int: { sig: '(lo, hi) => number'", "int: { sig: '(lo) => number'"));
    assert.deepEqual(failingMembers(r), ['seed.int']);
    assert.deepEqual(newFailures(r).map((f) => f.message), ['sig takes 1 parameter(s), interface takes 2']);
  });

  it('fails every member that shares a drifted sig constant', () => {
    const r = checkContract(mutate('create(entity, data) => Row', 'create(entity, data) => string'));
    assert.deepEqual(failingMembers(r), ['handler.db', 'job.db']);
  });

  it('fails a sig that documents a method the interface lacks', () => {
    const r = checkContract(
      mutate("const DB_SIG = 'get(entity, id)", "const DB_SIG = 'count(entity) => number; get(entity, id)"),
    );
    assert.deepEqual(failingMembers(r), ['handler.db', 'job.db', 'grader.db', 'grader.seed']);
    assert.deepEqual([...new Set(newFailures(r).map((f) => f.message))], [
      'count: sig documents a member the interface does not have',
    ]);
  });

  it('fails a sig whose return shape documents a field the interface lacks', () => {
    const r = checkContract(mutate("=> { status, body }'", "=> { status, body, headers }'"));
    assert.deepEqual(newFailures(r), [
      { member: 'client.api', message: 'return.headers: sig documents a member the interface does not have' },
      { member: 'test.api', message: 'return.headers: sig documents a member the interface does not have' },
    ]);
  });

  it('fails a sig whose array element shape documents a field the interface lacks', () => {
    const r = checkContract(mutate('{ entity, id, kind, fields, origin }[]', '{ entity, id, kind, fields, origin, at }[]'));
    assert.deepEqual(newFailures(r), [
      { member: 'grader.changes', message: 'return.[].at: sig documents a member the interface does not have' },
    ]);
  });

  it('fails a sig that widens a typed parameter', () => {
    const r = checkContract(mutate("'(status: 400 | 404 | 409 | 422, code,", "'(status: number, code,"));
    assert.deepEqual(newFailures(r), [
      { member: 'handler.fail', message: '(status): sig documents number, interface has ErrorStatus' },
    ]);
  });

  it('fails a sig that narrows a typed parameter', () => {
    const r = checkContract(mutate("'(status: 400 | 404 | 409 | 422, code,", "'(status: 400 | 404, code,"));
    assert.deepEqual(newFailures(r), [
      { member: 'handler.fail', message: '(status): sig documents 400 | 404, interface has ErrorStatus' },
    ]);
  });

  it('fails a method parameter that narrows in a shared sig constant', () => {
    const r = checkContract(mutate('plus(iso, "15m") => iso', 'plus(iso, d: "15m" | "1h") => iso'));
    assert.deepEqual(failingMembers(r), ['handler.time', 'job.time', 'seed.time', 'grader.time']);
    assert.deepEqual([...new Set(newFailures(r).map((f) => f.message))], [
      'plus.(d): sig documents "15m" | "1h", interface has string',
    ]);
  });

  it('fails a sig that marks a required parameter optional', () => {
    const r = checkContract(mutate("const ASSERT = { sig: '(condition, message)", "const ASSERT = { sig: '(condition, message?)"));
    assert.deepEqual(newFailures(r), [
      { member: 'client.assert', message: '(message): sig marks it optional, interface requires it' },
      { member: 'test.assert', message: '(message): sig marks it optional, interface requires it' },
    ]);
  });

  it('fails a parameter shape that documents a field the interface lacks', () => {
    const r = checkContract(mutate('list(entity, { where? })', 'list(entity, { where?, limit? })'));
    assert.deepEqual(failingMembers(r), ['handler.db', 'job.db', 'grader.db', 'grader.seed']);
    assert.deepEqual([...new Set(newFailures(r).map((f) => f.message))], [
      'list.(q).limit: sig documents a member the interface does not have',
    ]);
  });

  it('fails a parameter shape that leaves out an optional field the interface has', () => {
    const r = checkContract(mutate("'({ ignore?: entity[], includeJobs?: boolean }?)", "'({ ignore?: entity[] }?)"));
    assert.deepEqual(newFailures(r), [
      { member: 'grader.changes', message: '(opts).includeJobs: sig leaves out a member the interface has' },
    ]);
  });

  it('fails a shared parameter shape that leaves out every field, on each member that uses it', () => {
    const r = checkContract(mutate('list(entity, { where? })', 'list(entity, {})'));
    assert.deepEqual(failingMembers(r), ['handler.db', 'job.db', 'grader.db', 'grader.seed']);
    assert.deepEqual([...new Set(newFailures(r).map((f) => f.message))], [
      'list.(q).where: sig leaves out a member the interface has',
    ]);
  });

  it('fails a return shape when the interface gains an optional field the sig leaves out', () => {
    const r = checkContract(
      mutate('{ status: number; body: unknown };\n  assert', '{ status: number; body: unknown; headers?: Record<string, string> };\n  assert'),
    );
    assert.deepEqual(newFailures(r), [
      { member: 'client.api', message: 'return.headers: sig leaves out a member the interface has' },
      { member: 'test.api', message: 'return.headers: sig leaves out a member the interface has' },
    ]);
  });

  it('fails an interface member that has no registry entry', () => {
    const r = checkContract(mutate("  int: { sig: '(lo, hi) => number', doc: 'Seeded integer in [lo, hi].' },\n", ''));
    assert.deepEqual(newFailures(r), [{ member: 'seed.int', message: 'interface member has no registry entry' }]);
  });
});
