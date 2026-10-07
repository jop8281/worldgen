/**
 * The engine's public surface. worldgen/ and cli/ import only this file, as `#engine`.
 * This shell file owns file IO, YAML and sha256 of content ids, and passes the vm host to core functions.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML, { LineCounter, isMap, isNode, isScalar, isSeq, type Document } from 'yaml';
import { z } from 'zod';
import { createVmHost } from './sandbox.ts';
import { check, type CheckReport, type CheckedWorld } from './check.ts';
import { runtime, type CallRecord, type DumpInput, type OriginJournal, type Runtime, type StateDump } from './api.ts';
export { OP_SUCCESS_STATUS } from './api.ts';
import { SECTIONS, worldEditSchema, worldSchema, type Section, type Task, type World, type WorldEdit } from './format.ts';
import { listen, type ServeOptions, type WorldServer } from './http.ts';
import { atLine, fromZod, issue, type CheckIssue, type IssuePath, type NonEmpty } from './issues.ts';
import { canonicalJson, canonicalWorld, type Tid, type Wid } from './provenance.ts';
import { gradeDump as gradeDumpWith, type GradedDump } from './tasks.ts';
import {
  chainOf as chainOfWith, verifySubmission as verifySubmissionWith,
  type VerifierHeld, type VerifiedSubmission,
} from './verify.ts';

export {
  worldSchema, worldEditSchema, editJsonSchema, formatReference, worldFormatDoc, emptyWorld, SECTIONS,
} from './format.ts';
export type { World, WorldEdit, Section, Task, Difficulty } from './format.ts';
export { FIELD_TYPES, FIELD_TYPE_ORDER, choicesOf, machineOf, refOf, temporalOf } from './fields.ts';
export type { Field, FieldType, Value } from './fields.ts';
export { ISSUES, issue } from './issues.ts';
export { lowerRules } from './rules.ts';
export type { Expression, Lowered, Step } from './rules.ts';
export type { CheckIssue, IssueCode, IssuePath, IssueOwner, NonEmpty, SourceLine } from './issues.ts';
export { CHECK_LAYERS, routeKey } from './check.ts';
export type { CheckReport, CheckedWorld, CheckLayer, WorldStats } from './check.ts';
export { proofOf, traceOf } from './tasks.ts';
export type { TaskVerdict, TaskProof, GradedDump, GoalResult, GuardResult, MutantProbe } from './tasks.ts';
export { publicWorldOf, taskPrivacy, privacySplit } from './split.ts';
export type { TaskPrivacy } from './split.ts';
export { VERIFIER_PROTOCOL, VERIFIER_LIMITS, VERIFIER_STOPS, verifierRequestSchema } from './verify.ts';
export type { VerifierHeld, VerifierVerdict, VerifiedSubmission, VerifierRequest, RejectStop } from './verify.ts';
export type { TraceCall, TraceWrite } from './ctx.ts';
export { diffWorlds, DESTRUCTIVE } from './diff.ts';
export type { WorldDelta, WorldChange, ChangeKind } from './diff.ts';
export type {
  Runtime, ApiRequest, ApiResponse, CallRecord, CallWrite, StateDump, DumpInput, OriginJournal, JournalEntry,
} from './api.ts';
export type { ServeOptions, WorldServer } from './http.ts';
export { openApiOf, ENGINE_ERROR_CODES } from './openapi.ts';
export type { OpenApiDocument, EngineErrorCode } from './openapi.ts';
export { canonicalWorld } from './provenance.ts';
export type { Wid, Tid } from './provenance.ts';
export { openapiFidelity, underPrefix } from './openapi-fidelity.ts';
export { OPENAPI_CONFORMANCE_PROFILE, OPENAPI_EVIDENCE_FORMAT, openapiConformance, openapiCoverage, openapiEvidence, refusedConformance, unsupportedRequirements } from './openapi-conformance.ts';
export type { OpenapiConformance, OpenapiConformanceOptions, OpenapiCoverage, OpenapiDisclosure, OpenapiEvidence, OpenapiRefusal, OpenapiVerdict } from './openapi-conformance.ts';
export { withDeadline, DeadlineExpired } from './sandbox.ts';

const host = createVmHost();

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
/** sha256 hex of canonicalJson(value). */
export function contentDigest(value: unknown): string { return sha256(canonicalJson(value)); }
/** The world's content address: covers all of world.yaml, meta, tests and tasks included. */
export function worldIdOf(world: World): Wid { return `wid_${sha256(canonicalWorld(world))}`; }
/** A task's content address: its definition only, not its name and not the WID. */
export function taskIdOf(task: Task): Tid { return `tid_${contentDigest(task)}`; }
/**
 * The state dump's digest at the shell boundary (YOS-183): sha-256 of canonicalJson(dump), prefixed
 * with its algorithm like a content id. The core's own StateDump.hash stays the pure 128-bit
 * hash128 of engine/store.ts, because engine core cannot import node:crypto.
 */
