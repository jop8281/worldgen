/**
 * How each input kind is understood. One zod union is parsed by cli/worldgen.ts and by
 * eval/suite.yaml, so a new kind appears in both or neither.
 *
 * Invariants:
 * - `INPUT_KINDS` has one entry per kind. A kind without load and digest fails to compile.
 * - `digest` receives only `Redacted<...>`, minted only by `redact()`. Auth headers,
 *   cookies and tokens never reach the model, events, attempt dumps or prod/.
 * - events.ts and attempt dumps receive InputDigest, never Input or loaded content.
 * - CSV column types come from FIELD_TYPES[t].inferFromCsv, never from a local switch.
 */
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { FIELD_TYPES, FIELD_TYPE_ORDER, temporalOf, underPrefix, worldSchema, type Field, type Value, type World } from '#engine';
import { assertNever } from '#lib/never';

export const inputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('description'),
    text: z.string().min(1),
    fidelity: z.string().optional().describe('a frozen fidelity reference of the real software this description names; the last step gates on it (A-258)'),
  }),
  z.object({ kind: z.literal('openapi'), path: z.string(), only: z.array(z.string()).default([]) }),
  z.object({ kind: z.literal('csv'), paths: z.array(z.string()).min(1), note: z.string().optional() }),
]);
export type Input = z.output<typeof inputSchema>;
export type InputKind = Input['kind'];

/** Raw content per kind after reading files. */
export interface LoadedKinds {
  description: { text: string };
  openapi: { document: unknown; only: readonly string[] };
  csv: { tables: readonly { name: string; header: readonly string[]; rows: readonly (readonly string[])[] }[]; note: string | null };
}

declare const redactedBrand: unique symbol;
export type Redacted<T> = T & { readonly [redactedBrand]: true };

/** A request and response pair seen in the input. A stage turns these into replay tests. */
export type Observation = { readonly method: string; readonly path: string; readonly status: number; readonly bodyShape: unknown };

export type InputDigest = {
  readonly kind: InputKind;
  /** Compact text the planner reads. */
  readonly summary: string;
  /** CSV only. Injected into world.fixtures by code, not by the model. */
  readonly fixtures: Readonly<Record<string, readonly Readonly<Record<string, Value>>[]>>;
  /** Every kept OpenAPI operation, including operations without examples or beyond the summary cap. */
  readonly operations: readonly Pick<Observation, 'method' | 'path'>[];
  readonly observations: readonly Observation[];
  /** The real API's list and error envelopes, when the input shows them. */
  readonly apiShape: World['meta']['api'] | null;
  /** Every field name the input gives: CSV column headers, or the properties of the OpenAPI schemas the kept operations reach. Absent for a description, which names no fields. */
  readonly sourceFields?: readonly string[];
};

type InputKindDef<K extends InputKind> = {
  readonly flag: string;
  load(input: Extract<Input, { kind: K }>): Promise<LoadedKinds[K]>;
  digest(loaded: Redacted<LoadedKinds[K]>): InputDigest;
};

const SUMMARY_MAX = 8000;

export const INPUT_KINDS: { readonly [K in InputKind]: InputKindDef<K> } = {
  description: {
    flag: '<text>',
    load: async (input) => ({ text: input.text }),
    digest: (loaded) => ({
      kind: 'description',
      summary: loaded.text.trim().slice(0, SUMMARY_MAX),
      fixtures: {},
      operations: [],
      observations: [],
      apiShape: null,
    }),
  },
  openapi: { flag: '--openapi <file> [--only <prefix,...>]', load: loadOpenapi, digest: digestOpenapi },
  csv: { flag: '--csv <file...>', load: loadCsv, digest: digestCsv },
};

