/**
 * Studio uploads (YOS-188): what an OpenAPI spec or CSV table an operator uploads must be, its id, and where it lives.
 * Pure: the server reads and writes the files.
 *
 * Invariants:
 * - A file lives at <shelf root>/.uploads/<sha12>/<name>. sha12 addresses the kind, name and content, so the same
 *   upload twice is one file, and the original name stays because the CSV adapter names each table from it.
 * - An id is `<sha12>-<name>` and resolves only through `uploadPartsOf`: no separator, no dot segment, so an id can
 *   never name a path outside the caller's own .uploads dir.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { assertNever } from '#lib/never';

export const UPLOAD_KINDS = ['openapi', 'csv'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];
/** The directory of a shelf that holds its uploads. A dot dir, so no walker of the worlds dir reads it as a world. */
export const UPLOADS_DIR = '.uploads';
/** Largest upload content, in UTF-8 bytes. */
export const MAX_UPLOAD_BYTES = 524_288;
/** Most uploads one tenant stores. */
export const MAX_UPLOADS = 100;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ID = /^([0-9a-f]{12})-([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/;
const EXTENSION: Readonly<Record<UploadKind, RegExp>> = { openapi: /\.(ya?ml|json)$/i, csv: /\.csv$/i };
const EXTENSION_RULE: Readonly<Record<UploadKind, string>> = { openapi: 'an openapi upload is named .yaml, .yml or .json', csv: 'a csv upload is named .csv' };

export type Upload = { readonly kind: UploadKind; readonly name: string; readonly content: string; readonly paths: readonly string[] | undefined };
type Refusal = { readonly ok: false; readonly code: string; readonly message: string };

const refuse = (code: string, message: string): Refusal => ({ ok: false, code, message });

/** The kind a stored file name belongs to, from its extension; null for a name no upload may have. */
export function kindOfName(name: string): UploadKind | null {
  if (!NAME.test(name)) return null;
  return UPLOAD_KINDS.find((k) => EXTENSION[k].test(name)) ?? null;
}

/** The sorted path keys of an OpenAPI or Swagger document's text, or why it is not one. */
export function openapiPaths(text: string): { ok: true; paths: string[] } | { ok: false; why: string } {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    return { ok: false, why: `the spec does not parse as YAML or JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { ok: false, why: 'the spec is not a YAML or JSON object' };
  const fields = new Map(Object.entries(doc));
  if (typeof fields.get('openapi') !== 'string' && typeof fields.get('swagger') !== 'string') {
    return { ok: false, why: 'the spec has no openapi or swagger version string' };
  }
  const paths = fields.get('paths');
  if (typeof paths !== 'object' || paths === null || Array.isArray(paths)) return { ok: false, why: 'the spec has no paths object' };
  return { ok: true, paths: Object.keys(paths).sort() };
}

/** Whether a CSV's first line is a header: not empty, with at least one non-empty comma-separated cell. */
const hasHeader = (text: string): boolean => (text.split(/\r?\n/)[0] ?? '').split(',').some((cell) => cell.trim() !== '');

/** A POST /api/uploads body, checked, or the refusal: a code under `upload.` and one plain message. */
export function parseUpload(body: unknown): { ok: true; upload: Upload } | Refusal {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('upload.body', 'the body must be a JSON object: {"kind", "name", "content"}');
  const fields = new Map(Object.entries(body));
  const kind = UPLOAD_KINDS.find((k) => k === fields.get('kind'));
  if (kind === undefined) return refuse('upload.kind', 'kind must be openapi or csv');
  const name = fields.get('name');
  if (typeof name !== 'string' || !NAME.test(name)) {
    return refuse('upload.name', 'name must be a bare file name: 1 to 100 letters, digits, dots, underscores or dashes, starting with a letter or digit');
  }
  if (!EXTENSION[kind].test(name)) return refuse('upload.extension', EXTENSION_RULE[kind]);
  const content = fields.get('content');
  if (typeof content !== 'string') return refuse('upload.content', 'content must be the file\'s text');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_UPLOAD_BYTES) return refuse('upload.too_large', `content is ${bytes} bytes; the most is ${MAX_UPLOAD_BYTES}`);
  if (content.includes('\0')) return refuse('upload.nul', 'content holds a NUL character, so it is not a text file');
  switch (kind) {
    case 'openapi': {
      const spec = openapiPaths(content);
      return spec.ok ? { ok: true, upload: { kind, name, content, paths: spec.paths } } : refuse('upload.openapi', spec.why);
    }
    case 'csv':
      return hasHeader(content) ? { ok: true, upload: { kind, name, content, paths: undefined } } : refuse('upload.csv', 'the first line must be a header with at least one named column');
    default:
      return assertNever(kind);
  }
}

/** The content address of an upload and the id it answers to. */
export function uploadIdOf(u: Pick<Upload, 'kind' | 'name' | 'content'>): { sha12: string; id: string } {
  const sha12 = createHash('sha256').update(`${u.kind}\0${u.name}\0${u.content}`).digest('hex').slice(0, 12);
  return { sha12, id: `${sha12}-${u.name}` };
}

/** The parts of an upload id, or null when it is not one. */
export function uploadPartsOf(id: string): { sha12: string; name: string; kind: UploadKind } | null {
  const m = ID.exec(id);
  const sha12 = m?.[1];
  const name = m?.[2];
  if (sha12 === undefined || name === undefined) return null;
  const kind = kindOfName(name);
  return kind === null ? null : { sha12, name, kind };
}

/** Where an upload lives under a shelf root. */
export const uploadFileOf = (shelfRoot: string, sha12: string, name: string): string => path.join(shelfRoot, UPLOADS_DIR, sha12, name);