export function dumpSha256(dump: StateDump): string { return `sha-256:${sha256(canonicalJson(dump))}`; }

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Check a world. The only path to a CheckedWorld. Pass the `lines` loadWorld returned with
 * `input` and every issue and warning also carries `file` and `line` (world.yaml, the line of the
 * node at its path or of the nearest ancestor the file has).
 */
export function checkWorld(input: unknown, lines?: WorldLines): CheckReport {
  const report = check(input, host);
  if (lines === undefined) return report;
  const at = (i: CheckIssue): CheckIssue =>
    i.path[0] === 'plan' || i.path[0] === 'input' ? i : atLine(i, { file: lines.file, line: lines.lineOf(i.path) });
  if (report.ok) return { ...report, warnings: report.warnings.map(at) };
  const [first, ...rest] = report.issues;
  return { ...report, issues: [at(first), ...rest.map(at)], warnings: report.warnings.map(at) };
}
export function createRuntime(world: CheckedWorld): Runtime {
  return runtime(world, host);
}

/**
 * Serves a checked world from a fresh copy of its seed: the world's API on `port`, the
 * /_world admin routes on `adminPort` (default port + 1). Resolves once both ports listen.
 */
export function serve(world: CheckedWorld, opts: ServeOptions): Promise<WorldServer> {
  return listen(world, createRuntime(world), opts);
}

/**
 * Scores a dumped end state (GET /_world/state, Runtime.dump) against the world's seed. Pass the
 * runtime's journal for the same span so job changes are not counted as calls, and its call log
 * (GET /_world/log) so ctx.trace() sees the calls; without them the result may carry a caveat.
 * Throws an Error starting `Not a state dump:` for a malformed dump.
 */
export function gradeDump(
  world: CheckedWorld,
  taskId: string,
  dump: DumpInput,
  journal?: OriginJournal,
  log?: readonly CallRecord[],
): GradedDump {
  return gradeDumpWith(world, taskId, dump, host, journal, log);
}

/** sha-256 chain over the trace as sent (engine/verify.ts chainOf), with this shell's sha-256. */
export function chainOf(trace: readonly unknown[]): string {
  return chainOfWith(trace, sha256);
}

/**
 * Verifies one protocol submission against the private world (YOS-159): the engine's own vm host
 * and sha-256 injected, as for every core function that runs snippets. The only thing that can
 * come back is the bounded verdict; see engine/verify.ts.
 */
export function verifySubmission(world: CheckedWorld, held: VerifierHeld, requestText: string, seen: ReadonlySet<string>): VerifiedSubmission {
  return verifySubmissionWith(world, held, requestText, seen, host, sha256);
}
const WORLD_FILE = 'world.yaml';

function formatIssue(message: string, found: string): NonEmpty<CheckIssue> {
  return [issue('schema.invalid', ['format'], { message }, found)];
}

/** Where the nodes of a loaded world.yaml start, for check issues. */
export type WorldLines = {
  /** The file name issues point into: world.yaml. */
  readonly file: string;
  /**
   * The 1-based line of the node at `path` (an issue path): a map entry's key line, a list item's
   * first line. A path the file does not have falls back to its nearest ancestor that it does
   * have, and to the document's first line when none does.
   */
  lineOf(path: readonly (string | number)[]): number;
};

export type LoadedWorld = { ok: true; value: unknown; lines: WorldLines } | { ok: false; error: NonEmpty<CheckIssue> };

const pathKey = (path: readonly (string | number)[]): string => path.map(String).join('\u0000');

/**
 * The line map of a parsed document. It walks maps and lists only, never aliases, so an alias
 * fan-out costs nothing; a node reached only through an alias or a merge key falls back to its
 * nearest ancestor.
 */
