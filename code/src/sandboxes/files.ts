/**
 * What goes into a sandbox, and where it waits on the host. Shell code: reads and writes the fs.
 *
 * `collectBundle()` reads the code package and one world into memory. The package lands at the
 * sandbox workdir root, so `bun install` and `bun src/cli/worldplay.ts` run there; the world lands under
 * `worlds/<name>/`. `dirWorkspace()` materializes a bundle into a host directory named after the
 * sandbox, so a later `down` in another process finds it again.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SandboxError, assertSandboxName, type SandboxFile, type WorldBundle } from './backend.ts';

/** Package-root files a served world needs. The first two are required: `bun install --frozen-lockfile` reads both. */
const REQUIRED_ROOT_FILES = ['package.json', 'bun.lock'] as const;
const OPTIONAL_ROOT_FILES = ['worldgen.config.json', 'models.json', 'package-lock.json'] as const;
const TSCONFIG = /^tsconfig.*\.json$/;
/** Directories never copied, at any depth: installed deps and run output. */
const SKIP_DIRS = new Set(['node_modules', 'runs']);
export const WORLDS_DIR = 'worlds';
const WORLD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Regular files under `dir`, as POSIX paths relative to it. Symlinks are not followed. */
async function walkFiles(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...(await walkFiles(dir, child)));
    } else if (entry.isFile()) {
      out.push(child);
    }
  }
  return out;
}

async function read(root: string, rel: string, as = rel): Promise<SandboxFile> {
  return { path: as, data: await readFile(path.join(root, ...rel.split('/'))) };
}

export type BundleOptions = {
  /**
   * Upload only the public form of the world: `<worldDir>/public/world.yaml` becomes
   * `worlds/<basename>/world.yaml`, and nothing else under `worldDir` is uploaded, so no grader,
   * reference solution or decoy source reaches the sandbox (YOS-159). The public form is written
   * by the trusted side (dataset/pipeline.ts prepareWorld, through saveWorld); this option is
   * the upload rule, so it holds even if the world directory also holds the private world.yaml.
   * Without it the whole world directory is uploaded, graders included: the trusted-machine
   * demo path (`bun run sandbox up`, scripts/solve-demo.sh), which grades on the sandbox's admin port.
   */
  readonly publicOnly?: boolean;
};

/**
 * The code package at `codeDir` (root config files and `src/**`) plus the world at `worldDir`
 * under `worlds/<basename>/`. Sorted by path, so the same trees give the same bundle.
 */
export async function collectBundle(codeDir: string, worldDir: string, opts: BundleOptions = {}): Promise<WorldBundle> {
  for (const name of REQUIRED_ROOT_FILES) {
    if (!(await isFile(path.join(codeDir, name)))) throw new SandboxError(`${path.join(codeDir, name)} not found: the sandbox runs bun install from it`);
  }
  if (!(await isFile(path.join(codeDir, 'src', 'cli', 'worldplay.ts')))) {
    throw new SandboxError(`${codeDir} is not the code package: src/cli/worldplay.ts not found`);
  }
  const worldName = path.basename(path.resolve(worldDir));
  if (!WORLD_NAME.test(worldName)) throw new SandboxError(`bad world folder name ${JSON.stringify(worldName)}: use letters, digits, dots, dashes and underscores`);
  const world = `${WORLDS_DIR}/${worldName}`;

  const rootNames = (await readdir(codeDir, { withFileTypes: true }))
    .filter((e) => e.isFile() && (TSCONFIG.test(e.name) || [...REQUIRED_ROOT_FILES, ...OPTIONAL_ROOT_FILES].some((n) => n === e.name)))
    .map((e) => e.name);
  const files: SandboxFile[] = [];
  for (const name of rootNames) files.push(await read(codeDir, name));
  for (const rel of await walkFiles(codeDir, 'src')) files.push(await read(codeDir, rel));
  if (opts.publicOnly === true) {
    const publicForm = path.join(worldDir, 'public', 'world.yaml');
    if (!(await isFile(publicForm))) {
      throw new SandboxError(`${publicForm} not found: a public-only bundle needs the public form of the world (YOS-159)`);
    }
    files.push({ path: `${world}/world.yaml`, data: await readFile(publicForm) });
  } else {
    if (!(await isFile(path.join(worldDir, 'world.yaml')))) throw new SandboxError(`${path.join(worldDir, 'world.yaml')} not found`);
    for (const rel of await walkFiles(worldDir)) files.push(await read(worldDir, rel, `${world}/${rel}`));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, world };
}

/** Where a bundle is written on the host before upload (OpenShell) or mount (sbx). */
export interface Workspace {
  /** The host directory for sandbox `name`. Pure: the same name gives the same path. */
  path(name: string): string;
  /** Replaces the directory for `name` with exactly `files`, and returns its path. */
  write(name: string, files: readonly SandboxFile[]): Promise<string>;
  /** Deletes the directory for `name`. Missing is fine. */
  remove(name: string): Promise<void>;
}

/** A file path inside a sandbox: relative, POSIX, no empty, `.` or `..` segment. */
function assertRelative(p: string): void {
  const segments = p.split('/');
  if (p.includes('\\') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new SandboxError(`bad sandbox file path ${JSON.stringify(p)}: use a relative POSIX path without . or .. segments`);
  }
}

/** A Workspace under `root`, one subdirectory per sandbox name. */
export function dirWorkspace(root: string = path.join(tmpdir(), 'worldgen-sandboxes')): Workspace {
  const dirOf = (name: string): string => {
    assertSandboxName(name);
    return path.join(root, name);
  };
  return {
    path: dirOf,
    async write(name, files) {
      files.forEach((f) => assertRelative(f.path));
      const dir = dirOf(name);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      for (const f of files) {
        const target = path.join(dir, ...f.path.split('/'));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, f.data);
      }
      return dir;
    },
    async remove(name) {
      await rm(dirOf(name), { recursive: true, force: true });
    },
  };
}
