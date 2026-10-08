/**
 * Architecture rules, part A: import boundaries and model routes.
 *
 * Each import rule reads resolved imports and re-export edges from the TypeScript compiler
 * API (never a regex over source text) and returns its violations as `<file> -> <specifier>`,
 * sorted. The model-route rule reads the AST and returns `<file>:<line> <what>`. Every rule
 * has one case over the real source tree and one virtual fixture proving it fires.
 * The symbol, brand and switch rules are part B.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import {
  CODE_ROOT,
  VIRTUAL_ROOT,
  importsOf,
  programFromFiles,
  programFromTree,
  reexportsOf,
  sourceFilesUnder,
  type ImportRef,
} from './helpers/ts-program.ts';

type Rule = (program: ts.Program, root: string) => string[];

const ENGINE_SHELL = new Set(['src/engine/index.ts', 'src/engine/sandbox.ts', 'src/engine/http.ts']);
/** Types from llm.ts that carry no model. Any other import of llm.ts needs run.ts or cli/. */
const LLM_DATA_TYPES = new Set(['Usage']);
/** dataset/ is a shell layer (fs, sandboxes) that receives its solver as an injected `Model` (A-80): a type-only import of these, never a transport. */
const DATASET_LLM_TYPES = new Set(['Model', 'Usage']);
const isDataset = (file: string): boolean => file.startsWith('src/dataset/');
const SDK = '@anthropic-ai/sdk';
const BOAT_SDK = '@boatdev/sdk';
const LLM = 'src/worldgen/llm.ts';

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** Each import of each file under `dirs` (src/ by default), with paths relative to root. */
function srcImports(program: ts.Program, root: string, dirs: readonly string[] = ['src']): { from: string; target: string | undefined; ref: ImportRef }[] {
  const out: { from: string; target: string | undefined; ref: ImportRef }[] = [];
  for (const sf of dirs.flatMap((dir) => sourceFilesUnder(program, root, dir))) {
    const from = toPosix(path.relative(root, sf.fileName));
    for (const ref of importsOf(program, sf)) {
      // An unresolved relative import still names a path, so a deep import of a missing file counts.
      const abs = ref.resolved ?? (ref.specifier.startsWith('.') ? path.resolve(path.dirname(sf.fileName), ref.specifier) : undefined);
      out.push({ from, target: abs === undefined ? undefined : toPosix(path.relative(root, abs)), ref });
    }
  }
  return out;
}

const fmt = (from: string, ref: ImportRef): string => `${from} -> ${ref.specifier}`;
const nodeName = (spec: string): string => (spec.startsWith('node:') ? spec.slice('node:'.length) : spec);
const isNodeBuiltin = (spec: string): boolean => spec.startsWith('node:') || isBuiltin(spec);
const isCli = (file: string): boolean => path.posix.dirname(file) === 'src/cli' && file.endsWith('.ts');

/** Names an import brings in: `all` for a namespace, star or dynamic import, else the imported names. */
type Names = 'all' | ReadonlySet<string>;
const namesOf = (ref: ImportRef): Names => (ref.names.includes('*') ? 'all' : new Set(ref.names));

/** A file that re-exported names arrive at, and whether every hop on the way was type-only. */
type Hit = { readonly file: string; readonly names: Names; readonly typeOnly: boolean };

/**
 * Every file reached by following the re-export edges of `start` for `names`, transitively.
 * Edges `stop` accepts are not followed. Declaration files and missing files end a chain.
 */