function linesOf(doc: Document, counter: LineCounter): WorldLines {
  const lines = new Map<string, number>();
  const lineAt = (offset: number): number => Math.max(1, counter.linePos(offset).line);
  const walk = (node: unknown, at: readonly (string | number)[]): void => {
    if (isMap(node)) {
      for (const pair of node.items) {
        const here = [...at, isScalar(pair.key) ? String(pair.key.value) : String(pair.key)];
        const start = (isNode(pair.key) ? pair.key.range?.[0] : undefined) ?? (isNode(pair.value) ? pair.value.range?.[0] : undefined);
        if (start !== undefined) lines.set(pathKey(here), lineAt(start));
        walk(pair.value, here);
      }
    } else if (isSeq(node)) {
      node.items.forEach((item, i) => {
        const here = [...at, i];
        const start = isNode(item) ? item.range?.[0] : undefined;
        if (start !== undefined) lines.set(pathKey(here), lineAt(start));
        walk(item, here);
      });
    }
  };
  walk(doc.contents, []);
  const rootStart = isNode(doc.contents) ? doc.contents.range?.[0] : undefined;
  const root = rootStart === undefined ? 1 : lineAt(rootStart);
  return {
    file: WORLD_FILE,
    lineOf(path) {
      for (let n = path.length; n > 0; n--) {
        const hit = lines.get(pathKey(path.slice(0, n)));
        if (hit !== undefined) return hit;
      }
      return root;
    },
  };
}

/**
 * Reads <dir>/world.yaml. Returns parsed YAML, unchecked, with the line of each node, so
 * `checkWorld(value, lines)` can say where each issue is. A YAML syntax error carries its line.
 */
export async function loadWorld(dir: string): Promise<LoadedWorld> {
  const file = path.join(dir, WORLD_FILE);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    const found = code === 'ENOENT' ? `no file at ${file}` : `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`;
    return { ok: false, error: formatIssue(`a readable ${WORLD_FILE} in the world directory`, found) };
  }
  const counter = new LineCounter();
  const doc = YAML.parseDocument(text, { uniqueKeys: true, lineCounter: counter });
  const err = doc.errors[0];
  if (err) {
    const pos = err.linePos?.[0];
    const where = pos ? `line ${pos.line}, column ${pos.col}` : 'unknown position';
    const reason = err.message.split('\n')[0] ?? err.message;
    const [bad] = formatIssue(`${WORLD_FILE} to be valid YAML`, `${where} in ${file}: ${reason}`);
    return { ok: false, error: [pos ? atLine(bad, { file: WORLD_FILE, line: pos.line }) : bad] };
  }
  try {
    const value = doc.toJS() as unknown;
    return { ok: true, value, lines: linesOf(doc, counter) };
  } catch (e) {
    const reason = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
    return { ok: false, error: formatIssue(`${WORLD_FILE} to be valid YAML`, `${file}: ${reason}`) };
  }
}

/**
 * A `|` block scalar round-trips only multi-line text with some non-blank line, no trailing blanks on a line and no CR.
 * Anything else (such as ' \n') stays a quoted scalar, so save then load is the identity.
 */
function blockSafe(s: string): boolean {
  return s.includes('\n') && !s.includes('\r') && /\S/.test(s) && !/[ \t]\n/.test(s) && !/^[ \t]*\n/.test(s);
}

/** Pure. The world as YAML text: sections in SECTIONS order, multi-line strings as `|` block scalars. */
export function renderWorldYaml(world: World): string {
  const src = world as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = { format: src.format, meta: src.meta };
  for (const s of SECTIONS) ordered[s] = src[s];
  const doc = new YAML.Document(ordered);
  YAML.visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === 'string' && node.value.includes('\n')) node.type = blockSafe(node.value) ? 'BLOCK_LITERAL' : 'QUOTE_DOUBLE';
    },
  });
  return doc.toString({ lineWidth: 0 });
}

/** Writes <dir>/world.yaml with snippets as YAML block scalars. Atomic: write a temp file, then rename. */
export async function saveWorld(dir: string, world: CheckedWorld): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, WORLD_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, renderWorldYaml(world), 'utf8');
  await rename(tmp, file);
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * RFC 7386. Objects merge, null deletes, everything else replaces. Keys become own data properties.
 * A path in `opaque` names a value that is one unit, such as a template: a patch replaces it whole,
 * and nulls inside it are kept.
 */
