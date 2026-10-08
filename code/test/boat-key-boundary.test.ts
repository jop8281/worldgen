/**
 * The Boat key boundary (YOS-245, A-350): BOAT_BASE_URL names only https on boat.dev, or loopback http behind an explicit
 * test variable, and the key is never read from a .env file. No test here reads BOAT_API_KEY from the process or reaches
 * boat.dev; the fake boat.dev is a loopback server that counts its hits.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BoatError, boatBaseUrl, boatClientFromEnv, type FetchFn } from '../src/boat/client.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const KEY = 'boat-test-key-0245';
const REFUSAL = 'BOAT_BASE_URL must be https on boat.dev with no credentials, query or fragment, or http on a loopback address with WORLDGEN_BOAT_LOOPBACK=1, because every request carries the key; got';
const ONLY_BUN = process.versions.bun === undefined ? 'needs Bun: loading .env is what Bun does and Node does not' : false;

let tmp = '';
before(async () => { tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'worldgen-boat-key-'))); });
after(async () => { await rm(tmp, { recursive: true, force: true }); });

/** A fake boat.dev on loopback: answers the inventory list and counts every request it gets. */
async function fakeBoat(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${new URL(req.url ?? '/', 'http://boat.test').pathname}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, type: 'sandbox.list', sandboxes: [], pageInfo: { nextCursor: null, hasMore: false, limit: 200 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { url: `http://127.0.0.1:${address.port}/v1`, hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function run(argv: readonly string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { PATH: process.env['PATH'] ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += String(d)));
    child.stderr.on('data', (d: Buffer) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe('BOAT_BASE_URL', () => {
  it('accepts https on boat.dev, and the default when unset, as the parsed origin and path the SDK appends to', () => {
    assert.deepEqual(['', '  ', 'https://boat.dev/api/v1', 'https://boat.dev/api/v1/', 'HTTPS://BOAT.DEV/api/v1', 'https:boat.dev/api/v1', 'https://boat.dev:8443/api/v2'].map((v) => boatBaseUrl({ BOAT_BASE_URL: v })),
      ['https://boat.dev/api/v1', 'https://boat.dev/api/v1', 'https://boat.dev/api/v1', 'https://boat.dev/api/v1', 'https://boat.dev/api/v1', 'https://boat.dev/api/v1', 'https://boat.dev:8443/api/v2']);
  });

  it('refuses any other scheme or host, naming the variable with scheme and host only', () => {
    const cases: [string, string, Record<string, string>?][] = [
      ['https://evil.example/v1', `${REFUSAL} https://evil.example`],
      ['https://api.boat.dev/v1', `${REFUSAL} https://api.boat.dev`],
      ['https://sb-1-4000.boat.dev/v1', `${REFUSAL} https://sb-1-4000.boat.dev`],
      ['https://boat.dev./api/v1', `${REFUSAL} https://boat.dev.`],
      ['https://boat.dev@evil.example/v1', `${REFUSAL} https://evil.example`],
      ['https://evil.example#@boat.dev/v1', `${REFUSAL} https://evil.example`],
      ['https://evil.example\\.boat.dev/v1', `${REFUSAL} https://evil.example`],
      ['https://boat.dev/api/v1?x=1', `${REFUSAL} https://boat.dev`],
      ['https://boat.dev/api/v1#frag', `${REFUSAL} https://boat.dev`],
      ['http://boat.dev/api/v1', `${REFUSAL} http://boat.dev`],
      ['https://boat.dev.evil.example/v1', `${REFUSAL} https://boat.dev.evil.example`],
      ['https://notboat.dev/v1', `${REFUSAL} https://notboat.dev`],
      ['https://user:secret@boat.dev/v1', `${REFUSAL} https://boat.dev`],
      ['https://boat\\@evil.example/v1', `${REFUSAL} https://boat`],
      ['ftp://boat.dev/v1', `${REFUSAL} ftp://boat.dev`],
      ['http://127.0.0.1:9/v1', `${REFUSAL} http://127.0.0.1:9`],
      ['http://127.0.0.1:9/v1', `${REFUSAL} http://127.0.0.1:9`, { WORLDGEN_BOAT_LOOPBACK: 'true' }],
      ['https://127.0.0.1:9/v1', `${REFUSAL} https://127.0.0.1:9`, { WORLDGEN_BOAT_LOOPBACK: '1' }],
      ['http://10.0.0.5:9/v1', `${REFUSAL} http://10.0.0.5:9`, { WORLDGEN_BOAT_LOOPBACK: '1' }],
      ['boat.dev/api/v1', 'BOAT_BASE_URL is not a URL; unset it to use https://boat.dev/api/v1'],
    ];
    for (const [value, message, extra] of cases) {
      assert.throws(() => boatBaseUrl({ BOAT_BASE_URL: value, ...extra }), (e: unknown) => e instanceof BoatError && e.message === message, value);
    }
  });

  it('code/bunfig.toml holds env = false', async () => {
    assert.match(await readFile(path.join(CODE_DIR, 'bunfig.toml'), 'utf8'), /^env = false$/m);
  });

  it('accepts loopback http only with WORLDGEN_BOAT_LOOPBACK=1', () => {
    assert.deepEqual(['http://127.0.0.1:9/v1', 'http://localhost:9/v1', 'http://[::1]:9/v1'].map((v) => boatBaseUrl({ BOAT_BASE_URL: v, WORLDGEN_BOAT_LOOPBACK: '1' })),
      ['http://127.0.0.1:9/v1', 'http://localhost:9/v1', 'http://[::1]:9/v1']);
  });

  it('sends no request, and no key, to a host it refuses', async () => {
    const calls: string[] = [];
    const seam: FetchFn = async (input) => { calls.push(String(input)); return new Response('{}'); };
    assert.throws(() => boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', BOAT_BASE_URL: 'https://evil.example/v1' }, { fetch: seam }),
      (e: unknown) => e instanceof BoatError && !e.message.includes(KEY));
    const boat = await fakeBoat();
    try {
      assert.throws(() => boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', BOAT_BASE_URL: boat.url }), BoatError);
      assert.deepEqual([calls, boat.hits], [[], []]);
      assert.deepEqual(await boatClientFromEnv({ BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', BOAT_BASE_URL: boat.url, WORLDGEN_BOAT_LOOPBACK: '1' }).inventory(), []);
      assert.deepEqual(boat.hits, ['GET /v1/sandboxes']);
    } finally {
      await boat.close();
    }
  });

  it('makes the sandbox CLI exit 1 before any request when BOAT_BASE_URL is off boat.dev', { timeout: 20000 }, async () => {
    const boat = await fakeBoat();
    try {
      const entry = [process.execPath, 'src/cli/sandbox.ts', 'reconcile-orphans', '--apply'];
      const r = await run(entry, CODE_DIR, { BOAT_API_KEY: KEY, WORLDGEN_BOAT_ORG: 'org_test', WORLDGEN_COSTS_FILE: path.join(tmp, 'cli-costs.jsonl'), BOAT_BASE_URL: boat.url });
      assert.deepEqual([r.code, r.stderr.trim(), boat.hits, `${r.stdout}${r.stderr}`.includes(KEY)], [1, `${REFUSAL} ${new URL(boat.url).protocol}//${new URL(boat.url).host}`, [], false]);
    } finally {
      await boat.close();
    }
  });
});

describe('the Boat key never comes from a .env file', () => {
  const canary = 'boat-canary-from-dotenv';
  const probe = (dir: string) => writeFile(path.join(dir, 'probe.ts'),
    `import { boatKey } from ${JSON.stringify(path.join(CODE_DIR, 'src/boat/client.ts'))};\n` +
    'try { boatKey(process.env); console.log("read"); } catch (e) { console.log(e instanceof Error ? e.message : String(e)); }\n');
  const dotenvDir = async (name: string, bunfig: boolean): Promise<string> => {
    const dir = await mkdtemp(path.join(tmp, `${name}-`));
    await writeFile(path.join(dir, '.env'), `BOAT_API_KEY=${canary}\nJ45_CANARY=dotenv\n`);
    if (bunfig) await writeFile(path.join(dir, 'bunfig.toml'), await readFile(path.join(CODE_DIR, 'bunfig.toml'), 'utf8'));
    await probe(dir);
    return dir;
  };
  const show = ['-e', 'console.log(process.env.J45_CANARY ?? "unset")'];

  it('code/bunfig.toml stops Bun loading .env for bun <file> and bun run, where plain Bun loads it', { skip: ONLY_BUN, timeout: 20000 }, async () => {
    const guarded = await dotenvDir('bunfig', true);
    await writeFile(path.join(guarded, 'package.json'), JSON.stringify({ name: 'probe', scripts: { show: `bun ${show.map((a) => JSON.stringify(a)).join(' ')}` } }));
    const plain = await dotenvDir('plain', false);
    const outs = await Promise.all([
      run([process.execPath, ...show], guarded, {}),
      run([process.execPath, 'run', 'show'], guarded, {}),
      run([process.execPath, ...show], plain, {}),
    ]);
    assert.deepEqual(outs.map((o) => o.stdout.trim().split('\n').at(-1)), ['unset', 'unset', 'dotenv']);
  });

  it('a Bun process outside code/ without --no-env-file refuses to read the key, and never prints it', { skip: ONLY_BUN, timeout: 20000 }, async () => {
    const dir = await dotenvDir('outside', false);
    const r = await run([process.execPath, 'probe.ts'], dir, {});
    assert.equal(r.stdout.trim(), `BOAT_API_KEY is read only by Bun started in ${CODE_DIR}, whose bunfig.toml stops .env loading, or with --no-env-file; this process started in ${dir}, where Bun may have loaded a .env file`);
    assert.equal(`${r.stdout}${r.stderr}`.includes(canary), false);
  });

  it('with --no-env-file the .env is not loaded, so the key is simply missing', { skip: ONLY_BUN, timeout: 20000 }, async () => {
    const dir = await dotenvDir('flagged', false);
    const r = await run([process.execPath, '--no-env-file', 'probe.ts'], dir, {});
    assert.equal(r.stdout.trim(), 'BOAT_API_KEY is not set: create a key at https://boat.dev/dashboard?tab=api-keys and export it');
  });

  it('a process started with --env-file refuses to read the key, under Bun in code/', { timeout: 20000 }, async () => {
    const dir = await dotenvDir('explicit', false);
    const refusal = 'BOAT_API_KEY is never read from an env file, and this process was started with --env-file; export the key in the environment instead';
    for (const flags of [[`--env-file=${path.join(dir, '.env')}`], ['--env-file', path.join(dir, '.env')]]) {
      const bun = await run([process.execPath, ...flags, path.join(dir, 'probe.ts')], CODE_DIR, {});
      assert.deepEqual([bun.stdout.trim(), `${bun.stdout}${bun.stderr}`.includes(canary)], [refusal, false]);
    }
  });

  it('a Bun process in code/ started with another bunfig through --config refuses to read the key', { skip: ONLY_BUN, timeout: 20000 }, async () => {
    const dir = await dotenvDir('config', false);
    await writeFile(path.join(dir, 'loads-env.toml'), 'env = true\n');
    // Only the = forms run the script; Bun 1.4.2 runs nothing for `--config <file> script`.
    for (const flags of [[`--config=${path.join(dir, 'loads-env.toml')}`], [`-c=${path.join(dir, 'loads-env.toml')}`]]) {
      const r = await run([process.execPath, ...flags, path.join(dir, 'probe.ts')], CODE_DIR, {});
      assert.deepEqual([r.stdout.trim(), `${r.stdout}${r.stderr}`.includes(canary)], [`BOAT_API_KEY is read only under ${CODE_DIR}/bunfig.toml, which stops .env loading, and this process was started with --config`, false], flags.join(' '));
    }
  });

  it('a Bun process in code/ reads the key from its real environment', { skip: ONLY_BUN, timeout: 20000 }, async () => {
    const dir = await mkdtemp(path.join(tmp, 'inside-'));
    await probe(dir);
    const r = await run([process.execPath, path.join(dir, 'probe.ts')], CODE_DIR, { BOAT_API_KEY: KEY });
    assert.equal(r.stdout.trim(), 'read');
  });
});