function reexportHits(program: ts.Program, root: string, start: string, names: Names, typeOnly: boolean, stop: (ref: ImportRef) => boolean): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const go = (abs: string, want: Names, typed: boolean): void => {
    const key = `${abs}|${typed}|${want === 'all' ? '*' : [...want].sort().join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    const sf = program.getSourceFile(abs);
    if (sf === undefined || sf.isDeclarationFile) return;
    for (const { ref, names: map } of reexportsOf(program, sf)) {
      if (ref.resolved === undefined || stop(ref)) continue;
      let next: Names;
      if (map === '*') next = want === 'all' ? 'all' : new Set([...want].filter((n) => n !== 'default'));
      else {
        const picked = new Set<string>();
        let whole = false;
        for (const [exported, source] of map) {
          if (want !== 'all' && !want.has(exported)) continue;
          if (source === '*') whole = true;
          else picked.add(source);
        }
        next = whole ? 'all' : picked;
      }
      if (next !== 'all' && next.size === 0) continue;
      const nextTyped = typed || ref.typeOnly;
      hits.push({ file: toPosix(path.relative(root, ref.resolved)), names: next, typeOnly: nextTyped });
      go(ref.resolved, next, nextTyped);
    }
  };
  go(start, names, typeOnly);
  return hits;
}

/** The names of `want` that the module at `rel` really exports; `all` means the whole module. */
function exportedOf(program: ts.Program, root: string, rel: string, want: Names): Names {
  if (want === 'all') return 'all';
  const sf = program.getSourceFile(path.join(root, rel));
  const checker = program.getTypeChecker();
  const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
  const exported = new Set(mod === undefined ? [] : checker.getExportsOfModule(mod).map((s) => s.name));
  return new Set([...want].filter((n) => exported.has(n)));
}
const isEmpty = (names: Names): boolean => names !== 'all' && names.size === 0;

/** Every src file outside the engine reaches it only through `#engine`, directly or through any chain of re-exports. */
const engineBoundary: Rule = (program, root) =>
  srcImports(program, root)
    .filter(({ from, target, ref }) => {
      if (from.startsWith('src/engine/') || ref.specifier === '#engine' || target === undefined) return false;
      if (target.startsWith('src/engine/')) return true;
      if (ref.resolved === undefined) return false;
      return reexportHits(program, root, ref.resolved, namesOf(ref), ref.typeOnly, (r) => r.specifier === '#engine').some(
        (h) => h.file.startsWith('src/engine/') && !isEmpty(exportedOf(program, root, h.file, h.names)));
    })
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

/** True when only model-free data types arrive, on a type-only path. */
const dataTypesOnly = (typeOnly: boolean, names: Names): boolean =>
  typeOnly && names !== 'all' && names.size > 0 && [...names].every((n) => LLM_DATA_TYPES.has(n));

/**
 * Only run.ts and cli/*.ts import llm.ts, directly or through re-exports of another module.
 * A type-only import of model-free data types is allowed; dataset/ may also type-import `Model`.
 */
const llmConfinement: Rule = (program, root) =>
  srcImports(program, root)
    .filter(({ from, target, ref }) => {
      if (from === LLM || from === 'src/worldgen/run.ts' || isCli(from)) return false;
      if (target === LLM) {
        const allowed = isDataset(from) ? DATASET_LLM_TYPES : LLM_DATA_TYPES;
        return !(ref.typeOnly && ref.names.length > 0 && ref.names.every((n) => allowed.has(n)));
      }
      if (ref.resolved === undefined) return false;
      return reexportHits(program, root, ref.resolved, namesOf(ref), ref.typeOnly, () => false).some((h) => {
        if (h.file !== LLM) return false;
        const arrived = exportedOf(program, root, h.file, h.names);
        return !isEmpty(arrived) && !dataTypesOnly(h.typeOnly, arrived);
      });
    })
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

/** Only llm.ts imports the Anthropic SDK. Part of modelConfinement. */
const sdkImports: Rule = (program, root) =>
  srcImports(program, root)
    .filter(({ from, ref }) =>
      (ref.specifier === SDK || ref.specifier.startsWith(`${SDK}/`)) && from !== 'src/worldgen/llm.ts')
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

/** Only boat/client.ts imports the boat.dev SDK. Boat is the only product sandbox, so this is the one door to it. */
const boatSdkConfinement: Rule = (program, root) =>
  srcImports(program, root)
    .filter(({ from, ref }) =>
      (ref.specifier === BOAT_SDK || ref.specifier.startsWith(`${BOAT_SDK}/`)) && from !== 'src/boat/client.ts')
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

/** The raw Boat backend factory: a VM made through it bypasses backendFor and the spend meter. */
const BOAT_BACKEND = 'src/sandboxes/boat.ts';
const BOAT_FACTORY = 'boatBackend';
/** TypeScript outside src/ that can still reach Boat, relative to the code root: the package's scripts and the repo-root scripts. */
const SCRIPT_DIRS = ['scripts', '../scripts'];

/**
 * Only sandboxes/registry.ts imports the raw Boat backend, so every Boat VM, a script's too, is made through backendFor and
 * its meter. It scans src/ and SCRIPT_DIRS, and follows re-export chains. A type or a constant of boat.ts passes: only the
 * factory makes a VM.
 */
const boatBackendConfinement: Rule = (program, root) =>
  srcImports(program, root, ['src', ...SCRIPT_DIRS])
    .filter(({ from, target, ref }) => {
      if (from === 'src/sandboxes/registry.ts' || from === BOAT_BACKEND || target === undefined || ref.typeOnly) return false;
      const factory = (names: Names): boolean => names === 'all' || names.has(BOAT_FACTORY);
      if (target === BOAT_BACKEND) return factory(namesOf(ref));
      return reexportHits(program, root, path.join(root, target), namesOf(ref), false, () => false)
        .some((hit) => hit.file === BOAT_BACKEND && !hit.typeOnly && factory(hit.names));
    })
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

/** Only sandbox.ts imports node:vm. */
const vmConfinement: Rule = (program, root) =>
  srcImports(program, root)
    .filter(({ from, ref }) => isNodeBuiltin(ref.specifier) && nodeName(ref.specifier).split('/')[0] === 'vm' && from !== 'src/engine/sandbox.ts')
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

/** Engine core imports no Node module at all. */
const engineCoreNoNode: Rule = (program, root) =>
  srcImports(program, root)
    .filter(({ from, ref }) => from.startsWith('src/engine/') && !ENGINE_SHELL.has(from) && isNodeBuiltin(ref.specifier))
    .map(({ from, ref }) => fmt(from, ref))
    .sort();

const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
/**
 * Shell files that spawn processes that are not the model: the sandbox CLIs (OpenShell, sbx) and the
 * snippet worker process (YOS-59). They may name child_process; the claude-binary and API-host checks
 * still apply to them (A-57).
 */
const PROCESS_SHELL = new Set(['src/sandboxes/backend.ts', 'src/engine/sandbox.ts']);
/** Call names that run a command: node:child_process and the execa package. */
const SPAWNERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork', 'execa', 'execaSync', 'execaCommand', 'execaCommandSync']);
const ANTHROPIC_HOST = 'api.anthropic.com';

/** The leading text of a command argument: a string literal, or the head of a template. */
function commandText(arg: ts.Expression | undefined): string | undefined {
  if (arg === undefined) return undefined;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) return arg.head.text;
  return undefined;
}
/** True when the command's program is the claude binary, bare or by path. */
const isClaude = (command: string): boolean => path.posix.basename(command.trim().split(/\s+/)[0] ?? '') === 'claude';