function mergePatch(target: unknown, patch: unknown, opaque: readonly string[] = [], at = ''): unknown {
  if (!isObject(patch)) return patch;
  const out: Json = isObject(target) ? Object.fromEntries(Object.entries(target)) : {};
  for (const [k, v] of Object.entries(patch)) {
    const here = at === '' ? k : `${at}.${k}`;
    if (v === null) delete out[k];
    else if (opaque.includes(here)) Object.defineProperty(out, k, { value: structuredClone(v), enumerable: true, writable: true, configurable: true });
    else Object.defineProperty(out, k, { value: mergePatch(out[k], v, opaque, here), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** meta paths whose value is one opaque unit: the error body template (z.json()) is replaced, never merged. */
const META_OPAQUE: readonly string[] = ['api.error'];

/** The parsed value restricted to the keys the caller wrote, so schema defaults never reach a merge patch. */
function presentOnly(parsed: unknown, raw: unknown): unknown {
  if (!isObject(parsed) || !isObject(raw)) return parsed;
  const out: Json = {};
  for (const k of Object.keys(raw)) {
    if (Object.hasOwn(parsed, k)) Object.defineProperty(out, k, { value: presentOnly(parsed[k], raw[k]), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Edit parse issues are rooted at the edit's own keys. IssuePath requires a section, meta, format, plan or input first,
 * so ['upsert'|'patch'|'remove', section, ...rest] becomes [section, ...rest], meta stays, and anything else goes to ['format'].
 */
function remapEditIssues(issues: NonEmpty<CheckIssue>): NonEmpty<CheckIssue> {
  const sections: readonly unknown[] = SECTIONS;
  const remap = (i: CheckIssue): CheckIssue => {
    const loose: readonly (string | number)[] = i.path;
    const [head, ...rest] = loose;
    let path: IssuePath = ['format'];
    if (head === 'meta') path = i.path;
    else if ((head === 'upsert' || head === 'patch' || head === 'remove') && sections.includes(rest[0])) path = [rest[0] as Section, ...rest.slice(1)];
    return { ...i, path };
  };
  return [remap(issues[0]), ...issues.slice(1).map(remap)];
}

/** Zod reports unknown keys once per object. Split them so each issue's path ends at the key it names. */
function perKey(error: z.ZodError): z.ZodError {
  const issues = error.issues.flatMap((i): z.core.$ZodIssue[] => i.code === 'unrecognized_keys'
    ? i.keys.map((k) => ({ ...i, keys: [k], path: [...i.path, k], message: `Unrecognized key: "${k}"` }))
    : [i]);
  return new z.ZodError(issues);
}

/** Parses an untrusted edit and applies it. It never judges semantics. Call checkWorld after. */
export function applyEdit(world: World, edit: unknown): Result<{ world: World; edit: WorldEdit }, NonEmpty<CheckIssue>> {
  const parsed = worldEditSchema.safeParse(edit);
  if (!parsed.success) return { ok: false, error: remapEditIssues(fromZod(perKey(parsed.error), [], { schema: worldEditSchema, input: edit })) };
  const e = parsed.data;
  const next = structuredClone(world) as unknown as Json;
  const sec = (s: Section): Json => next[s] as Json;

  const missing: CheckIssue[] = [];
  for (const s of SECTIONS) {
    for (const key of e.remove[s] ?? []) {
      if (Object.hasOwn(sec(s), key)) delete sec(s)[key];
      else missing.push(issue('schema.invalid', [s, key], { message: `an existing ${s} item to remove` }, `no ${s}.${key}`));
    }
  }
  for (const s of SECTIONS) {
    for (const [key, item] of Object.entries(e.upsert[s] ?? {})) {
      Object.defineProperty(sec(s), key, { value: structuredClone(item), enumerable: true, writable: true, configurable: true });
    }
  }
  for (const s of SECTIONS) {
    for (const [key, p] of Object.entries(e.patch[s] ?? {})) {
      const current = Object.hasOwn(sec(s), key) ? sec(s)[key] : undefined;
      if (!isObject(current)) {
        missing.push(issue('schema.invalid', [s, key], { message: current === undefined ? `an existing ${s} item to patch` : `a ${s} item that is an object` },
          current === undefined ? `no ${s}.${key}` : `${s}.${key} is not an object`));
        continue;
      }
      Object.defineProperty(sec(s), key, { value: mergePatch(current, p), enumerable: true, writable: true, configurable: true });
    }
  }
  const [firstMissing, ...otherMissing] = missing;
  if (firstMissing) return { ok: false, error: [firstMissing, ...otherMissing] };
  if (e.meta) next.meta = mergePatch(next.meta, presentOnly(e.meta, (edit as { meta?: unknown }).meta), META_OPAQUE);

  const result = worldSchema.safeParse(next);
  if (!result.success) return { ok: false, error: fromZod(perKey(result.error), [], { schema: worldSchema, input: next }) };
  return { ok: true, value: { world: result.data, edit: e } };
}