const MASK = '[redacted]';
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:]{1,200}(?::[^\s/]{1,500})?@/gi, `$1${MASK}@`],
  // A bearer value must look like a credential (a digit or . _ ~ + / =, or 16+ chars), so prose like "uses bearer tokens" survives.
  // An Authorization header value is always a credential, even letters-only.
  // Any Authorization value is a credential whatever its scheme (or none).
  [/\b((?:proxy-)?authorization["']?\s*[=:]\s*["']?)(?:[A-Za-z]+[ \t]+)?[^\s"',;}]+/gi, `$1${MASK}`],
  [/\bBearer\s+(?:(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=])[A-Za-z0-9._~+/=-]+|[A-Za-z0-9._~+/=-]{16,})/gi, MASK],
  [/\b((?:set-)?cookie["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, `$1${MASK}`],
  [/\bsk-[A-Za-z0-9_-]+/g, MASK],
  // Provider key shapes: Stripe, webhook secrets, Google, npm, GitLab, SendGrid.
  [/\b(?:(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{30,}|npm_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{15,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,})/g, MASK],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[abprs]-[A-Za-z0-9-]{10,})/g, MASK],
];

// No leading \b: '_' is a word character, so there is no boundary inside OPENAI_API_KEY or access_token.
// No prefix group either: characters before the keyword are left in place by the replace whether or not
// they are captured, so a prefix changes nothing in the output and only adds backtracking at every position.
const LABEL = String.raw`(?:api[_\s-]?key|access[_\s-]?key|private[_\s-]?key|(?:secret|signing|session|encryption|auth|master|account|subscription)[_\s-]?key|(?<!by|com|sur|tres|under|over)pass(?:word|wd|[_\s-]?phrase)?|pwd|pw|bearer|auth|credentials?|secret|token)`;
// '' is YAML's escaped quote inside a single-quoted value.
const QUOTED = String.raw`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.|'')*'?`;
// A password or secret may hold spaces and ; , & }, so an unquoted one runs to the end of the line.
const LINE_VALUE = new RegExp(String.raw`((?:(?<!by|com|sur|tres|under|over)pass(?:word|wd|[_\s-]?phrase)?|pwd|pw|secret(?:[_\s-]?key)?)(?:[_-][\w-]{0,40})?["']?\s*[=:]\s*)(${QUOTED}|.+)`, 'gi');
const KEY_VALUE = new RegExp(String.raw`(${LABEL}(?:[_-][\w-]{0,40})?["']?\s*[=:]\s*)(${QUOTED}|[^\s&"',;}]+)`, 'gi');
/** Short labels that are credentials only before '=' (key=, sig=, X-Amz-Signature=), so "primary key: id" survives. */
const SHORT_KEY = /((?<![A-Za-z0-9])(?:key|sig|x-amz-signature)=)[^\s&"',;}]+/gi;
/** Any 16+ char value after = or : that mixes letters and digits. '=' and ':' are outside the run, so no character is scanned twice. */
const LONG_VALUE = /([=:][ \t]*["']?)([A-Za-z0-9+/_.~%-]{16,}={0,2})/g;
/** Mixed values that are not credentials: the rest of a URL after its scheme, a dated version, a UUID. */
const NOT_SECRET = /^(?:\/\/|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)/i;
const maskLong = (m: string, lead: string, v: string): string =>
  !NOT_SECRET.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v) ? lead + MASK : m;
/**
 * A YAML key that names a credential. Lines indented deeper than the key are its value (a | or > block,
 * or a plain scalar continued on the next lines), so they are dropped. Group 1 ends at the key's column.
 */
const CREDENTIAL_KEY = new RegExp(String.raw`^([ \t]*(?:-[ \t]+)?)["']?[\w.-]*?(?:${LABEL}|key)(?:[_-][\w-]{0,40})?["']?[ \t]*:`, 'i');

const PEM_BEGIN = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
const PEM_END = /-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/;
/** Raw input beyond this is dropped before masking. The digest keeps 8000 chars of masked text, and a cut at the end can only drop text, never expose a secret's tail. */
const RAW_MAX = 200000;

const JWT_HEAD = /(?:^|-)(eyJ[A-Za-z0-9_-]{8,})$/;
/** Masks JWTs (eyJ header, 8+ char payload, signature) without a backtracking regex: a run of token characters is split on dots, so the cost is linear in the line. */
function maskJwts(line: string): string {
  return line.replace(/[A-Za-z0-9_.-]{20,}/g, (run) => {
    if (!run.includes('eyJ')) return run;
    const seg = run.split('.');
    let out = '';
    for (let i = 0; i < seg.length; i++) {
      const head = i + 2 < seg.length && seg[i + 1]!.length >= 8 && seg[i + 2]!.length > 0 ? JWT_HEAD.exec(seg[i]!) : null;
      if (head === null) {
        out += (i > 0 ? '.' : '') + seg[i];
        continue;
      }
      out += (i > 0 ? '.' : '') + seg[i]!.slice(0, head.index + head[0].length - head[1]!.length) + MASK;
      i += 2;
    }
    return out;
  });
}

/** Masks one line in a single pass. Every pattern is linear or has a fixed cap, so no line needs splitting into windows. */
function maskShort(line: string): string {
  const t = maskJwts(SECRET_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), line));
  // Every keyword form is masked, prose included: over-masking costs a word, a leak costs a credential.
  return t.replace(LINE_VALUE, `$1${MASK}`).replace(KEY_VALUE, `$1${MASK}`).replace(SHORT_KEY, `$1${MASK}`).replace(LONG_VALUE, maskLong);
}

const INVISIBLE = /[\u200b-\u200f\u2060\ufeff\u00ad]/g;
/** Cyrillic and Greek letters that read as Latin ones. Applied only inside words that already mix scripts, so real Russian or Greek prose is untouched. */
const LOOKALIKE: Readonly<Record<string, string>> = Object.fromEntries(
  [...'АВЕКМНОРСТХаеорсухі', ...'ΑΒΕΖΗΙΚΜΝΟΡΤΥΧοαρ'].map((c, i) => [c, 'ABEKMHOPCTXaeopcyxiABEZHIKMNOPTYXoap'[i]!]),
);
const MIXED_WORD = /[\p{L}\p{M}]+/gu;
const foldLookalikes = (text: string): string =>
  text.replace(MIXED_WORD, (w) => (/[A-Za-z]/.test(w) && /[\u0370-\u03ff\u0400-\u04ff]/.test(w) ? [...w].map((c) => LOOKALIKE[c] ?? c).join('') : w));

/** Normalises what a reader would see (NFKC, no invisible characters, mixed-script lookalikes folded, CRLF and backslash continuations joined) and rejoins a credential label with a value wrapped onto the next line. */
function normalize(text: string): string {
  const t = foldLookalikes(text.normalize('NFKC').replace(INVISIBLE, '')).replace(/\r\n?/g, '\n').replace(/\\\n/g, '');
  return t
    .replace(new RegExp(String.raw`(${LABEL}["']?[ \t]*[=:]|\bBearer)[ \t]*\n[ \t]*(?=\S)`, 'gi'), (_m, label: string) => `${label} `)
    .replace(/((?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]+)\n([A-Za-z0-9_-]+)(?=\n|$)/g, '$1$2');
}

/** Masks the whole text line by line (linear time), THEN the caller truncates, so a secret can never straddle a cut. Drops the lines of a credential key's YAML value. */
function maskSecrets(text: string): string {
  const out: string[] = [];
  let inKey = false;
  /** Indent of a credential label whose YAML block scalar is being dropped, or null. */
  let blockIndent: number | null = null;
  for (const line of text.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) continue;
      blockIndent = null;
    }
    const joins = inKey;
    const emit = (piece: string) => {
      if (joins) out[out.length - 1] += piece;
      else out.push(piece);
    };
    let rest = line;
    let acc = '';
    for (;;) {
      if (inKey) {
        const end = PEM_END.exec(rest);
        if (end === null) {
          rest = '';
          break;
        }
        rest = rest.slice(end.index + end[0].length);
        inKey = false;
      }
      const begin = PEM_BEGIN.exec(rest);
      if (begin === null) break;
      acc += maskShort(rest.slice(0, begin.index)) + MASK;
      rest = rest.slice(begin.index + begin[0].length);
      inKey = true;
    }
    emit(acc + maskShort(rest));
    const key = inKey || joins ? null : CREDENTIAL_KEY.exec(line);
    if (key !== null) blockIndent = key[1]!.length;
  }
  return out.join('\n');
}

/** Caps raw input. A cut inside a token could leave a prefix below a mask pattern's length floor, so the cut backs up to the last whitespace and drops the partial token. */
function capRaw(text: string): string {
  if (text.length <= RAW_MAX) return text;
  const cut = text.slice(0, RAW_MAX);
  if (/\s/.test(text[RAW_MAX]!)) return cut;
  const ws = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'), cut.lastIndexOf('\t'), cut.lastIndexOf('\r'));
  return ws < 0 ? '' : cut.slice(0, ws);
}

/** Strips credentials and secrets. The only minter of Redacted. */
export function redact<K extends InputKind>(kind: K, loaded: LoadedKinds[K]): Redacted<LoadedKinds[K]> {
  if (kind === 'openapi') return redactOpenapi(loaded as LoadedKinds['openapi']) as unknown as Redacted<LoadedKinds[K]>;
  if (kind === 'csv') return redactCsv(loaded as LoadedKinds['csv']) as unknown as Redacted<LoadedKinds[K]>;
  if (kind === 'description') {
    const d = loaded as LoadedKinds['description'];
    return { text: maskSecrets(normalize(capRaw(d.text.trim()))).slice(0, SUMMARY_MAX) } as unknown as Redacted<LoadedKinds[K]>;
  }
  throw new Error(`redact for ${kind} is not implemented`);
}