/**
 * No grading with a model by another route: outside llm.ts and PROCESS_SHELL, src never names
 * node:child_process (import, require, getBuiltinModule). Outside llm.ts, src never spawns or execs
 * the claude binary and never names the Anthropic API host (fetch, http.request, URL).
 */
const modelRoutes: Rule = (program, root) => {
  const out: { file: string; line: number; what: string }[] = [];
  for (const sf of sourceFilesUnder(program, root, 'src')) {
    const file = toPosix(path.relative(root, sf.fileName));
    if (file === LLM) continue;
    const at = (node: ts.Node, what: string): void => {
      out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, what });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (CHILD_PROCESS.has(node.text) && !PROCESS_SHELL.has(file)) at(node, node.text);
        if (node.text.includes(ANTHROPIC_HOST)) at(node, ANTHROPIC_HOST);
      } else if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const command = commandText(node.arguments[0]);
        if (ts.isIdentifier(callee) && SPAWNERS.has(callee.text) && command !== undefined && isClaude(command)) at(node, 'claude binary');
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.what < b.what ? -1 : a.what > b.what ? 1 : 0)))
    .map((v) => `${v.file}:${v.line} ${v.what}`);
};

/**
 * No grading with a model: only llm.ts reaches the model, by any route. SDK imports come first
 * as `<file> -> <specifier>`, then the other routes as `<file>:<line> <what>`.
 */
const modelConfinement: Rule = (program, root) => [...sdkImports(program, root), ...modelRoutes(program, root)];

