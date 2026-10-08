/**
 * The engine CLI. Argument parsing and printing only; every decision lives in #engine.
 * Exit codes: 0 ok, 1 the world has errors (or a task, grade or server failed), 2 bad usage.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  checkWorld, gradeDump, loadWorld, openapiConformance, openapiEvidence, proofOf, refusedConformance, serve, worldFormatDoc,
  type CheckIssue, type CheckLayer, type CheckReport, type DumpInput, type GradedDump, type TaskVerdict, type WorldServer,
} from '#engine';
import { projectionText, renderOpenapiConformance } from '../worldgen/openapi-report.ts';

const USAGE = `usage: worldplay <command> [args]

commands:
  check <dir> [--json]                 check <dir>/world.yaml and print every issue with its line;
                                       --json prints {ok, reached, issues}
  serve <dir> [--port 4000] [--admin-port <n>] [--host 127.0.0.1] [--admin-host 127.0.0.1]
                                       check, then serve the world's API on --port and the /_world
                                       admin routes on --admin-port (default port + 1) until Ctrl-C;
                                       --port 0 lets the OS pick both ports (the admin port too, unless given);
                                       once both listen it prints one line {"listening":{"world":<port>,"admin":<port>}},
                                       then the world, admin and console URLs;
                                       the admin port also serves the operator console at /;
                                       --admin-host defaults to 127.0.0.1 even when --host is public;
                                       env WORLDPLAY_HOST and WORLDPLAY_ADMIN_HOST set the defaults
  verify <dir> [--json]                check, then print each task's verdict: solution, noop, decoys, prefix;
                                       --json prints one proof object per task instead
  openapi <dir> --spec <file> [--only <prefix,...>] [--json] [--profile]
          [--exact] [--require <feature,...>] [--report <new-file>]
                                       compare under worldgen.openapi.normalized.v1, never exact equivalence;
                                       --json retains the issue array; --json --profile prints versioned evidence;
                                       --profile alone prints the Markdown profile and disclosures;
                                       --exact and unsupported --require features refuse with exit 1,
                                       before the world or source is read;
                                       --report writes a new Markdown audit, never overwrites a file
  grade <dir> <task> --state <file>    score a state dump (GET /_world/state) for one task
  docs [--out <file>]                  write the world format reference (default ../prod/world-format.md)
`;

const DEFAULT_PORT = 4000;
const DEFAULT_DOCS = path.resolve(import.meta.dirname, '../../../prod/world-format.md');

const WORLD_FILE = 'world.yaml';

/**
 * `<file>:<line>: <severity> <code> <path joined by .>: expected <expected>, found <found>. <hint>`.
 * The `<file>:<line>: ` prefix is there when the issue carries a line.
 */
export function formatIssue(i: CheckIssue): string {
  const where = i.line === undefined ? '' : `${i.file ?? WORLD_FILE}:${i.line}: `;
  return `${where}${i.severity} ${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}`;
}

/** One issue in `check --json`: where (file, line, path), what (code, severity) and how to fix it. */
function jsonIssue(i: CheckIssue): Record<string, unknown> {
  return {
    file: i.file ?? WORLD_FILE,
    line: i.line ?? null,
    path: i.path,
    code: i.code,
    severity: i.severity,
    ...(i.span ? { span: i.span } : {}),
    expected: i.expected,
    found: i.found,
    hint: i.hint,
  };
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function usageError(message: string): number {
  process.stderr.write(`${message}\n${USAGE}`);
  return 2;
}

/** A failure that is not about the world's content: one line on stderr, exit 1. */
function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function printIssues(issues: readonly CheckIssue[]): void {
  if (issues.length > 0) process.stdout.write(`${issues.map(formatIssue).join('\n')}\n`);
}

/** Runs node:util parseArgs, turning its usage errors into a message. */
function tryParse<T>(parse: () => T): T | string {
  try {
    return parse();
  } catch (e) {
    return messageOf(e);
  }
}

/** A port flag's value, or a usage message. */
function portOf(flag: string, raw: string): number | string {
  return /^\d+$/.test(raw) && Number(raw) <= 65535 ? Number(raw) : `${flag} must be a whole number from 0 to 65535, got ${raw}`;
}

type Checked = { readonly reached: CheckLayer; readonly issues: readonly CheckIssue[]; readonly report: CheckReport | null };

/** Loads and checks <dir>. A world that does not load stops before the schema layer; an accepted one passed every layer. */
async function checkDir(dir: string): Promise<Checked> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) return { reached: 'schema', issues: loaded.error, report: null };
  const report = checkWorld(loaded.value, loaded.lines);
  return report.ok
    ? { reached: 'lints', issues: report.warnings, report }
    : { reached: report.reached, issues: [...report.issues, ...report.warnings], report };
}