/** Loads, redacts and digests one input. Never throws. */
export async function digestInput(input: Input): Promise<{ ok: true; digest: InputDigest } | { ok: false; why: string }> {
  try {
    if (input.kind === 'description' && input.text.trim() === '') return { ok: false, why: 'The description is empty.' };
    const def = INPUT_KINDS[input.kind] as InputKindDef<InputKind>;
    const loaded = await def.load(input as never);
    const digest = def.digest(redact(input.kind, loaded as never) as never);
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/** CLI options that take one value. They are not inputs, so they are skipped with their value. */
const SKIPPED_OPTIONS = new Set(['--out', '--world', '--model', '--budget-usd', '--max-minutes', '--max-repairs', '--upto', '--resume', '--jobs', '--verify-jobs', '--thinking', '--transport', '--max-usd']);
/** CLI flags without a value. */
const SKIPPED_FLAGS = new Set(['--interactive', '--pause-after-plan', '--json', '--allow-destructive']);

/** Maps CLI argv to an Input through inputSchema. Throws an Error on invalid usage. */
export function parseInputArgs(argv: readonly string[]): Input {
  const words: string[] = [];
  let openapi: string | null = null;
  let only: string[] | null = null;
  let csv: string[] | null = null;
  let fidelity: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--openapi') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--openapi needs a file');
      openapi = v;
    } else if (a === '--fidelity') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--fidelity needs a reference file');
      fidelity = v;
    } else if (a === '--only') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error('--only needs a comma-separated list');
      only = v.split(',').filter((p) => p !== '');
    } else if (a === '--csv') {
      csv = [];
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) csv.push(argv[++i]!);
      if (csv.length === 0) throw new Error('--csv needs at least one file');
    } else if (SKIPPED_OPTIONS.has(a)) {
      i++;
    } else if (SKIPPED_OPTIONS.has(a.split('=')[0]!) || SKIPPED_FLAGS.has(a)) {
      // --opt=value form, or a value-less flag
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option ${a.split('=')[0]}.`);
    } else {
      words.push(a);
    }
  }
  const given = [words.length > 0, openapi !== null, csv !== null].filter(Boolean).length;
  if (given === 0) throw new Error('No input given. Pass a description, --openapi <file> or --csv <file...>.');
  if (given > 1) throw new Error('Give exactly one input: a description, --openapi or --csv.');
  if (only !== null && openapi === null) throw new Error('--only needs --openapi');
  if (fidelity !== null && words.length === 0) throw new Error('--fidelity needs a description');
  if (openapi !== null) return inputSchema.parse({ kind: 'openapi', path: openapi, only: only ?? [] });
  if (csv !== null) return inputSchema.parse({ kind: 'csv', paths: csv });
  return inputSchema.parse({ kind: 'description', text: words.join(' '), ...(fidelity === null ? {} : { fidelity }) });
}

// ---------------------------------------------------------------------------------------------
// Shared helpers for the openapi and csv kinds. INPUT_KINDS calls them only at run time, so they
// may live below it.

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Words of an identifier: camelCase, kebab, snake and spaces all split, accents folded, lowercased. */
function identWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}
const snakeCase = (name: string): string => identWords(name).join('_');

const CREDENTIAL_WORDS = new Set([
  'password', 'passwd', 'passphrase', 'pwd', 'secret', 'secrets', 'token', 'tokens', 'credential', 'credentials',
  'cookie', 'cookies', 'authorization', 'apikey', 'auth', 'bearer', 'jwt',
]);
const CREDENTIAL_PAIRS: readonly (readonly [string, string])[] = [
  ['api', 'key'], ['access', 'key'], ['private', 'key'], ['secret', 'key'], ['signing', 'key'], ['session', 'key'], ['session', 'id'], ['client', 'secret'],
];
/** True for a header, parameter, property or column name that holds a credential, such as X-Api-Key, password or access_token. */
function isCredentialName(name: string): boolean {
  const words = identWords(name);
  return words.some((w) => CREDENTIAL_WORDS.has(w)) || CREDENTIAL_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    const code = e instanceof Error && 'code' in e ? String(e.code) : 'unreadable';
    throw new Error(`Cannot read ${what} ${path} (${code}).`);
  }
}

/** Cuts the summary at a line boundary so the planner never reads half a line. */
function capSummary(lines: readonly string[]): string {
  const all = lines.join('\n');
  if (all.length <= SUMMARY_MAX) return all;
  const note = '\n[summary cut at 8000 chars]';
  const cut = all.slice(0, SUMMARY_MAX - note.length);
  const nl = cut.lastIndexOf('\n');
  return (nl > 0 ? cut.slice(0, nl) : cut) + note;
}

// ---------------------------------------------------------------------------------------------
// OpenAPI 3.x. Local $ref ('#/...') and allOf are resolved by hand with a depth cut of 3; remote
// refs are named, never fetched.

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace'] as const;
/** Nested schemas deeper than this print as their name or `object`. */
const DEPTH_CUT = 3;
/** A chain of pure $ref hops longer than this is a cycle. */
const MAX_REF_HOPS = 20;
const SCHEMA_REF = '#/components/schemas/';

async function loadOpenapi(input: Extract<Input, { kind: 'openapi' }>): Promise<LoadedKinds['openapi']> {
  const raw = await readText(input.path, 'OpenAPI file');
  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (e) {
    // The first line only: later lines quote the file, which may hold a secret.
    const first = (e instanceof Error ? e.message : String(e)).split('\n')[0] ?? '';
    throw new Error(`${input.path} is not valid YAML or JSON: ${maskSecrets(first)}`);
  }
  if (!isObj(document)) throw new Error(`${input.path} is not an OpenAPI document: its top level is not a mapping.`);
  if (document.swagger !== undefined) throw new Error(`${input.path} is Swagger ${String(document.swagger)}. Only OpenAPI 3.x is supported; convert it first.`);
  const version = text(document.openapi);
  if (version === null || !version.startsWith('3.')) throw new Error(`${input.path} is not an OpenAPI document: it has no "openapi: 3.x" field.`);
  if (!isObj(document.paths)) throw new Error(`${input.path} has no paths.`);
  return { document, only: input.only };
}

/** Fields a security scheme keeps. Everything else (examples, flows, descriptions, x- keys) is dropped. */
const SCHEME_KEYS = ['type', 'scheme', 'in', 'name', 'bearerFormat'];
/** Keys kept inside a credential-carrying object (an Authorization header, a cookie parameter). Values such as example and default are dropped. */
const STRUCTURAL_KEYS = new Set([
  'type', 'format', 'in', 'name', 'description', 'required', 'nullable', 'schema', '$ref', 'style', 'explode', 'deprecated',
  'title', 'minLength', 'maxLength', 'pattern', 'items', 'properties', 'allOf', 'anyOf', 'oneOf', 'content',
]);

/**
 * 'normal' masks every string through maskSecrets. 'shape' is a credential-carrying object (an
 * Authorization header, a cookie parameter, a password property): only structural keys survive,
 * so its example, examples and default values are dropped.
 */
type ScrubMode = 'normal' | 'shape';

/** A value under a credential name: scalars are masked, objects keep their shape only. */
function underCredential(v: unknown): unknown {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string' || typeof v === 'number') return MASK;
  if (Array.isArray(v)) return v.map(underCredential);
  return scrubOpenapi(v, 'shape');
}

/** A map whose keys are names (paths, properties). Path keys are never credential names. */
function scrubNames(map: Obj, mode: ScrubMode): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [maskSecrets(k), mode === 'normal' && !k.startsWith('/') && isCredentialName(k) ? underCredential(v) : scrubOpenapi(v, mode)]),
  );
}

function scrubSchemes(schemes: Obj): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schemes).map(([n, s]) => [maskSecrets(n), isObj(s) ? Object.fromEntries(SCHEME_KEYS.filter((f) => typeof s[f] === 'string').map((f) => [f, maskSecrets(String(s[f]))])) : {}]),
  );
}

/** Masks every string, keeps only the type fields of security schemes, and strips values from credential parameters, headers and properties. */
function scrubOpenapi(node: unknown, mode: ScrubMode): unknown {
  if (typeof node === 'string') return maskSecrets(node);
  if (Array.isArray(node)) return node.map((v) => scrubOpenapi(v, mode));
  if (!isObj(node)) return node;
  const credParam = typeof node.in === 'string' && typeof node.name === 'string' && (node.in === 'cookie' || isCredentialName(node.name));
  const inner: ScrubMode = mode === 'shape' || credParam ? 'shape' : 'normal';
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (inner === 'shape' && !STRUCTURAL_KEYS.has(k)) continue;
    const key = maskSecrets(k);
    if (k === 'securitySchemes' && isObj(v)) out[key] = scrubSchemes(v);
    else if ((k === 'properties' || k === 'paths') && isObj(v)) out[key] = scrubNames(v, inner);
    else if (inner === 'normal' && isCredentialName(k)) out[key] = underCredential(v);
    else out[key] = scrubOpenapi(v, inner);
  }
  return out;
}

function redactOpenapi(loaded: LoadedKinds['openapi']): LoadedKinds['openapi'] {
  return { document: scrubOpenapi(loaded.document, 'normal'), only: loaded.only.map(maskSecrets) };
}

function pointerGet(doc: unknown, ref: string): unknown {
  let cur = doc;
  for (const raw of ref.slice(2).split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isObj(cur) && Object.hasOwn(cur, seg)) cur = cur[seg];
    else return undefined;
  }
  return cur;
}

const refOf = (v: unknown): string | null => (isObj(v) && typeof v.$ref === 'string' ? v.$ref : null);
/** `Order` for '#/components/schemas/Order'. A remote ref keeps its full text. */
const refName = (ref: string): string => (ref.startsWith('#/') ? (ref.split('/').at(-1) ?? ref).replace(/~1/g, '/').replace(/~0/g, '~') : ref);

/** Follows local $ref hops. A remote, dangling or cyclic ref resolves to undefined with its name kept. */
function deref(doc: Obj, node: unknown): { node: unknown; name: string | null } {
  let cur = node;
  let name: string | null = null;
  for (let hop = 0; hop < MAX_REF_HOPS; hop++) {
    const ref = refOf(cur);
    if (ref === null) return { node: cur, name };
    name = refName(ref);
    if (!ref.startsWith('#/')) return { node: undefined, name };
    cur = pointerGet(doc, ref);
  }
  return { node: undefined, name };
}

/** One object schema from allOf parts (refs resolved), properties and required merged. Stops at the depth cut. */
function mergeAllOf(doc: Obj, node: unknown, depth: number): Obj {
  if (!isObj(node)) return {};
  if (!Array.isArray(node.allOf) || depth >= DEPTH_CUT) return node;
  const own: Obj = Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'allOf'));
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  let type: unknown = undefined;
  for (const part of [...node.allOf, own]) {
    const m = mergeAllOf(doc, deref(doc, part).node, depth + 1);
    if (isObj(m.properties)) Object.assign(properties, m.properties);
    for (const r of arr(m.required)) if (typeof r === 'string' && !required.includes(r)) required.push(r);
    type ??= m.type;
  }
  return { ...own, type: type ?? 'object', properties, required };
}

type FieldLine = { readonly name: string; readonly type: string; readonly required: boolean };

function fieldsOf(doc: Obj, raw: unknown, depth: number): FieldLine[] {
  const s = mergeAllOf(doc, deref(doc, raw).node, depth);
  if (!isObj(s.properties)) return [];
  const required = arr(s.required);
  return Object.entries(s.properties).map(([name, v]) => ({ name, type: typeLabel(doc, v, depth + 1), required: required.includes(name) }));
}

const fieldText = (f: FieldLine): string => `${f.name} ${f.type}${f.required ? ' required' : ''}`;

/** An enum value as it reads in a summary: quoted (JSON) only when it holds |, a quote, a newline or edge spaces. */
const enumValue = (v: string): string => (/[|"\n\r]|^\s|\s$/.test(v) ? JSON.stringify(v) : v);

function enumText(values: readonly unknown[]): string {
  const shown = values.slice(0, 12).map((v) => (v === null ? 'null' : enumValue(String(v))));
  return shown.join('|') + (values.length > 12 ? '|...' : '');
}

function objectLabel(doc: Obj, raw: Obj, depth: number): string {
  if (depth >= DEPTH_CUT) return 'object';
  const fields = fieldsOf(doc, raw, depth);
  if (fields.length > 0) return `{${fields.map((f) => `${f.name} ${f.type}`).join(', ')}}`;
  return isObj(raw.additionalProperties) ? `map<${typeLabel(doc, raw.additionalProperties, depth + 1)}>` : 'object';
}

/** A compact type: `string(date-time)`, `enum(a|b)`, `array<Pet>`, `{code integer, message string}`. A $ref prints as its name. */
function typeLabel(doc: Obj, raw: unknown, depth: number): string {
  const ref = refOf(raw);
  if (ref !== null) return refName(ref);
  if (!isObj(raw)) return 'any';
  const union = Array.isArray(raw.oneOf) ? raw.oneOf : Array.isArray(raw.anyOf) ? raw.anyOf : null;
  let t: string;
  if (Array.isArray(raw.enum)) t = `enum(${enumText(raw.enum)})`;
  else if (union !== null) t = union.map((m) => typeLabel(doc, m, depth + 1)).join('|');
  else if (Array.isArray(raw.allOf)) {
    const only = raw.allOf.length === 1 && Object.keys(raw).every((k) => k === 'allOf' || k === 'description' || k === 'nullable');
    t = only ? typeLabel(doc, raw.allOf[0], depth) : objectLabel(doc, raw, depth);
  } else if (raw.type === 'array') t = `array<${typeLabel(doc, raw.items, depth + 1)}>`;
  else if (raw.type === 'object' || isObj(raw.properties)) t = objectLabel(doc, raw, depth);
  else if (typeof raw.type === 'string') t = typeof raw.format === 'string' ? `${raw.type}(${raw.format})` : raw.type;
  else if (Array.isArray(raw.type)) t = raw.type.map(String).join('|');
  else t = 'any';
  return raw.nullable === true ? `${t}|null` : t;
}

type Operation = { readonly method: string; readonly path: string; readonly op: Obj; readonly params: readonly Obj[] };

/** Path-level parameters merged with the operation's own, the operation winning on the same name and location. */
function mergeParams(doc: Obj, shared: readonly unknown[], own: readonly unknown[]): Obj[] {
  const byKey = new Map<string, Obj>();
  for (const p of [...shared, ...own]) {
    const node = deref(doc, p).node;
    if (isObj(node) && typeof node.name === 'string') byKey.set(`${String(node.in)}:${node.name}`, node);
  }
  return [...byKey.values()];
}

function operationsOf(doc: Obj): Operation[] {
  const out: Operation[] = [];
  for (const [path, rawItem] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    const item = deref(doc, rawItem).node;
    if (!isObj(item)) continue;
    for (const m of HTTP_METHODS) {
      const op = item[m];
      if (isObj(op)) out.push({ method: m.toUpperCase(), path, op, params: mergeParams(doc, arr(item.parameters), arr(op.parameters)) });
    }
  }
  return out;
}

/** The JSON media type of a request body or response (form and other types after it), with its schema. */
function mediaOf(doc: Obj, holder: unknown): { type: string; media: Obj } | null {
  const node = deref(doc, holder).node;
  if (!isObj(node) || !isObj(node.content)) return null;
  const entries = Object.entries(node.content).filter((e): e is [string, Obj] => isObj(e[1]));
  const rank = (t: string): number => (t === 'application/json' ? 0 : t.includes('json') ? 1 : t === 'application/x-www-form-urlencoded' ? 2 : 3);
  const best = [...entries].sort((a, b) => rank(a[0]) - rank(b[0]))[0];
  return best === undefined ? null : { type: best[0], media: best[1] };
}

const responsesOf = (op: Obj): [string, unknown][] => Object.entries(isObj(op.responses) ? op.responses : {});
const isErrorStatus = (code: string): boolean => code === 'default' || /^[45]/.test(code);

function operationLines(doc: Obj, o: Operation): string[] {
  const what = text(o.op.summary) ?? text(o.op.operationId) ?? (text(o.op.description)?.split('\n')[0] ?? '');
  const lines = [`${o.method} ${o.path}: ${what.trim()}`];
  if (o.params.length > 0) {
    lines.push(`  params: ${o.params.map((p) => `${String(p.name)} ${String(p.in)} ${typeLabel(doc, p.schema, 0)}${p.required === true ? ' required' : ''}`).join(', ')}`);
  }
  const body = mediaOf(doc, o.op.requestBody);
  if (body !== null) {
    const fields = fieldsOf(doc, body.media.schema, 0);
    lines.push(`  body (${body.type}): ${fields.length > 0 ? fields.map(fieldText).join(', ') : typeLabel(doc, body.media.schema, 0)}`);
  }
  const responses = responsesOf(o.op).map(([code, r]) => {
    const m = mediaOf(doc, r);
    return m === null ? code : `${code} ${typeLabel(doc, m.media.schema, 0)}`;
  });
  if (responses.length > 0) lines.push(`  responses: ${responses.join(', ')}`);
  return lines;
}

/** Component schemas the kept operations reach, through properties, items and compositions, up to the depth cut. First seen first. */
function schemasReached(doc: Obj, kept: readonly Operation[]): string[] {
  const names: string[] = [];
  const depthOf = new Map<string, number>();
  const visit = (node: unknown, depth: number): void => {
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth);
      return;
    }
    if (!isObj(node)) return;
    const ref = refOf(node);
    if (ref !== null) {
      if (!ref.startsWith('#/')) return;
      const isSchema = ref.startsWith(SCHEMA_REF);
      const d = isSchema ? depth + 1 : depth;
      const seen = depthOf.get(ref);
      if (d > DEPTH_CUT || (seen !== undefined && seen <= d)) return;
      depthOf.set(ref, d);
      if (isSchema && seen === undefined) names.push(ref);
      visit(pointerGet(doc, ref), d);
      return;
    }
    for (const [k, v] of Object.entries(node)) if (k !== 'example' && k !== 'examples') visit(v, depth);
  };
  for (const o of kept) visit([o.params, o.op.requestBody, o.op.responses], 0);
  return names;
}

function schemaLine(doc: Obj, ref: string): string {
  if (deref(doc, { $ref: ref }).node === undefined) return `  ${refName(ref)}: unresolved $ref`;
  const node = pointerGet(doc, ref);
  const fields = fieldsOf(doc, node, 0);
  return `  ${refName(ref)}: ${fields.length > 0 ? fields.map(fieldText).join(', ') : typeLabel(doc, node, 0)}`;
}

/** The error schema most error responses of the kept operations use, with how many use it. */
function sharedErrorSchema(doc: Obj, kept: readonly Operation[]): { label: string; schema: unknown; count: number; total: number } | null {
  const groups = new Map<string, { schema: unknown; count: number }>();
  let total = 0;
  for (const o of kept) {
    for (const [code, r] of responsesOf(o.op)) {
      const m = isErrorStatus(code) ? mediaOf(doc, r) : null;
      if (m === null) continue;
      total++;
      const label = typeLabel(doc, m.media.schema, 0);
      const g = groups.get(label) ?? { schema: m.media.schema, count: 0 };
      g.count++;
      groups.set(label, g);
    }
  }
  let best: { label: string; schema: unknown; count: number; total: number } | null = null;
  for (const [label, g] of groups) if (best === null || g.count > best.count) best = { label, schema: g.schema, count: g.count, total };
  return best;
}

const STATUS_SLOT = ['status', 'status_code', 'statusCode', 'http_status', 'code'];
const CODE_SLOT = ['code', 'error_code', 'errorCode', 'error', 'type', 'reason'];
const MESSAGE_SLOT = ['message', 'detail', 'error_description', 'error_message', 'msg', 'description', 'title'];

/**
 * meta.api.error from an error schema: a numeric status field becomes $status, a code field $code,
 * a message field $message, a string with an example or enum keeps that constant, other fields drop.
 * Null when no field takes $code or $message.
 */
function errorTemplate(doc: Obj, raw: unknown): unknown {
  const taken = new Set<string>();
  const build = (node: unknown, depth: number): Record<string, unknown> | null => {
    const s = mergeAllOf(doc, deref(doc, node).node, depth);
    if (depth >= DEPTH_CUT || !isObj(s.properties)) return null;
    const props = Object.entries(s.properties).map(([k, v]) => [k, mergeAllOf(doc, deref(doc, v).node, depth + 1)] as const);
    const holders: string[] = [];
    const holder = (slot: string, names: readonly string[], types: readonly string[]): string | null => {
      if (taken.has(slot)) return null;
      const found = names.find((n) => props.some(([k, p]) => k === n && types.includes(String(p.type)) && !holders.includes(k)));
      if (found === undefined) return null;
      taken.add(slot);
      return found;
    };
    const status = holder('status', STATUS_SLOT, ['integer', 'number']);
    if (status !== null) holders.push(status);
    const code = holder('code', CODE_SLOT, ['string']);
    if (code !== null) holders.push(code);
    const message = holder('message', MESSAGE_SLOT, ['string']);
    const out: Record<string, unknown> = {};
    for (const [k, p] of props) {
      if (k === status) out[k] = '$status';
      else if (k === code) out[k] = '$code';
      else if (k === message) out[k] = '$message';
      else if (isObj(p.properties) || Array.isArray(p.allOf)) {
        const sub = build(p, depth + 1);
        if (sub !== null) out[k] = sub;
      } else if (p.type === 'string' && (typeof p.example === 'string' || typeof arr(p.enum)[0] === 'string')) {
        out[k] = typeof p.example === 'string' ? p.example : arr(p.enum)[0];
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  };
  const t = build(raw, 0);
  return t !== null && (taken.has('code') || taken.has('message')) ? t : null;
}

const CURSOR_FIELD = /^(next_?cursor|cursor|next|next_?page|next_?page_?token|next_?token|has_?more)$/i;
const LIMIT_PARAMS = ['limit', 'page_size', 'pageSize', 'per_page', 'perPage', 'max_results', 'maxResults'];
const CURSOR_PARAMS = ['cursor', 'starting_after', 'after', 'page_token', 'pageToken', 'next_token', 'nextToken'];
const STARTING_AFTER_PARAMS = ['starting_after', 'startingAfter', 'after'];
const ENDING_BEFORE_PARAMS = ['ending_before', 'endingBefore', 'before'];

type ListShape = { dataKey: string; cursorKey: string | null; hasMore: boolean };

/** The envelope of one list operation: the GET 2xx object with one data array and an optional cursor field, which is a has_more flag when only a boolean matches. */
function listEnvelope(doc: Obj, o: Operation): ListShape | null {
  if (o.method !== 'GET') return null;
  const ok = responsesOf(o.op).find(([code]) => /^2/.test(code));
  const m = ok === undefined ? null : mediaOf(doc, ok[1]);
  if (m === null) return null;
  const s = mergeAllOf(doc, deref(doc, m.media.schema).node, 0);
  if (!isObj(s.properties)) return null;
  const props = Object.entries(s.properties).map(([k, v]) => [k, mergeAllOf(doc, deref(doc, v).node, 1)] as const);
  const arrays = props.filter(([, p]) => p.type === 'array').map(([k]) => k);
  const dataKey = arrays.length === 1 ? arrays[0]! : arrays.find((k) => ['data', 'items', 'results', 'records'].includes(k));
  if (dataKey === undefined) return null;
  const cursors = props.filter(([k]) => k !== dataKey && CURSOR_FIELD.test(k));
  const cursor = cursors.find(([, p]) => p.type !== 'boolean') ?? cursors[0];
  return { dataKey, cursorKey: cursor === undefined ? null : cursor[0], hasMore: cursor !== undefined && cursor[1].type === 'boolean' };
}

const API_SHAPE = worldSchema.shape.meta.shape.api;

function apiShapeOf(doc: Obj, kept: readonly Operation[], error: { schema: unknown } | null): { shape: World['meta']['api'] | null; lines: string[] } {
  const lines: string[] = [];
  const lists = kept.flatMap((o) => {
    const l = listEnvelope(doc, o);
    return l === null ? [] : [{ o, ...l }];
  });
  let list: Record<string, string> | null = null;
  const first = lists[0];
  if (first === undefined) {
    lines.push('List envelope: none (no GET response wraps a data array).');
  } else if (first.cursorKey === null || !lists.every((l) => l.dataKey === first.dataKey && l.cursorKey === first.cursorKey && l.hasMore === first.hasMore)) {
    lines.push(`List envelope: not shared (${[...new Set(lists.map((l) => `${l.dataKey}+${l.cursorKey ?? 'no cursor'}`))].join(', ')}).`);
  } else {
    const shared = (names: readonly string[]): string | undefined =>
      names.find((n) => lists.every((l) => l.o.params.some((p) => p.in === 'query' && p.name === n)));
    const limitParam = shared(LIMIT_PARAMS);
    const optional = (key: string, value: string | undefined): Record<string, string> => (value === undefined ? {} : { [key]: value });
    list = first.hasMore
      ? { mode: 'stripe', dataKey: first.dataKey, hasMoreKey: first.cursorKey, ...optional('limitParam', limitParam),
        ...optional('startingAfterParam', shared(STARTING_AFTER_PARAMS)), ...optional('endingBeforeParam', shared(ENDING_BEFORE_PARAMS)) }
      : { dataKey: first.dataKey, cursorKey: first.cursorKey, ...optional('limitParam', limitParam), ...optional('cursorParam', shared(CURSOR_PARAMS)) };
    const paging = first.hasMore ? ' (boolean, so stripe paging)' : '';
    lines.push(`List envelope: ${first.dataKey} array with ${first.cursorKey}${paging}, shared by ${lists.length} list operation${lists.length === 1 ? '' : 's'}.`);
  }
  const template = error === null ? null : errorTemplate(doc, error.schema);
  if (list === null && template === null) return { shape: null, lines };
  const shape = API_SHAPE.parse({ list: list ?? {}, ...(template === null ? {} : { error: template }) });
  lines.push(`Proposed meta.api: ${JSON.stringify(shape)}`);
  return { shape, lines };
}

/** The keys and scalar types of an example body. Values are dropped. */
function shapeOf(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth >= 8 || v.length === 0 ? [] : [shapeOf(v[0], depth + 1)];
  if (isObj(v)) return depth >= 8 ? 'object' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function observationsOf(doc: Obj, kept: readonly Operation[]): Observation[] {
  const out: Observation[] = [];
  for (const o of kept) {
    for (const [code, r] of responsesOf(o.op)) {
      const m = /^\d{3}$/.test(code) ? mediaOf(doc, r) : null;
      if (m === null) continue;
      const add = (body: unknown): void => {
        out.push({ method: o.method, path: o.path, status: Number(code), bodyShape: shapeOf(body) });
      };
      if (m.media.example !== undefined) add(m.media.example);
      for (const ex of Object.values(isObj(m.media.examples) ? m.media.examples : {})) {
        const e = deref(doc, ex).node;
        if (isObj(e) && e.value !== undefined) add(e.value);
      }
    }
  }
  return out;
}

function digestOpenapi(loaded: Redacted<LoadedKinds['openapi']>): InputDigest {
  const doc = loaded.document;
  if (!isObj(doc)) throw new Error('The OpenAPI document is not a mapping.');
  const all = operationsOf(doc);
  if (all.length === 0) throw new Error('The OpenAPI document has no operations.');
  const kept = all.filter((o) => underPrefix(o.path, loaded.only));
  if (kept.length === 0) {
    const paths = [...new Set(all.map((o) => o.path))];
    throw new Error(`No operation path starts with ${loaded.only.join(', ')}. Paths: ${paths.slice(0, 12).join(', ')}${paths.length > 12 ? ', ...' : ''}.`);
  }
  const info = isObj(doc.info) ? doc.info : {};
  const version = text(info.version);
  const lines = [`OpenAPI ${String(doc.openapi)}: ${text(info.title) ?? 'untitled'}${version === null ? '' : `, version ${version}`}`];
  const about = text(info.description)?.trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ');
  if (about !== undefined && about !== '') lines.push(`About: ${about.slice(0, 300)}`);
  const server = isObj(arr(doc.servers)[0]) ? text((arr(doc.servers)[0] as Obj).url) : null;
  if (server !== null) lines.push(`Server: ${server}`);
  const schemes = isObj(doc.components) && isObj(doc.components.securitySchemes) ? Object.entries(doc.components.securitySchemes) : [];
  if (schemes.length > 0) {
    lines.push(`Auth: ${schemes.map(([n, s]) => [n, ...SCHEME_KEYS.map((k) => (isObj(s) ? text(s[k]) : null))].filter((x) => x !== null).join(' ')).join('; ')}`);
  }
  const under = loaded.only.length > 0 ? ` under ${loaded.only.join(', ')}` : '';
  lines.push(`Operations: kept ${kept.length} of ${all.length}${under}; dropped ${all.length - kept.length}.`);
  for (const o of kept) lines.push(...operationLines(doc, o));
  const schemas = schemasReached(doc, kept);
  if (schemas.length > 0) lines.push('Schemas:', ...schemas.map((ref) => schemaLine(doc, ref)));
  const error = sharedErrorSchema(doc, kept);
  lines.push(error === null ? 'Error schema: none declared.' : `Error schema: ${error.label}, used by ${error.count} of ${error.total} error responses.`);
  const api = apiShapeOf(doc, kept, error);
  lines.push(...api.lines);
  const sourceFields = [...new Set(schemas.flatMap((ref) => fieldsOf(doc, pointerGet(doc, ref), 0).map((f) => f.name)))];
  return { kind: 'openapi', summary: capSummary(lines), fixtures: {}, operations: kept.map(({ method, path }) => ({ method, path })), observations: observationsOf(doc, kept), apiShape: api.shape, sourceFields };
}

// ---------------------------------------------------------------------------------------------
// CSV. RFC 4180 by hand; column types from FIELD_TYPES in FIELD_TYPE_ORDER.

/** Rows per table that reach world.fixtures. */
export const FIXTURE_ROWS_MAX = 2000;
/** Share of a column's values that must match another table's key for a likely ref. */
const REF_MATCH_MIN = 0.95;

/** Parses RFC 4180 CSV: quoted fields with "" escapes, embedded commas and newlines, CRLF or LF. Blank lines are skipped. */
export function parseCsv(content: string, file: string): string[][] {
  const src = content.startsWith('﻿') ? content.slice(1) : content;
  const records: string[][] = [];
  const starts: number[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  /** The current field has started (a quote or a character), so a later quote is literal. */
  let fieldBegun = false;
  /** The current record has any content, so it is not a blank line. */
  let rowBegun = false;
  let line = 1;
  let rowLine = 1;
  let quoteLine = 1;
  const endRecord = (): void => {
    row.push(field);
    if (rowBegun) {
      records.push(row);
      starts.push(rowLine);
    }
    row = [];
    field = '';
    fieldBegun = false;
    rowBegun = false;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        if (c === '\n' || (c === '\r' && src[i + 1] !== '\n')) line++;
        field += c;
      }
    } else if (c === '"' && !fieldBegun) {
      quoted = true;
      fieldBegun = true;
      rowBegun = true;
      quoteLine = line;
    } else if (c === ',') {
      row.push(field);
      field = '';
      fieldBegun = false;
      rowBegun = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      endRecord();
      line++;
      rowLine = line;
    } else {
      field += c;
      fieldBegun = true;
      rowBegun = true;
    }
  }
  if (quoted) throw new Error(`${file}: the quoted field opened on line ${quoteLine} is never closed.`);
  if (rowBegun) endRecord();
  const width = records[0]?.length ?? 0;
  records.forEach((r, i) => {
    if (r.length !== width) throw new Error(`${file} line ${starts[i]}: ${r.length} fields, the header has ${width}.`);
  });
  return records;
}

/** snake_case column names, unique within the table. A blank header becomes column_<n>. */
function columnNames(header: readonly string[]): string[] {
  const out: string[] = [];
  header.forEach((h, i) => {
    const base = snakeCase(h) || `column_${i + 1}`;
    let name = /^[a-z]/.test(base) ? base : `c_${base}`;
    for (let n = 2; out.includes(name); n++) name = `${base}_${n}`;
    out.push(name);
  });
  return out;
}

async function loadCsv(input: Extract<Input, { kind: 'csv' }>): Promise<LoadedKinds['csv']> {
  const tables: { name: string; header: string[]; rows: string[][] }[] = [];
  for (const path of input.paths) {
    const records = parseCsv(await readText(path, 'CSV file'), path);
    const [header, ...rows] = records;
    if (header === undefined) throw new Error(`${path} is empty.`);
    const stem = snakeCase(basename(path, extname(path)));
    const name = stem === '' ? 'table' : /^[a-z]/.test(stem) ? stem : `t_${stem}`;
    if (tables.some((t) => t.name === name)) throw new Error(`Two CSV files map to the table name ${name}. Rename one.`);
    tables.push({ name, header: columnNames(header), rows });
  }
  return { tables, note: input.note ?? null };
}

function redactCsv(loaded: LoadedKinds['csv']): LoadedKinds['csv'] {
  return {
    tables: loaded.tables.map((t) => {
      const secret = t.header.map(isCredentialName);
      return {
        name: maskSecrets(t.name),
        header: t.header.map(maskSecrets),
        rows: t.rows.map((r) => r.map((cell, i) => (secret[i] === true && cell.trim() !== '' ? MASK : maskSecrets(cell)))),
      };
    }),
    note: loaded.note === null ? null : maskSecrets(loaded.note),
  };
}

const isBlank = (cell: string): boolean => cell.trim() === '';

/** The first type in FIELD_TYPE_ORDER whose inferFromCsv accepts the column, or null for an all-blank column. */
function inferField(cells: readonly string[]): Field | null {
  for (const t of FIELD_TYPE_ORDER) {
    const def = FIELD_TYPES[t].inferFromCsv(cells);
    if (def !== null) return def;
  }
  return null;
}

type CellCheck = { ok: true; value: Value } | { ok: false; expected: string };
type CellCodec = { parseQuery(raw: string, def: Field): CellCheck; validate(value: unknown, def: Field): CellCheck; compare(a: Value, b: Value, def: Field): number };
const codecOf = (def: Field): CellCodec => FIELD_TYPES[def.type];

/** A cell as a Value of its column's type: parsed like a query value, then validated (datetimes become canonical). Blank is null. */
function cellValue(cell: string, def: Field | null): Value {
  if (def === null || isBlank(cell)) return null;
  const codec = codecOf(def);
  const parsed = codec.parseQuery(cell, def);
  const value = parsed.ok ? parsed.value : cell;
  const valid = codec.validate(value, def);
  return valid.ok ? valid.value : value;
}

type ColumnProfile = {
  readonly name: string;
  readonly cells: readonly string[];
  readonly def: Field | null;
  readonly blanks: number;
  readonly distinct: number;
  readonly key: boolean;
  ref: { table: string; column: string; ratio: number } | null;
};
type TableProfile = { readonly name: string; readonly rows: number; readonly columns: readonly ColumnProfile[]; readonly primary: ColumnProfile | null };

/** customers -> customer, categories -> category, addresses -> address. */
export function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('sses') || name.endsWith('xes')) return name.slice(0, -2);
  return name.endsWith('s') && !name.endsWith('ss') ? name.slice(0, -1) : name;
}

function profileTable(t: LoadedKinds['csv']['tables'][number]): TableProfile {
  const columns = t.header.map((name, i): ColumnProfile => {
    const cells = t.rows.map((r) => r[i] ?? '');
    const filled = cells.filter((c) => !isBlank(c));
    const distinct = new Set(filled).size;
    return { name, cells, def: inferField(cells), blanks: cells.length - filled.length, distinct, key: cells.length > 0 && filled.length === cells.length && distinct === cells.length, ref: null };
  });
  const primary = columns.find((c) => c.key && c.name === 'id') ?? columns.find((c) => c.key && c.name === `${singular(t.name)}_id`) ?? columns.find((c) => c.key) ?? null;
  return { name: t.name, rows: t.rows.length, columns, primary };
}

/**
 * A column is a likely ref to another table when at least 95% of its filled cells are that table's
 * key values, and either its name points at the table (ends in id, or names it) or the key is not a
 * plain integer (integer keys match any small count column). Self-refs are not looked for.
 */
function findRefs(tables: readonly TableProfile[]): void {
  for (const a of tables) {
    for (const c of a.columns) {
      // A table's own key by name (id, customer_id in customers) is never a ref. A fallback key such as profiles.user_id can be.
      const filled = c.cells.filter((x) => !isBlank(x));
      if (c.name === 'id' || c.name === `${singular(a.name)}_id` || filled.length === 0) continue;
      let best: { table: string; column: string; ratio: number; named: boolean } | null = null;
      for (const b of tables) {
        if (b === a || b.primary === null) continue;
        const keys = new Set(b.primary.cells);
        const ratio = filled.filter((x) => keys.has(x)).length / filled.length;
        const words = c.name.split('_');
        const named = /id$/.test(c.name) || words.includes(singular(b.name)) || words.includes(b.name);
        if (ratio < REF_MATCH_MIN || !(named || FIELD_TYPES.int.inferFromCsv(b.primary.cells) === null)) continue;
        if (best === null || ratio > best.ratio || (ratio === best.ratio && named && !best.named)) best = { table: b.name, column: b.primary.name, ratio, named };
      }
      if (best !== null) c.ref = { table: best.table, column: best.column, ratio: best.ratio };
    }
  }
}

function columnLine(c: ColumnProfile, rows: number): string {
  const parts: string[] = [];
  if (c.ref !== null) parts.push(`ref(${c.ref.table}.${c.ref.column}${c.ref.ratio < 1 ? `, ${Math.floor(c.ref.ratio * 100)}% match` : ''})`);
  else if (c.def === null) parts.push('empty');
  else parts.push('values' in c.def ? `${c.def.type}(${c.def.values.map(enumValue).join('|')})` : c.def.type);
  parts.push(`null ${(rows === 0 ? 0 : c.blanks / rows).toFixed(2)}`, `${c.distinct} distinct`);
  if (c.key) parts.push('key');
  const def = c.def;
  const filled = c.cells.filter((x) => !isBlank(x));
  if (c.ref === null && def !== null && temporalOf(def) && filled.length > 0) {
    const order = (x: string, y: string) => codecOf(def).compare(cellValue(x, def), cellValue(y, def), def);
    const earliest = filled.reduce((m, x) => (order(x, m) < 0 ? x : m));
    const latest = filled.reduce((m, x) => (order(x, m) > 0 ? x : m));
    parts.push(`from ${JSON.stringify(earliest)} to ${JSON.stringify(latest)}`);
  } else if (filled[0] !== undefined && !(c.ref === null && def !== null && 'values' in def)) {
    const sample = filled[0];
    parts.push(`e.g. ${JSON.stringify(sample.length > 40 ? `${sample.slice(0, 40)}...` : sample)}`);
  }
  return `  ${c.name}: ${parts.join(', ')}`;
}

function digestCsv(loaded: Redacted<LoadedKinds['csv']>): InputDigest {
  const tables = loaded.tables.map(profileTable);
  findRefs(tables);
  const lines = [`CSV: ${tables.length} table${tables.length === 1 ? '' : 's'} (${tables.map((t) => t.name).join(', ')}). Fixtures keep up to ${FIXTURE_ROWS_MAX} rows per table.`];
  if (loaded.note !== null && loaded.note.trim() !== '') lines.push(`Note: ${loaded.note.trim()}`);
  for (const t of tables) {
    const kept = Math.min(t.rows, FIXTURE_ROWS_MAX);
    lines.push(`Table ${t.name}: ${t.rows} rows${kept < t.rows ? ` (fixtures keep ${kept})` : ''}, key ${t.primary?.name ?? 'none'}`);
    for (const c of t.columns) lines.push(columnLine(c, t.rows));
  }
  const fixtures = Object.fromEntries(
    tables.map((t) => [
      t.name,
      Array.from({ length: Math.min(t.rows, FIXTURE_ROWS_MAX) }, (_, r) => Object.fromEntries(t.columns.map((c) => [c.name, cellValue(c.cells[r] ?? '', c.def)]))),
    ]),
  );
  const sourceFields = [...new Set(tables.flatMap((t) => t.columns.map((c) => c.name)))];
  return { kind: 'csv', summary: capSummary(lines), fixtures, operations: [], observations: [], apiShape: null, sourceFields };
}

const SLUG_MAX = 40;
/** A file name without its directories and last extension: `inputs/orders.csv` is `orders`. */
const stem = (file: string): string => (file.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '');

/**
 * A directory name for a run's default output: lowercase ASCII words joined by `-`, at most 40
 * characters, cut at a word boundary. A description uses its words, an OpenAPI spec its file
 * stem plus the `--only` prefixes, CSV its first file's stem. `world` when nothing is left.
 */
export function inputSlug(input: Input): string {
  let source: string;
  switch (input.kind) {
    case 'description':
      source = input.text;
      break;
    case 'openapi':
      source = [stem(input.path), ...input.only].join(' ');
      break;
    case 'csv':
      source = stem(input.paths[0] ?? '');
      break;
    default:
      return assertNever(input);
  }
  const words = source.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w !== '');
  let slug = '';
  for (const w of words) {
    const next = slug === '' ? w.slice(0, SLUG_MAX) : `${slug}-${w}`;
    if (next.length > SLUG_MAX) break;
    slug = next;
  }
  return slug === '' ? 'world' : slug;
}

/** Directory name under `prod/worlds/` for a run with no `--out` (decision A-44): `gen-` plus the input's slug. */
export function genDirName(input: Input): string {
  return `gen-${inputSlug(input)}`;
}