let realProgram: ts.Program | undefined;
const real = (): ts.Program => (realProgram ??= programFromTree(CODE_ROOT));
/** The .ts files under a dir of the code root, none when it does not exist. */
const tsFilesIn = (dir: string): string[] => {
  try {
    return readdirSync(path.join(CODE_ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.split(path.sep).includes('node_modules'))
      .map((f) => path.join(CODE_ROOT, dir, f));
  } catch {
    return [];
  }
};
let scriptsProgram: ts.Program | undefined;
/** src/ plus SCRIPT_DIRS, read from disk with code/tsconfig.json's options: tsconfig includes no script dir. */
const realWithScripts = (): ts.Program => (scriptsProgram ??= ts.createProgram({
  rootNames: [...real().getRootFileNames().filter((f) => toPosix(path.relative(CODE_ROOT, f)).startsWith('src/')), ...SCRIPT_DIRS.flatMap(tsFilesIn)],
  options: real().getCompilerOptions(),
}));
const relFiles = (program: ts.Program, root: string): string[] =>
  sourceFilesUnder(program, root, 'src').map((sf) => toPosix(path.relative(root, sf.fileName))).sort();

describe('ts-program helper', () => {
  it('builds the real program from code/tsconfig.json', () => {
    const files = relFiles(real(), CODE_ROOT);
    assert.equal(files.includes('src/worldgen/judge.ts'), true);
    assert.equal(files.includes('src/engine/index.ts'), true);
  });

  it('reads resolved imports of a virtual file, relative to the root', () => {
    const program = programFromFiles({
      'src/engine/index.ts': 'export type CheckReport = { a: 1 };\nexport type CheckIssue = { b: 2 };\n',
      'src/worldgen/plan.ts': 'export type Plan = { c: 3 };\n',
      'src/worldgen/stages.ts': 'export type StageId = 4;\n',
      'src/worldgen/sample.ts': [
        "import type { CheckIssue, CheckReport } from '#engine';",
        "import type { Plan } from './plan.ts';",
        "import type { StageId } from './stages.ts';",
        'export type All = [CheckIssue, CheckReport, Plan, StageId];',
      ].join('\n'),
    });
    const refs = importsOf(program, path.posix.join(VIRTUAL_ROOT, 'src/worldgen/sample.ts')).map((r) => ({
      ...r,
      resolved: r.resolved === undefined ? undefined : path.posix.relative(VIRTUAL_ROOT, r.resolved),
    }));
    assert.deepEqual(refs, [
      { specifier: '#engine', resolved: 'src/engine/index.ts', typeOnly: true, names: ['CheckIssue', 'CheckReport'] },
      { specifier: './plan.ts', resolved: 'src/worldgen/plan.ts', typeOnly: true, names: ['Plan'] },
      { specifier: './stages.ts', resolved: 'src/worldgen/stages.ts', typeOnly: true, names: ['StageId'] },
    ]);
  });

  it('reads every import form from a virtual program and resolves #engine', () => {
    const program = programFromFiles({
      'src/engine/index.ts': 'export const check = 1;\nexport type World = { a: 1 };\n',
      'src/worldgen/a.ts': [
        "import { check as c } from '#engine';",
        "import * as ns from './b.ts';",
        "export type { World } from '#engine';",
        "export * from './b.ts';",
        "type W = import('#engine').World;",
        "export const load = () => import('./b.ts');",
        "import def, { type X } from './b.ts';",
        'export const used = [c, ns, def] as const;',
        'export type T = W | X;',
      ].join('\n'),
      'src/worldgen/b.ts': 'export default 1;\nexport type X = 2;\n',
    });
    const refs = importsOf(program, path.posix.join(VIRTUAL_ROOT, 'src/worldgen/a.ts'));
    assert.deepEqual(refs, [
      { specifier: '#engine', resolved: '/virtual/src/engine/index.ts', typeOnly: false, names: ['check'] },
      { specifier: './b.ts', resolved: '/virtual/src/worldgen/b.ts', typeOnly: false, names: ['*'] },
      { specifier: '#engine', resolved: '/virtual/src/engine/index.ts', typeOnly: true, names: ['World'] },
      { specifier: './b.ts', resolved: '/virtual/src/worldgen/b.ts', typeOnly: false, names: ['*'] },
      { specifier: '#engine', resolved: '/virtual/src/engine/index.ts', typeOnly: true, names: ['World'] },
      { specifier: './b.ts', resolved: '/virtual/src/worldgen/b.ts', typeOnly: false, names: ['*'] },
      { specifier: './b.ts', resolved: '/virtual/src/worldgen/b.ts', typeOnly: false, names: ['default', 'X'] },
    ]);
  });

  it('reads every re-export edge of a virtual file with its name map', () => {
    const program = programFromFiles({
      'src/engine/index.ts': 'export const check = 1;\nexport type World = { a: 1 };\n',
      'src/worldgen/b.ts': 'export const one = 1;\nexport const two = 2;\nexport default 3;\n',
      'src/worldgen/a.ts': [
        "export * from './b.ts';",
        "export * as bee from './b.ts';",
        "export { one as uno, two } from './b.ts';",
        "export type { World } from '#engine';",
        "import { check as c } from '#engine';",
        "import d, * as ns from './b.ts';",
        "import type { World as W } from '#engine';",
        'const local = 1;',
        'export { c as checked, d, ns, local };',
        'export type { W };',
        'export const used = [c, ns, d, local] as const;',
        'export const alias = c, plain = 1;',
        'export default (ns);',
        'const viaLocal = c;',
        'export { viaLocal };',
        'export const viaNs = ns.one;',
        'export const viaWrap = (c as number)!;',
      ].join('\n'),
    });
    const edges = reexportsOf(program, path.posix.join(VIRTUAL_ROOT, 'src/worldgen/a.ts')).map(({ ref, names }) => ({
      specifier: ref.specifier,
      typeOnly: ref.typeOnly,
      names: names === '*' ? '*' : [...names],
    }));
    assert.deepEqual(edges, [
      { specifier: './b.ts', typeOnly: false, names: '*' },
      { specifier: './b.ts', typeOnly: false, names: [['bee', '*']] },
      { specifier: './b.ts', typeOnly: false, names: [['uno', 'one'], ['two', 'two']] },
      { specifier: '#engine', typeOnly: true, names: [['World', 'World']] },
      { specifier: '#engine', typeOnly: false, names: [['checked', 'check']] },
      { specifier: './b.ts', typeOnly: false, names: [['d', 'default'], ['ns', '*']] },
      { specifier: '#engine', typeOnly: true, names: [['W', 'World']] },
      { specifier: '#engine', typeOnly: false, names: [['alias', 'check']] },
      { specifier: './b.ts', typeOnly: false, names: [['default', '*']] },
      { specifier: '#engine', typeOnly: false, names: [['viaLocal', 'check']] },
      { specifier: './b.ts', typeOnly: false, names: [['viaNs', 'one']] },
      { specifier: '#engine', typeOnly: false, names: [['viaWrap', 'check']] },
    ]);
  });
});

describe('rule: src outside the engine imports it only through #engine, re-exports included', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(engineBoundary(real(), CODE_ROOT), []);
  });

  it('fires on deep and relative engine imports in a fixture', () => {
    const program = programFromFiles({
      'src/engine/index.ts': 'export const check = 1;\n',
      'src/engine/check.ts': 'export const deep = 1;\n',
      'src/worldgen/ok.ts': "import { check } from '#engine';\nexport const a = check;\n",
      'src/worldgen/deep.ts': "import { deep } from '../engine/check.ts';\nexport const a = deep;\n",
      'src/worldgen/relindex.ts': "import type { } from '../engine/index.ts';\n",
      'src/cli/world.ts': "export * from '../engine/check.ts';\n",
      'src/cli/missing.ts': "import '../engine/not-yet.ts';\n",
      'src/engine/api.ts': "import { deep } from './check.ts';\nexport const a = deep;\n",
      'test/engine.test.ts': "import { deep } from '../src/engine/check.ts';\nexport const a = deep;\n",
    });
    assert.deepEqual(engineBoundary(program, VIRTUAL_ROOT), [
      'src/cli/missing.ts -> ../engine/not-yet.ts',
      'src/cli/world.ts -> ../engine/check.ts',
      'src/worldgen/deep.ts -> ../engine/check.ts',
      'src/worldgen/relindex.ts -> ../engine/index.ts',
    ]);
  });

  it('fires on src/lib and top-level src files and on importers of re-export bridges in a fixture', () => {
    const program = programFromFiles({
      'src/engine/index.ts': "export { deep as check } from './check.ts';\n",
      'src/engine/check.ts': 'export const deep = 1;\nexport const other = 2;\n',
      'src/lib/reexport.ts': "export * from '../engine/check.ts';\n",
      'src/lib/rename.ts': "import { deep as d } from '../engine/check.ts';\nexport { d as deep2 };\n",
      'src/lib/mixed.ts': "export { deep } from '../engine/check.ts';\nexport const own = 1;\n",
      'src/lib/okbridge.ts': "export * from '#engine';\n",
      'src/top.ts': "import { deep } from './engine/check.ts';\nexport const a = deep;\n",
      'src/worldgen/vialib.ts': "import { deep } from '../lib/reexport.ts';\nexport const a = deep;\n",
      'src/worldgen/hop.ts': "export * from '../lib/rename.ts';\n",
      'src/worldgen/chain.ts': "import { deep2 } from './hop.ts';\nexport const a = deep2;\n",
      'src/worldgen/own.ts': "import { own } from '../lib/mixed.ts';\nexport const a = own;\n",
      'src/worldgen/viaok.ts': "import { check } from '../lib/okbridge.ts';\nexport const a = check;\n",
      'src/cli/viatest.ts': "import * as b from '../../test/helpers/bridge.ts';\nexport const a = b;\n",
      'test/helpers/bridge.ts': "export { other } from '../../src/engine/check.ts';\n",
      'src/lib/value.ts': "import { deep } from '../engine/check.ts';\nexport default deep;\nexport const v = deep;\n",
      'src/worldgen/viadefault.ts': "import d from '../lib/value.ts';\nexport const a = d;\n",
      'src/worldgen/viavalue.ts': "import { v } from '../lib/value.ts';\nexport const a = v;\n",
    });
    assert.deepEqual(engineBoundary(program, VIRTUAL_ROOT), [
      'src/cli/viatest.ts -> ../../test/helpers/bridge.ts',
      'src/lib/mixed.ts -> ../engine/check.ts',
      'src/lib/reexport.ts -> ../engine/check.ts',
      'src/lib/rename.ts -> ../engine/check.ts',
      'src/lib/value.ts -> ../engine/check.ts',
      'src/top.ts -> ./engine/check.ts',
      'src/worldgen/chain.ts -> ./hop.ts',
      'src/worldgen/hop.ts -> ../lib/rename.ts',
      'src/worldgen/viadefault.ts -> ../lib/value.ts',
      'src/worldgen/vialib.ts -> ../lib/reexport.ts',
      'src/worldgen/viavalue.ts -> ../lib/value.ts',
    ]);
  });

  it('fires on importers of test/helpers bridges by local alias, namespace member and wrapped value in a fixture', () => {
    const program = programFromFiles({
      'src/engine/index.ts': 'export const check = 1;\n',
      'src/engine/check.ts': 'export const deep = 1;\n',
      'test/helpers/bridge.ts': [
        "import { deep } from '../../src/engine/check.ts';",
        "import * as eng from '../../src/engine/check.ts';",
        'const alias = deep;',
        'export { alias };',
        'export const viaNs = eng.deep;',
        'export const viaAs = deep satisfies number;',
        'export const computed = deep + 1;',
      ].join('\n'),
      'src/worldgen/alias.ts': "import { alias } from '../../test/helpers/bridge.ts';\nexport const a = alias;\n",
      'src/worldgen/ns.ts': "import { viaNs } from '../../test/helpers/bridge.ts';\nexport const a = viaNs;\n",
      'src/worldgen/as.ts': "import { viaAs } from '../../test/helpers/bridge.ts';\nexport const a = viaAs;\n",
      'src/worldgen/computed.ts': "import { computed } from '../../test/helpers/bridge.ts';\nexport const a = computed;\n",
    });
    assert.deepEqual(engineBoundary(program, VIRTUAL_ROOT), [
      'src/worldgen/alias.ts -> ../../test/helpers/bridge.ts',
      'src/worldgen/as.ts -> ../../test/helpers/bridge.ts',
      'src/worldgen/ns.ts -> ../../test/helpers/bridge.ts',
    ]);
  });
});