const checkJsonOf = (c: Checked): string =>
  JSON.stringify({ ok: !c.issues.some((i) => i.severity === 'error'), reached: c.reached, issues: c.issues.map(jsonIssue) }, null, 2);

/**
 * Checks <dir>. When the world is not acceptable, prints its errors and warnings on stdout, as
 * the `check --json` document when `json` is set, and returns null. Warnings of an acceptable
 * world go to stderr, so stdout stays the command's own output.
 */
async function loadChecked(dir: string, json = false): Promise<Extract<CheckReport, { ok: true }> | null> {
  const c = await checkDir(dir);
  if (c.report === null || !c.report.ok) {
    process.stdout.write(json ? `${checkJsonOf(c)}\n` : `${c.issues.map(formatIssue).join('\n')}\n`);
    return null;
  }
  if (c.issues.length > 0) process.stderr.write(`${c.issues.map(formatIssue).join('\n')}\n`);
  return c.report;
}

async function check(args: readonly string[]): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  const flag = rest.find((a) => a.startsWith('--'));
  if (flag !== undefined) return usageError(`unknown option ${flag}`);
  const [dir, ...extra] = rest;
  if (dir === undefined || extra.length > 0) return usageError('check takes exactly one <dir>');

  const c = await checkDir(dir);
  const failed = c.issues.some((i) => i.severity === 'error');
  if (json) process.stdout.write(`${checkJsonOf(c)}\n`);
  else if (c.issues.length === 0) process.stdout.write('ok\n');
  else process.stdout.write(`${c.issues.map(formatIssue).join('\n')}\n`);
  return failed ? 1 : 0;
}

/** Resolves on the first SIGINT or SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      resolve();
    };
    process.on('SIGINT', done);
    process.on('SIGTERM', done);
  });
}

async function serveCommand(args: readonly string[]): Promise<number> {
  const p = tryParse(() => parseArgs({
    args: [...args], allowPositionals: true,
    options: { port: { type: 'string' }, 'admin-port': { type: 'string' }, host: { type: 'string' }, 'admin-host': { type: 'string' } },
  }));
  if (typeof p === 'string') return usageError(p);
  const [dir, ...extra] = p.positionals;
  if (dir === undefined || extra.length > 0) return usageError('serve takes exactly one <dir>');
  const port = portOf('--port', p.values.port ?? String(DEFAULT_PORT));
  if (typeof port === 'string') return usageError(port);
  const rawAdmin = p.values['admin-port'];
  const adminPort = rawAdmin === undefined ? undefined : portOf('--admin-port', rawAdmin);
  if (typeof adminPort === 'string') return usageError(adminPort);

  const report = await loadChecked(dir);
  if (report === null) return 1;
  // Listen for the signal before the URLs print: a caller that signals the moment it sees them must not hit the default action.
  const stopped = untilSignal();
  let server: WorldServer;
  try {
    server = await serve(report.world, {
      port, adminPort, host: p.values.host ?? process.env.WORLDPLAY_HOST,
      adminHost: p.values['admin-host'] ?? process.env.WORLDPLAY_ADMIN_HOST,
    });
  } catch (e) {
    return fail(`serve: ${messageOf(e)}`);
  }
  // The first line is for a parent that started this serve on port 0 and needs the ports the OS picked (A-348).
  process.stdout.write(`${JSON.stringify({ listening: { world: server.port, admin: server.adminPort } })}\nworld ${server.url}\nadmin ${server.adminUrl}\nconsole ${server.adminUrl}/\n`);
  await stopped;
  await server.close();
  return 0;
}

const score = (n: number): string => n.toFixed(3);

/** `<id> <difficulty> solution 1.000 noop 0.000 decoys [0.500, 0.000] prefix 0.667`, with `-` for no prefix. */
function verdictLine(v: TaskVerdict): string {
  const decoys = v.decoys.map((d) => score(d.score)).join(', ');
  const prefix = v.bestPrefixScore === null ? '-' : score(v.bestPrefixScore);
  const unprobed = v.collateral.filter((m) => m.call === null).map((m) => m.kind);
  const mutants = `mutants ${v.collateral.length - unprobed.length}/${v.collateral.length} probed${unprobed.length === 0 ? '' : ` (not probed: ${unprobed.join(', ')})`}`;
  return `${v.taskId} ${v.difficulty} solution ${score(v.solution)} noop ${score(v.noop)} decoys [${decoys}] prefix ${prefix} ${mutants}`;
}