describe('rule: only run.ts and cli/ import llm.ts', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(llmConfinement(real(), CODE_ROOT), []);
  });

  it('fires on judge, policy and nested cli importers in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': 'export type Usage = { n: number };\nexport interface Model { go(): void }\nexport const anthropicModel = 1;\n',
      'src/worldgen/run.ts': "import { anthropicModel, type Model } from './llm.ts';\nexport const a: [number, Model?] = [anthropicModel];\n",
      'src/cli/worldgen.ts': "import { anthropicModel } from '../worldgen/llm.ts';\nexport const a = anthropicModel;\n",
      'src/cli/sub/deep.ts': "import { anthropicModel } from '../../worldgen/llm.ts';\nexport const a = anthropicModel;\n",
      'src/worldgen/events.ts': "import type { Usage } from './llm.ts';\nexport type E = Usage;\n",
      'src/worldgen/judge.ts': "import type { Model } from './llm.ts';\nexport type J = Model;\n",
      'src/worldgen/policy.ts': "import { anthropicModel } from './llm.ts';\nexport const a = anthropicModel;\n",
      'src/worldgen/report.ts': "export type { Usage, Model } from './llm.ts';\n",
      'test/worldgen.test.ts': "import type { Model } from '../src/worldgen/llm.ts';\nexport type F = Model;\n",
    });
    assert.deepEqual(llmConfinement(program, VIRTUAL_ROOT), [
      'src/cli/sub/deep.ts -> ../../worldgen/llm.ts',
      'src/worldgen/judge.ts -> ./llm.ts',
      'src/worldgen/policy.ts -> ./llm.ts',
      'src/worldgen/report.ts -> ./llm.ts',
    ]);
  });

  it('lets dataset/ type-import Model but never a transport value, in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': 'export type Usage = { n: number };\nexport interface Model { go(): void }\nexport const anthropicModel = 1;\n',
      'src/dataset/solver.ts': "import type { Model } from '../worldgen/llm.ts';\nexport type S = Model;\n",
      'src/dataset/pipeline.ts': "import { anthropicModel } from '../worldgen/llm.ts';\nexport const a = anthropicModel;\n",
      'src/dataset/store.ts': "import { type Model } from '../worldgen/llm.ts';\nexport type S = Model;\n",
    });
    assert.deepEqual(llmConfinement(program, VIRTUAL_ROOT), [
      'src/dataset/pipeline.ts -> ../worldgen/llm.ts',
      'src/dataset/store.ts -> ../worldgen/llm.ts',
    ]);
  });

  it('fires on importers that reach llm.ts through re-exports of run.ts or cli/ in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': 'export type Usage = { n: number };\nexport interface Model { go(): void }\nexport const anthropicModel = 1;\n',
      'src/worldgen/run.ts': [
        "import { anthropicModel as m } from './llm.ts';",
        "export { anthropicModel } from './llm.ts';",
        "export type { Usage } from './llm.ts';",
        'export const runOwn = 1;',
        'export { m as model };',
      ].join('\n'),
      'src/cli/bridge.ts': "export * from '../worldgen/llm.ts';\n",
      'src/worldgen/judge.ts': "import { anthropicModel } from './run.ts';\nexport const a = anthropicModel;\n",
      'src/worldgen/policy.ts': "import { model } from './run.ts';\nexport const a = model;\n",
      'src/worldgen/input.ts': "import * as run from './run.ts';\nexport const a = run;\n",
      'src/worldgen/config.ts': "import type { Model } from '../cli/bridge.ts';\nexport type C = Model;\n",
      'src/worldgen/stages.ts': "import { runOwn } from './run.ts';\nexport const a = runOwn;\n",
      'src/worldgen/plan.ts': "import type { Usage } from './run.ts';\nexport type P = Usage;\n",
      'src/worldgen/events.ts': "import type { Usage } from '../cli/bridge.ts';\nexport type E = Usage;\n",
    });
    assert.deepEqual(llmConfinement(program, VIRTUAL_ROOT), [
      'src/worldgen/config.ts -> ../cli/bridge.ts',
      'src/worldgen/input.ts -> ./run.ts',
      'src/worldgen/judge.ts -> ./run.ts',
      'src/worldgen/policy.ts -> ./run.ts',
    ]);
  });

  it('fires on importers that reach llm.ts through export default or an exported const of run.ts in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': 'export type Usage = { n: number };\nexport interface Model { go(): void }\nexport const anthropicModel = 1;\n',
      'src/worldgen/run.ts': [
        "import { anthropicModel } from './llm.ts';",
        'export default anthropicModel;',
        'export const m = anthropicModel, own = 1;',
      ].join('\n'),
      'src/worldgen/judge.ts': "import d from './run.ts';\nexport const a = d;\n",
      'src/worldgen/policy.ts': "import { m } from './run.ts';\nexport const a = m;\n",
      'src/worldgen/stages.ts': "import { own } from './run.ts';\nexport const a = own;\n",
    });
    assert.deepEqual(llmConfinement(program, VIRTUAL_ROOT), ['src/worldgen/judge.ts -> ./run.ts', 'src/worldgen/policy.ts -> ./run.ts']);
  });

  it('fires on importers that reach llm.ts through a local alias, a namespace member or a wrapped value of run.ts in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': 'export type Usage = { n: number };\nexport interface Model { go(): void }\nexport const anthropicModel = 1;\n',
      'src/worldgen/run.ts': [
        "import { anthropicModel } from './llm.ts';",
        "import * as llm from './llm.ts';",
        'const alias = anthropicModel;',
        'export { alias };',
        'export const viaNs = llm.anthropicModel;',
        'export const viaAs = (anthropicModel as number)!;',
        'export const computed = anthropicModel + 1;',
      ].join('\n'),
      'src/worldgen/judge.ts': "import { alias } from './run.ts';\nexport const a = alias;\n",
      'src/worldgen/policy.ts': "import { viaNs } from './run.ts';\nexport const a = viaNs;\n",
      'src/worldgen/stages.ts': "import { viaAs } from './run.ts';\nexport const a = viaAs;\n",
      'src/worldgen/plan.ts': "import { computed } from './run.ts';\nexport const a = computed;\n",
    });
    assert.deepEqual(llmConfinement(program, VIRTUAL_ROOT), [
      'src/worldgen/judge.ts -> ./run.ts',
      'src/worldgen/policy.ts -> ./run.ts',
      'src/worldgen/stages.ts -> ./run.ts',
    ]);
  });
});

describe('rule: only llm.ts reaches the model, by the SDK, child_process, the claude binary or the API host', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(modelConfinement(real(), CODE_ROOT), []);
  });

  it('fires on the SDK and its subpaths outside llm.ts in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;\n",
      'src/worldgen/run.ts': "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;\n",
      'src/worldgen/judge.ts': "import type { Message } from '@anthropic-ai/sdk/resources';\nexport type M = Message;\n",
      'src/engine/tasks.ts': "export const load = () => import('@anthropic-ai/sdk');\n",
      'src/worldgen/other.ts': "import x from '@anthropic-ai/sdk-extra';\nexport const a = x;\n",
      'test/worldgen.test.ts': "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;\n",
    });
    assert.deepEqual(modelConfinement(program, VIRTUAL_ROOT), [
      'src/engine/tasks.ts -> @anthropic-ai/sdk',
      'src/worldgen/judge.ts -> @anthropic-ai/sdk/resources',
      'src/worldgen/run.ts -> @anthropic-ai/sdk',
    ]);
  });

  it('lets the sandbox process shell import child_process but still fires on claude spawns there', () => {
    const program = programFromFiles({
      'src/sandboxes/backend.ts': [
        "import { spawn } from 'node:child_process';",
        "export const up = () => spawn('sbx', ['create']);",
        "export const bad = () => spawn('claude', ['-p']);",
      ].join('\n'),
      'src/sandboxes/sbx.ts': "import { spawn } from 'node:child_process';\nexport const a = spawn('sbx', []);\n",
    });
    assert.deepEqual(modelConfinement(program, VIRTUAL_ROOT), [
      'src/sandboxes/backend.ts:3 claude binary',
      'src/sandboxes/sbx.ts:1 node:child_process',
    ]);
  });

  it('fires on child_process, claude spawns and api.anthropic.com outside llm.ts in a fixture', () => {
    const program = programFromFiles({
      'src/worldgen/llm.ts': [
        "import { spawn } from 'node:child_process';",
        "export const run = () => spawn('claude', ['-p']);",
        "export const BASE = 'https://api.anthropic.com';",
      ].join('\n'),
      'src/worldgen/judge.ts': [
        "import { execFileSync } from 'node:child_process';",
        "export const grade = (w: string) => execFileSync('claude', ['-p', w]);",
      ].join('\n'),
      'src/worldgen/policy.ts': "export const ask = () => fetch('https://api.anthropic.com/v1/messages');\n",
      'src/cli/eval.ts': [
        "import cp from 'child_process';",
        "export const r = cp.exec('claude -p hi');",
        "export const s = cp.spawn('/usr/local/bin/claude', []);",
        "export const ok = cp.spawn('git', ['status']);",
      ].join('\n'),
      'src/engine/tasks.ts': [
        'declare const process: { getBuiltinModule(id: string): unknown };',
        "export const m = process.getBuiltinModule('node:child_process');",
        "export const host = { hostname: 'api.anthropic.com' };",
      ].join('\n'),
      'src/worldgen/run.ts': [
        'declare function execa(cmd: string, args: string[]): unknown;',
        "export const x = (p: string) => execa(`claude`, ['-p', p]);",
        'export const y = (p: string) => execa(`claude -p ${p}`, []);',
        "export const z = (p: string) => execa('claudette', [p]);",
      ].join('\n'),
      'src/worldgen/report.ts': "import Anthropic from '@anthropic-ai/sdk';\nexport const a = Anthropic;\n",
      'test/llm.test.ts': "import { spawn } from 'node:child_process';\nexport const a = spawn('claude', []);\n",
    });
    assert.deepEqual(modelConfinement(program, VIRTUAL_ROOT), [
      'src/worldgen/report.ts -> @anthropic-ai/sdk',
      'src/cli/eval.ts:1 child_process',
      'src/cli/eval.ts:2 claude binary',
      'src/cli/eval.ts:3 claude binary',
      'src/engine/tasks.ts:2 node:child_process',
      'src/engine/tasks.ts:3 api.anthropic.com',
      'src/worldgen/judge.ts:1 node:child_process',
      'src/worldgen/judge.ts:2 claude binary',
      'src/worldgen/policy.ts:1 api.anthropic.com',
      'src/worldgen/run.ts:2 claude binary',
      'src/worldgen/run.ts:3 claude binary',
    ]);
  });
});