async function verify(args: readonly string[]): Promise<number> {
  const p = tryParse(() => parseArgs({ args: [...args], allowPositionals: true, options: { json: { type: 'boolean' } } }));
  if (typeof p === 'string') return usageError(p);
  const [dir, ...extra] = p.positionals;
  if (dir === undefined || extra.length > 0) return usageError('verify takes exactly one <dir>');

  const report = await loadChecked(dir, p.values.json);
  if (report === null) return 1;
  const ids = Object.keys(report.world.tasks);
  if (ids.length === 0) {
    if (!p.values.json) process.stdout.write('no tasks\n');
    return 0;
  }
  let failed = false;
  const lines = ids.map((id) => {
    const v = Object.hasOwn(report.verdicts, id) ? report.verdicts[id] : undefined;
    if (v !== undefined) return p.values.json ? JSON.stringify(proofOf(v)) : verdictLine(v);
    failed = true;
    return `${id} not verified`;
  });
  process.stdout.write(`${lines.join('\n')}\n`);
  return failed ? 1 : 0;
}

async function openapi(args: readonly string[]): Promise<number> {
  const p = tryParse(() => parseArgs({
    args: [...args], allowPositionals: true,
    options: {
      spec: { type: 'string' }, only: { type: 'string' }, json: { type: 'boolean', default: false },
      profile: { type: 'boolean', default: false }, exact: { type: 'boolean', default: false },
      require: { type: 'string', multiple: true }, report: { type: 'string' },
    },
  }));
  if (typeof p === 'string') return usageError(p);
  const [dir, ...extra] = p.positionals;
  if (dir === undefined || extra.length > 0 || p.values.spec === undefined) return usageError('openapi takes <dir> --spec <file> [--only <prefix,...>]');
  const only = (p.values.only ?? '').split(',').filter((x) => x !== '');
  const required = (p.values.require ?? []).flatMap((value) => value.split(',').map((feature) => feature.trim()));
  if (required.some((feature) => feature === '')) return usageError('--require needs nonempty comma-separated feature names');
  if (p.values.report === '') return usageError('--report needs a new file path');

  const options = { only, exact: p.values.exact ?? false, require: required };
  let result = refusedConformance(options);
  if (result === null) {
    const report = await loadChecked(dir, p.values.json);
    if (report === null) return 1;
    let spec: unknown;
    try {
      spec = parseYaml(await readFile(p.values.spec, 'utf8'));
    } catch (e) {
      return fail(`openapi: cannot read ${p.values.spec}: ${messageOf(e)}`);
    }
    result = openapiConformance(report.world, spec, options);
  }
  const evidence = openapiEvidence(result);
  const markdown = renderOpenapiConformance(result);
  if (p.values.report !== undefined) {
    try {
      // A conformance audit must not overwrite a generated run receipt, world, source or existing file.
      await writeFile(p.values.report, markdown, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      return fail(`openapi: cannot create report ${p.values.report}: ${messageOf(e)}`);
    }
  }
  const summary = `OpenAPI profile ${result.profile.id}: verdict ${evidence.verdict}; normalized projection ${projectionText(result)}; requirements ${result.ok ? 'accepted' : 'rejected'}. Exact API equivalence not established. ${result.scope.disclosures.length} source disclosures; use --profile for details.\n`;
  const refusals = result.refusals.map((r) => `refused ${r.feature} at ${r.pointer}: ${r.reason}\n`).join('');
  if (p.values.json) {
    // Preserve the legacy issue-array contract. Structured profile consumers opt in explicitly.
    const json = p.values.profile ? { ...evidence, issues: evidence.issues.map(jsonIssue) } : result.issues.map(jsonIssue);
    process.stdout.write(`${JSON.stringify(json)}\n`);
    process.stderr.write(summary + refusals);
  } else if (p.values.profile) process.stdout.write(markdown);
  else {
    // Issues first, as before the profile existed, then what the profile could not establish.
    printIssues(result.issues);
    process.stdout.write(summary);
    if (refusals !== '') process.stdout.write(refusals);
  }
  return result.ok ? 0 : 1;
}

async function grade(args: readonly string[]): Promise<number> {
  const p = tryParse(() => parseArgs({ args: [...args], allowPositionals: true, options: { state: { type: 'string' } } }));
  if (typeof p === 'string') return usageError(p);
  const [dir, task, ...extra] = p.positionals;
  const stateFile = p.values.state;
  if (dir === undefined || task === undefined || extra.length > 0 || stateFile === undefined) {
    return usageError('grade takes <dir> <task> --state <file>');
  }

  const report = await loadChecked(dir);
  if (report === null) return 1;
  let text: string;
  try {
    text = await readFile(stateFile, 'utf8');
  } catch (e) {
    return fail(`grade: cannot read ${stateFile}: ${messageOf(e)}`);
  }
  let dump: DumpInput;
  try {
    dump = JSON.parse(text);
  } catch (e) {
    return fail(`grade: ${stateFile} is not JSON: ${messageOf(e)}`);
  }
  let r: GradedDump;
  try {
    r = gradeDump(report.world, task, dump);
  } catch (e) {
    return fail(`grade: ${messageOf(e)}`);
  }
  if (!r.ok) {
    printIssues([r.issue]);
    return 1;
  }
  if (r.caveat !== undefined) process.stderr.write(`caveat: ${r.caveat}\n`);
  process.stdout.write(`${r.score}\n`);
  return 0;
}

async function docs(args: readonly string[]): Promise<number> {
  const p = tryParse(() => parseArgs({ args: [...args], allowPositionals: true, options: { out: { type: 'string' } } }));
  if (typeof p === 'string') return usageError(p);
  if (p.positionals.length > 0) return usageError('docs takes no positional arguments');
  const file = path.resolve(p.values.out ?? DEFAULT_DOCS);
  try {
    await writeFile(file, worldFormatDoc(), 'utf8');
  } catch (e) {
    return fail(`docs: cannot write ${file}: ${messageOf(e)}`);
  }
  process.stdout.write(`wrote ${file}\n`);
  return 0;
}

const COMMANDS: Readonly<Record<string, (args: readonly string[]) => Promise<number>>> = {
  check, serve: serveCommand, verify, openapi, grade, docs,
};

async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...args] = argv;
  const run = command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (run) return run(args);
  return usageError(command === undefined ? 'missing command' : `unknown command ${command}`);
}

process.exitCode = await main(process.argv.slice(2));