describe('rule: only boat/client.ts imports @boatdev/sdk', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(boatSdkConfinement(real(), CODE_ROOT), []);
  });

  it('fires on the boat SDK and its subpaths outside boat/client.ts in a fixture', () => {
    const program = programFromFiles({
      'src/boat/client.ts': "import { BoatApi } from '@boatdev/sdk';\nexport const a = BoatApi;\n",
      'src/sandboxes/boat.ts': "import { BoatApi } from '@boatdev/sdk';\nexport const a = BoatApi;\n",
      'src/cli/sandbox.ts': "import type { Sandbox } from '@boatdev/sdk/dist/models';\nexport type S = Sandbox;\n",
      'src/engine/http.ts': "export const load = () => import('@boatdev/sdk');\n",
      'src/worldgen/run.ts': "export * from '@boatdev/sdk';\n",
      'src/boat/other.ts': "import x from '@boatdev/sdk-extra';\nexport const a = x;\n",
      'test/boat.test.ts': "import { BoatApi } from '@boatdev/sdk';\nexport const a = BoatApi;\n",
    });
    assert.deepEqual(boatSdkConfinement(program, VIRTUAL_ROOT), [
      'src/cli/sandbox.ts -> @boatdev/sdk/dist/models',
      'src/engine/http.ts -> @boatdev/sdk',
      'src/sandboxes/boat.ts -> @boatdev/sdk',
      'src/worldgen/run.ts -> @boatdev/sdk',
    ]);
  });
});

describe('rule: only sandboxes/registry.ts imports the raw Boat backend', () => {
  it('passes on the real source tree and its scripts, and the scan reaches code/scripts', () => {
    const program = realWithScripts();
    assert.equal(sourceFilesUnder(program, CODE_ROOT, 'scripts').some((sf) => toPosix(sf.fileName).endsWith('/code/scripts/boat-ci.ts')), true);
    assert.deepEqual(boatBackendConfinement(program, CODE_ROOT), []);
  });

  it('fires on the factory outside registry.ts, in src and in both script dirs, directly or through a re-export, in a fixture', () => {
    const boat = "export type BoatDeps = { readonly n: number };\nexport const BOAT_WORKDIR = '/tmp/worldgen';\nexport function boatBackend(): number { return 1; }\n";
    const program = programFromFiles({
      'src/sandboxes/boat.ts': boat,
      'src/sandboxes/registry.ts': "import { boatBackend } from './boat.ts';\nexport const a = boatBackend;\n",
      'scripts/boat-ci.ts': "import { boatBackend } from '../src/sandboxes/boat.ts';\nexport const a = boatBackend;\n",
      'src/cli/sandbox.ts': "import * as boat from '../sandboxes/boat.ts';\nexport const a = boat;\n",
      'src/dataset/pipeline.ts': "export const load = () => import('../sandboxes/boat.ts');\n",
      'src/sandboxes/index.ts': "export { boatBackend } from './boat.ts';\n",
      'scripts/via-index.ts': "import { boatBackend } from '../src/sandboxes/index.ts';\nexport const a = boatBackend;\n",
      '../scripts/root-tool.ts': "import { boatBackend } from '../virtual/src/sandboxes/boat.ts';\nexport const a = boatBackend;\n",
      'src/worldgen/typed.ts': "import type { BoatDeps } from '../sandboxes/boat.ts';\nexport type D = BoatDeps;\n",
      'scripts/constant.ts': "import { BOAT_WORKDIR } from '../src/sandboxes/boat.ts';\nexport const a = BOAT_WORKDIR;\n",
      'test/boat.test.ts': "import { boatBackend } from '../src/sandboxes/boat.ts';\nexport const a = boatBackend;\n",
    });
    assert.deepEqual(boatBackendConfinement(program, VIRTUAL_ROOT), [
      '../scripts/root-tool.ts -> ../virtual/src/sandboxes/boat.ts',
      'scripts/boat-ci.ts -> ../src/sandboxes/boat.ts',
      'scripts/via-index.ts -> ../src/sandboxes/index.ts',
      'src/cli/sandbox.ts -> ../sandboxes/boat.ts',
      'src/dataset/pipeline.ts -> ../sandboxes/boat.ts',
      'src/sandboxes/index.ts -> ./boat.ts',
    ]);
  });
});

describe('rule: only sandbox.ts imports node:vm', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(vmConfinement(real(), CODE_ROOT), []);
  });

  it('fires on node:vm and vm outside sandbox.ts in a fixture', () => {
    const program = programFromFiles({
      'src/engine/sandbox.ts': "import { createContext } from 'node:vm';\nexport const a = createContext;\n",
      'src/engine/index.ts': "import { runInNewContext } from 'node:vm';\nexport const a = runInNewContext;\n",
      'src/worldgen/run.ts': "import vm from 'vm';\nexport const a = vm;\n",
      'src/cli/world.ts': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n",
      'test/sandbox.test.ts': "import vm from 'node:vm';\nexport const a = vm;\n",
    });
    assert.deepEqual(vmConfinement(program, VIRTUAL_ROOT), [
      'src/engine/index.ts -> node:vm',
      'src/worldgen/run.ts -> vm',
    ]);
  });
});

describe('rule: engine core imports no node: module', () => {
  it('passes on the real source tree', () => {
    assert.deepEqual(engineCoreNoNode(real(), CODE_ROOT), []);
  });

  it('fires on node builtins in engine core but not in the shell files in a fixture', () => {
    const program = programFromFiles({
      'src/engine/index.ts': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n",
      'src/engine/sandbox.ts': "import { createContext } from 'node:vm';\nexport const a = createContext;\n",
      'src/engine/http.ts': "import { createServer } from 'node:http';\nexport const a = createServer;\n",
      'src/engine/store.ts': "import { randomUUID } from 'node:crypto';\nexport const a = randomUUID;\n",
      'src/engine/clock.ts': "import { setTimeout } from 'timers/promises';\nexport const a = setTimeout;\n",
      'src/engine/nested/deep.ts': "import type { Context } from 'node:vm';\nexport type C = Context;\n",
      'src/engine/fields.ts': "import { z } from 'zod';\nexport const a = z;\n",
      'src/worldgen/config.ts': "import { readFileSync } from 'node:fs';\nexport const a = readFileSync;\n",
    });
    assert.deepEqual(engineCoreNoNode(program, VIRTUAL_ROOT), [
      'src/engine/clock.ts -> timers/promises',
      'src/engine/nested/deep.ts -> node:vm',
      'src/engine/store.ts -> node:crypto',
    ]);
  });
});

describe('module map covers src', () => {
  const REPO = path.join(CODE_ROOT, '..');
  const srcFiles = (): string[] =>
    readdirSync(path.join(CODE_ROOT, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map(toPosix)
      .sort();

  /** Files of `files` that neither a backticked `dir/file.ts` nor a `dir/*.ts` row in the AGENTS.md module map names. */
  const missingFromAgents = (files: string[], agents: string): string[] =>
    files.filter((f) => !agents.includes(`\`${f}\``) && !agents.includes(`\`${path.posix.dirname(f)}/*.ts\``));

  /** Files whose basename is absent from the `src/<dir>/` line of the architecture.md directory tree. */
  const missingFromTree = (files: string[], arch: string): string[] =>
    files.filter((f) => {
      const dir = path.posix.dirname(f);
      const line = arch.split('\n').find((l) => l.includes(`src/${dir}/`));
      const words = new Set((line ?? '').split(/[^a-z0-9-]+/));
      return !words.has(path.posix.basename(f, '.ts'));
    });

  it('AGENTS.md names every src module', () => {
    assert.deepEqual(missingFromAgents(srcFiles(), readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8')), []);
  });

  it('research/architecture.md directory tree lists every src module', () => {
    assert.deepEqual(missingFromTree(srcFiles(), readFileSync(path.join(REPO, 'research/architecture.md'), 'utf8')), []);
  });

  it('fires on a module missing from either map in a fixture', () => {
    const files = ['engine/api.ts', 'cli/dataset.ts', 'dataset/store.ts'];
    assert.deepEqual(missingFromAgents(files, '`engine/api.ts` `dataset/*.ts`'), ['cli/dataset.ts']);
    assert.deepEqual(missingFromTree(files, 'src/engine/ api  src/cli/ worldgen\n src/dataset/ store'), ['cli/dataset.ts']);
  });
});
