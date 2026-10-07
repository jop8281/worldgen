import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  SandboxError,
  WAIT_FOR_PORT,
  detachedSh,
  nodeRunner,
  shQuote,
  upWorld,
  type RunOpts,
  type RunResult,
  type Runner,
  type SandboxFile,
  type WorldBundle,
} from '../src/sandboxes/backend.ts';
import { collectBundle, dirWorkspace, type Workspace } from '../src/sandboxes/files.ts';
import { openshellBackend } from '../src/sandboxes/openshell.ts';
import { sbxBackend } from '../src/sandboxes/sbx.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const HELPDESK = path.resolve(CODE_DIR, '..', 'prod', 'worlds', 'helpdesk');
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

type Reply = Partial<RunResult> | 'ENOENT';

/** Records every argv and answers from `reply`; anything it does not match exits 0 with no output. */
function fakeRunner(reply: (argv: readonly string[]) => Reply | undefined = () => undefined) {
  const calls: string[][] = [];
  const opts: (RunOpts | undefined)[] = [];
  const runner: Runner = async (argv, o) => {
    calls.push([...argv]);
    opts.push(o);
    const r = reply(argv);
    if (r === 'ENOENT') throw Object.assign(new Error(`spawn ${argv[0]} ENOENT`), { code: 'ENOENT' });
    return { code: r?.code ?? 0, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  };
  return { runner, calls, opts };
}

/** A workspace at /tmp/wg/<name> that records writes and removes instead of touching disk. */
function fakeWorkspace() {
  const events: string[] = [];
  const workspace: Workspace = {
    path: (name) => `/tmp/wg/${name}`,
    write: async (name, files) => {
      events.push(`write ${name} ${files.map((f) => f.path).join(',')}`);
      return `/tmp/wg/${name}`;
    },
    remove: async (name) => {
      events.push(`remove ${name}`);
    },
  };
  return { workspace, events };
}

const ends = (argv: readonly string[], ...tail: string[]): boolean => argv.slice(-tail.length).join(' ') === tail.join(' ');

/** A sandbox that has Node 22 and where every other command succeeds. */
const healthy = (argv: readonly string[]): Reply | undefined => (ends(argv, 'node', '-v') ? { stdout: 'v22.11.0\n' } : ends(argv, 'sh', '-c', BOOT) ? { stdout: '1.4.2\n' } : undefined);

const BUNDLE: WorldBundle = {
  files: [
    { path: 'package.json', data: enc('{}') },
    { path: 'worlds/helpdesk/world.yaml', data: enc('meta: {}\n') },
  ],
  world: 'worlds/helpdesk',
};

const BUN = '/tmp/worldgen-bun/node_modules/.bin/bun';
const BOOT =
  'D=/tmp/worldgen-bun; A=$(uname -m); case $A in x86_64) A=x64;; esac; mkdir -p $D/node_modules/.bin && ' +
  'curl -fsSL -o $D/bun.tgz https://registry.npmjs.org/@oven/bun-linux-$A/-/bun-linux-$A-1.4.2.tgz && ' +
  `tar -xzf $D/bun.tgz -C $D package/bin/bun && mv $D/package/bin/bun ${BUN} && rm -rf $D/bun.tgz $D/package && ${BUN} --version`;
const SERVE_SH = `nohup ${BUN} src/cli/worldplay.ts serve worlds/helpdesk --port 4000 > /tmp/worldplay.log 2>&1 < /dev/null &`;
const WAIT_LITERAL =
  "const net=require('node:net');const port=Number(process.argv[1]);const end=Date.now()+Number(process.argv[2])*1000;" +
  "const t=()=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});" +
  "s.on('error',()=>{s.destroy();if(Date.now()>=end)process.exit(1);setTimeout(t,250)})};t();";

const OS_EXEC = ['openshell', 'sandbox', 'exec', '-n', 'w1', '--no-login-shell', '--no-tty', '--workdir', '/sandbox/work/w1'];
const OPENSHELL_UP: string[][] = [
  ['openshell', 'sandbox', 'create', '--name', 'w1', '--cpu', '2', '--memory', '4Gi', '--upload', '/tmp/wg/w1:/sandbox/work', '--no-git-ignore', '--detach', '--no-auto-providers'],
  [...OS_EXEC, '--', 'node', '-v'],
  [...OS_EXEC.slice(0, 7), '--timeout', '900', '--', 'sh', '-c', BOOT],
  [...OS_EXEC, '--timeout', '900', '--', BUN, 'install', '--frozen-lockfile'],
  [...OS_EXEC, '--', 'sh', '-c', SERVE_SH],
  [...OS_EXEC, '--', 'node', '-e', WAIT_LITERAL, '4000', '60'],
  ['openshell', 'forward', 'start', '4000', 'w1', '-d'],
];

const SBX_EXEC = ['sbx', 'exec', '--workdir', '/tmp/wg/w1', 'w1'];
const SBX_UP: string[][] = [
  ['sbx', 'create', '--name=w1', '--cpus', '2', 'shell', '/tmp/wg/w1'],
  [...SBX_EXEC, 'node', '-v'],
  ['sbx', 'exec', 'w1', 'sh', '-c', BOOT],
  [...SBX_EXEC, BUN, 'install', '--frozen-lockfile'],
  [...SBX_EXEC, 'sh', '-c', SERVE_SH],
  [...SBX_EXEC, 'node', '-e', WAIT_LITERAL, '4000', '60'],
  ['sbx', 'ports', 'w1', '--publish', '4000:4000'],
];

describe('nodeRunner', () => {
  it('returns the exit code, stdout and stderr of a real process', async () => {
    const res = await nodeRunner([process.execPath, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)']);
    assert.deepEqual(res, { code: 3, stdout: 'out', stderr: 'err' });
  });

  it('passes argv through without a shell', async () => {
    const res = await nodeRunner([process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '$HOME', 'a b', '*']);
    assert.deepEqual(res, { code: 0, stdout: '$HOME|a b|*', stderr: '' });
  });

  it('runs in opts.cwd', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sbx-cwd-'));
    const res = await nodeRunner([process.execPath, '-e', 'process.stdout.write(require("node:path").basename(process.cwd()))'], { cwd: dir });
    assert.equal(res.stdout, path.basename(dir));
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects with ENOENT when the binary is missing', async () => {
    await assert.rejects(nodeRunner(['worldgen-no-such-binary-x9']), { code: 'ENOENT' });
  });

  it('returns when a detached grandchild keeps the pipes open', async () => {
    const script =
      'const c=require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>{},20000)"],{detached:true,stdio:"inherit"});' +
      'c.unref();process.stdout.write(String(c.pid))';
    const res = await nodeRunner([process.execPath, '-e', script]);
    assert.equal(res.code, 0);
    process.kill(Number(res.stdout));
  });
});

describe('shell quoting for detached starts', () => {
  it('detachedSh wraps the command in nohup with output in the log and stdin closed', () => {
    assert.deepEqual(detachedSh([BUN, 'src/cli/worldplay.ts', 'serve', 'worlds/helpdesk', '--port', '4000'], '/tmp/worldplay.log'), [
      'sh',
      '-c',
      SERVE_SH,
    ]);
  });

  it('shQuote leaves safe words alone and single-quotes the rest', () => {
    assert.equal(shQuote('worlds/gen-refunds_2.v1'), 'worlds/gen-refunds_2.v1');
    assert.equal(shQuote("it's here"), `'it'\\''s here'`);
    assert.equal(shQuote(''), "''");
  });

  it('shQuote round-trips a hostile word through a real sh', async () => {
    const word = `a b'c$HOME"d\`e;f*`;
    const res = await nodeRunner(['sh', '-c', `printf '%s' ${shQuote(word)}`]);
    assert.equal(res.stdout, `a b'c$HOME"d\`e;f*`);
  });
});

describe('WAIT_FOR_PORT probe', () => {
  let server: Server;
  let port = 0;
  before(async () => {
    server = createServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    assert.ok(addr !== null && typeof addr === 'object');
    port = addr.port;
  });
  after(() => server.close());

  it('is the literal one-liner the backends send', () => {
    assert.equal(WAIT_FOR_PORT, WAIT_LITERAL);
  });

  it('exits 0 once the port accepts a connection', async () => {
    const res = await nodeRunner([process.execPath, '-e', WAIT_FOR_PORT, String(port), '5']);
    assert.equal(res.code, 0);
  });

  it('exits 1 when nothing listens before the deadline', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const addr = closed.address();
    assert.ok(addr !== null && typeof addr === 'object');
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const res = await nodeRunner([process.execPath, '-e', WAIT_FOR_PORT, String(addr.port), '0']);
    assert.equal(res.code, 1);
  });
});

describe('openshell backend', () => {
  it('sends the literal argv for up, exec, start, expose and down', async () => {
    const { runner, calls } = fakeRunner();
    const { workspace, events } = fakeWorkspace();
    const b = openshellBackend({ runner, workspace });
    assert.deepEqual(await b.up(BUNDLE.files, { name: 'w1' }), { id: 'w1', workdir: '/sandbox/work/w1' });
    assert.deepEqual(await b.exec('w1', ['ls', '-la'], { workdir: '/sandbox/work', timeoutSec: 30 }), { exitCode: 0, stdout: '', stderr: '' });
    await b.start('w1', ['sleep', '100'], { workdir: '/sandbox/work', log: '/tmp/s.log' });
    assert.equal(await b.expose('w1', 4000, { public: false }), 'http://127.0.0.1:4000');
    await b.down('w1');
    assert.deepEqual(calls, [
      ['openshell', 'sandbox', 'create', '--name', 'w1', '--cpu', '2', '--memory', '4Gi', '--upload', '/tmp/wg/w1:/sandbox/work', '--no-git-ignore', '--detach', '--no-auto-providers'],
      ['openshell', 'sandbox', 'exec', '-n', 'w1', '--no-login-shell', '--no-tty', '--workdir', '/sandbox/work', '--timeout', '30', '--', 'ls', '-la'],
      ['openshell', 'sandbox', 'exec', '-n', 'w1', '--no-login-shell', '--no-tty', '--workdir', '/sandbox/work', '--', 'sh', '-c', 'nohup sleep 100 > /tmp/s.log 2>&1 < /dev/null &'],
      ['openshell', 'forward', 'start', '4000', 'w1', '-d'],
      ['openshell', 'sandbox', 'delete', 'w1'],
    ]);
    assert.deepEqual(events, ['write w1 package.json,worlds/helpdesk/world.yaml', 'remove w1']);
  });

  it('passes the image and size through to create', async () => {
    const { runner, calls } = fakeRunner();
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    await b.up([], { name: 'big', image: 'node:22-bookworm', size: { cpus: 4, memoryGi: 8 } });
    assert.deepEqual(calls, [
      ['openshell', 'sandbox', 'create', '--name', 'big', '--from', 'node:22-bookworm', '--cpu', '4', '--memory', '8Gi', '--upload', '/tmp/wg/big:/sandbox/work', '--no-git-ignore', '--detach', '--no-auto-providers'],
    ]);
  });

  it('returns a non-zero exec as a result', async () => {
    const { runner } = fakeRunner(() => ({ code: 2, stdout: 'o', stderr: 'e' }));
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    assert.deepEqual(await b.exec('w1', ['false']), { exitCode: 2, stdout: 'o', stderr: 'e' });
  });

  it('names the binary and its install command when openshell is missing', async () => {
    const { runner } = fakeRunner(() => 'ENOENT');
    const { workspace, events } = fakeWorkspace();
    const b = openshellBackend({ runner, workspace });
    await assert.rejects(b.up([], { name: 'w1' }), {
      name: 'SandboxError',
      message: 'openshell not found on PATH. Install it: curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh',
    });
    assert.deepEqual(events, ['write w1 ', 'remove w1']);
  });

  it('fails create with the last stderr line and still removes the host copy', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stderr: 'connecting\nerror: gateway not running\n' }));
    const { workspace, events } = fakeWorkspace();
    await assert.rejects(openshellBackend({ runner, workspace }).up([], { name: 'w1' }), {
      message: 'openshell sandbox create failed (exit 1): error: gateway not running',
    });
    assert.deepEqual(events, ['write w1 ', 'remove w1']);
  });

  it('deletes the half-made sandbox when create fails after the sandbox exists', async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 1, stderr: 'Error:   × ssh tar extract exited with status exit status: 1\n' }));
    await assert.rejects(openshellBackend({ runner, workspace: fakeWorkspace().workspace }).up([], { name: 'w1' }), {
      message: 'openshell sandbox create failed (exit 1): Error:   × ssh tar extract exited with status exit status: 1',
    });
    assert.deepEqual(calls.at(-1), ['openshell', 'sandbox', 'delete', 'w1']);
  });

  it('refuses a public expose and a bad name without running anything', async () => {
    const { runner, calls } = fakeRunner();
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    await assert.rejects(b.expose('w1', 4000, { public: true }), {
      message: 'openshell forwards ports to 127.0.0.1 only; use the boat backend for a public URL',
    });
    await assert.rejects(b.up([], { name: 'W 1' }), SandboxError);
    assert.deepEqual(calls, []);
  });
});

describe('sbx backend', () => {
  it('sends the literal argv for up, exec, start, expose and down', async () => {
    const { runner, calls, opts } = fakeRunner();
    const { workspace, events } = fakeWorkspace();
    const b = sbxBackend({ runner, workspace });
    assert.deepEqual(await b.up(BUNDLE.files, { name: 'w1' }), { id: 'w1', workdir: '/tmp/wg/w1' });
    await b.exec('w1', ['ls', '-la'], { workdir: '/tmp/wg/w1', timeoutSec: 30 });
    await b.start('w1', ['sleep', '100'], { workdir: '/tmp/wg/w1', log: '/tmp/s.log' });
    assert.equal(await b.expose('w1', 4000, { public: false }), 'http://127.0.0.1:4000');
    await b.down('w1');
    assert.deepEqual(calls, [
      ['sbx', 'create', '--name=w1', '--cpus', '2', 'shell', '/tmp/wg/w1'],
      ['sbx', 'exec', '--workdir', '/tmp/wg/w1', 'w1', 'ls', '-la'],
      ['sbx', 'exec', '--workdir', '/tmp/wg/w1', 'w1', 'sh', '-c', 'nohup sleep 100 > /tmp/s.log 2>&1 < /dev/null &'],
      ['sbx', 'ports', 'w1', '--publish', '4000:4000'],
      ['sbx', 'stop', 'w1'],
      ['sbx', 'rm', '--force', 'w1'],
    ]);
    assert.deepEqual(opts[1], { timeoutMs: 30000 });
    assert.deepEqual(events, ['write w1 package.json,worlds/helpdesk/world.yaml', 'remove w1']);
  });

  it('removes even when stop fails, and keeps the mount when rm fails', async () => {
    const stopFails = fakeRunner((argv) => (argv[1] === 'stop' ? { code: 1, stderr: 'not running' } : undefined));
    const ws1 = fakeWorkspace();
    await sbxBackend({ runner: stopFails.runner, workspace: ws1.workspace }).down('w1');
    assert.deepEqual(stopFails.calls, [['sbx', 'stop', 'w1'], ['sbx', 'rm', '--force', 'w1']]);
    assert.deepEqual(ws1.events, ['remove w1']);

    const rmFails = fakeRunner((argv) => (argv[1] === 'rm' ? { code: 1, stderr: 'busy' } : undefined));
    const ws2 = fakeWorkspace();
    await assert.rejects(sbxBackend({ runner: rmFails.runner, workspace: ws2.workspace }).down('w1'), { message: 'sbx rm failed (exit 1): busy' });
    assert.deepEqual(ws2.events, []);
  });

  it('names the binary and its install command when sbx is missing, and drops the mount', async () => {
    const { runner } = fakeRunner(() => 'ENOENT');
    const { workspace, events } = fakeWorkspace();
    await assert.rejects(sbxBackend({ runner, workspace }).up([], { name: 'w1' }), {
      name: 'SandboxError',
      message: "sbx not found on PATH. Install it: brew install docker/tap/sbx (macOS), or Docker's apt repository (Linux)",
    });
    assert.deepEqual(events, ['write w1 ', 'remove w1']);
  });

  it('refuses a public expose without running anything', async () => {
    const { runner, calls } = fakeRunner();
    const b = sbxBackend({ runner, workspace: fakeWorkspace().workspace });
    await assert.rejects(b.expose('w1', 4000, { public: true }), {
      message: 'sbx publishes ports on 127.0.0.1 only; use the boat backend for a public URL',
    });
    assert.deepEqual(calls, []);
  });

  it('passes an image to sbx create as its template', async () => {
    const { runner, calls } = fakeRunner();
    await sbxBackend({ runner, workspace: fakeWorkspace().workspace }).up([], { name: 'w1', image: 'node:22-bookworm' });
    assert.deepEqual(calls[0], ['sbx', 'create', '--name=w1', '--cpus', '2', '--template', 'node:22-bookworm', 'shell', '/tmp/wg/w1']);
  });
});

describe('upWorld', () => {
  it('on openshell: uploads, checks node, installs, serves, waits, and forwards the world port', async () => {
    const { runner, calls } = fakeRunner(healthy);
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    const up = await upWorld(b, BUNDLE, { name: 'w1', port: 4000 });
    assert.deepEqual(up, { sandbox: { id: 'w1', workdir: '/sandbox/work/w1' }, url: 'http://127.0.0.1:4000' });
    assert.deepEqual(calls, OPENSHELL_UP);
  });

  it('on sbx: the same steps through sbx exec and ports', async () => {
    const { runner, calls } = fakeRunner(healthy);
    const b = sbxBackend({ runner, workspace: fakeWorkspace().workspace });
    const up = await upWorld(b, BUNDLE, { name: 'w1', port: 4000 });
    assert.deepEqual(up, { sandbox: { id: 'w1', workdir: '/tmp/wg/w1' }, url: 'http://127.0.0.1:4000' });
    assert.deepEqual(calls, SBX_UP);
  });

  it('never exposes the admin port on either backend', async () => {
    for (const make of [openshellBackend, sbxBackend]) {
      const { runner, calls } = fakeRunner(healthy);
      await upWorld(make({ runner, workspace: fakeWorkspace().workspace }), BUNDLE, { name: 'w1', port: 4000 });
      const exposing = calls.filter((c) => c.includes('forward') || c.includes('ports'));
      assert.equal(exposing.length, 1);
      assert.equal(calls.some((c) => c.some((a) => a.includes('4001'))), false);
    }
  });

  it('tears the openshell sandbox down when bun install fails', async () => {
    const { runner, calls } = fakeRunner((argv) =>
      ends(argv, BUN, 'install', '--frozen-lockfile') ? { code: 1, stderr: 'npm error code E404\nnpm error 404 Not Found - zod\n' } : healthy(argv),
    );
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    await assert.rejects(upWorld(b, BUNDLE, { name: 'w1', port: 4000 }), {
      name: 'SandboxError',
      message: 'bun install failed in openshell sandbox w1 (exit 1):\nnpm error code E404\nnpm error 404 Not Found - zod',
    });
    assert.deepEqual(calls, [...OPENSHELL_UP.slice(0, 4), ['openshell', 'sandbox', 'delete', 'w1']]);
  });

  it('tears the sbx sandbox down when bun install fails', async () => {
    const { runner, calls } = fakeRunner((argv) => (ends(argv, BUN, 'install', '--frozen-lockfile') ? { code: 1, stderr: 'ENOSPC\n' } : healthy(argv)));
    const { workspace, events } = fakeWorkspace();
    await assert.rejects(upWorld(sbxBackend({ runner, workspace }), BUNDLE, { name: 'w1', port: 4000 }), {
      message: 'bun install failed in sbx sandbox w1 (exit 1):\nENOSPC',
    });
    assert.deepEqual(calls, [...SBX_UP.slice(0, 4), ['sbx', 'stop', 'w1'], ['sbx', 'rm', '--force', 'w1']]);
    assert.deepEqual(events, ['write w1 package.json,worlds/helpdesk/world.yaml', 'remove w1']);
  });

  it('stops at an old or missing node and tears down', async () => {
    const old = fakeRunner((argv) => (ends(argv, 'node', '-v') ? { stdout: 'v20.11.1\n' } : undefined));
    await assert.rejects(upWorld(openshellBackend({ runner: old.runner, workspace: fakeWorkspace().workspace }), BUNDLE, { name: 'w1', port: 4000 }), {
      message: 'the openshell sandbox has node v20.11.1: need Node 22 or later',
    });
    assert.deepEqual(old.calls, [...OPENSHELL_UP.slice(0, 2), ['openshell', 'sandbox', 'delete', 'w1']]);

    const none = fakeRunner((argv) => (ends(argv, 'node', '-v') ? { code: 127, stderr: 'sh: node: not found' } : undefined));
    await assert.rejects(upWorld(sbxBackend({ runner: none.runner, workspace: fakeWorkspace().workspace }), BUNDLE, { name: 'w1', port: 4000 }), {
      message: 'node not found in the sbx sandbox: use an image with Node 22 or later',
    });
  });

  it('reports the serve log and tears down when the world port never opens', async () => {
    const { runner, calls } = fakeRunner((argv) => {
      if (argv.includes(WAIT_LITERAL)) return { code: 1 };
      if (ends(argv, 'tail', '-n', '20', '/tmp/worldplay.log')) return { stdout: 'Error: world.yaml: 3 issues\n' };
      return healthy(argv);
    });
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    await assert.rejects(upWorld(b, BUNDLE, { name: 'w1', port: 4000 }), {
      message: 'worldplay serve did not listen on port 4000 within 60s in openshell sandbox w1:\nError: world.yaml: 3 issues',
    });
    assert.deepEqual(calls, [
      ...OPENSHELL_UP.slice(0, 6),
      [...OS_EXEC.slice(0, 7), '--', 'tail', '-n', '20', '/tmp/worldplay.log'],
      ['openshell', 'sandbox', 'delete', 'w1'],
    ]);
  });

  it('keeps both errors when the teardown fails too', async () => {
    const { runner } = fakeRunner((argv) => {
      if (ends(argv, BUN, 'install', '--frozen-lockfile')) return { code: 1, stderr: 'boom' };
      if (ends(argv, 'sandbox', 'delete', 'w1')) return { code: 1, stderr: 'not found' };
      return healthy(argv);
    });
    await assert.rejects(upWorld(openshellBackend({ runner, workspace: fakeWorkspace().workspace }), BUNDLE, { name: 'w1', port: 4000 }), {
      message: 'bun install failed in openshell sandbox w1 (exit 1):\nboom\nteardown of openshell sandbox w1 also failed: openshell sandbox delete failed (exit 1): not found',
    });
  });

  it('rejects a port without room for the admin port before creating anything', async () => {
    const { runner, calls } = fakeRunner(healthy);
    const b = openshellBackend({ runner, workspace: fakeWorkspace().workspace });
    await assert.rejects(upWorld(b, BUNDLE, { name: 'w1', port: 65535 }), {
      message: 'bad port 65535: use an integer from 1 to 65534 (the admin routes take port + 1)',
    });
    await assert.rejects(upWorld(b, BUNDLE, { name: 'w1', port: 4000.5 }), SandboxError);
    assert.deepEqual(calls, []);
  });
});

describe('collectBundle', () => {
  let root = '';
  let code = '';
  let world = '';
  const put = async (file: string, text: string): Promise<void> => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'sbx-bundle-'));
    code = path.join(root, 'code');
    world = path.join(root, 'prod', 'worlds', 'helpdesk');
    for (const f of ['package.json', 'bun.lock', 'tsconfig.json', 'tsconfig.engine-core.json', 'worldgen.config.json', 'models.json', 'README.md', '.env']) {
      await put(path.join(code, f), f);
    }
    await put(path.join(code, 'src', 'cli', 'worldplay.ts'), 'cli');
    await put(path.join(code, 'src', 'engine', 'index.ts'), 'engine');
    await put(path.join(code, 'src', 'engine', 'node_modules', 'x.js'), 'skip');
    await put(path.join(code, 'node_modules', 'zod', 'index.js'), 'skip');
    await put(path.join(code, 'test', 'a.test.ts'), 'skip');
    await put(path.join(code, 'runs', 'r.json'), 'skip');
    await put(path.join(code, '.git', 'HEAD'), 'skip');
    await put(path.join(world, 'world.yaml'), 'meta: {}\n');
    await put(path.join(world, 'NOTES.md'), 'notes');
    await put(path.join(world, '.env'), 'BOAT_API_KEY=must-not-upload\n');
    await put(path.join(world, '.private', 'credentials.json'), '{"token":"must-not-upload"}');
    await put(path.join(world, 'runs', 'r1', 'events.jsonl'), 'skip');
  });
  after(async () => rm(root, { recursive: true, force: true }));

  it('collects the package files and world under worlds/<name>, sorted without hidden files', async () => {
    const bundle = await collectBundle(code, world);
    assert.equal(bundle.world, 'worlds/helpdesk');
    assert.deepEqual(
      bundle.files.map((f) => f.path),
      [
        'bun.lock',
        'models.json',
        'package.json',
        'src/cli/worldplay.ts',
        'src/engine/index.ts',
        'tsconfig.engine-core.json',
        'tsconfig.json',
        'worldgen.config.json',
        'worlds/helpdesk/NOTES.md',
        'worlds/helpdesk/world.yaml',
      ],
    );
    const yaml = bundle.files.find((f) => f.path === 'worlds/helpdesk/world.yaml');
    assert.equal(yaml === undefined ? undefined : dec(yaml.data), 'meta: {}\n');
    assert.equal(bundle.files.some((f) => dec(f.data).includes('must-not-upload')), false);
  });

  it('publicOnly uploads the public form alone: no private world.yaml, no other world file, no secret', async () => {
    await put(path.join(world, 'public', 'world.yaml'), 'meta: {public: true}\n');
    const bundle = await collectBundle(code, world, { publicOnly: true });
    assert.equal(bundle.world, 'worlds/helpdesk');
    assert.deepEqual(
      bundle.files.map((f) => f.path),
      [
        'bun.lock',
        'models.json',
        'package.json',
        'src/cli/worldplay.ts',
        'src/engine/index.ts',
        'tsconfig.engine-core.json',
        'tsconfig.json',
        'worldgen.config.json',
        'worlds/helpdesk/world.yaml',
      ],
    );
    const yaml = bundle.files.find((f) => f.path === 'worlds/helpdesk/world.yaml');
    assert.equal(yaml === undefined ? undefined : dec(yaml.data), 'meta: {public: true}\n');
    assert.equal(bundle.files.some((f) => dec(f.data).includes('must-not-upload')), false);
  });

  it('publicOnly refuses a world without the public form of it', async () => {
    await assert.rejects(collectBundle(code, path.join(root, 'prod'), { publicOnly: true }), {
      message: `${path.join(root, 'prod', 'public', 'world.yaml')} not found: a public-only bundle needs the public form of the world (YOS-159)`,
    });
  });

  it('refuses a package without a lockfile and a world without world.yaml', async () => {
    await rm(path.join(code, 'bun.lock'));
    await assert.rejects(collectBundle(code, world), { message: `${path.join(code, 'bun.lock')} not found: the sandbox runs bun install from it` });
    await put(path.join(code, 'bun.lock'), 'lock');
    await assert.rejects(collectBundle(code, path.join(root, 'prod')), { message: `${path.join(root, 'prod', 'world.yaml')} not found` });
  });

  it('collects the real code package and the helpdesk world', async () => {
    const paths = (await collectBundle(CODE_DIR, HELPDESK)).files.map((f) => f.path);
    assert.equal(paths.includes('bun.lock'), true);
    assert.equal(paths.includes('src/cli/worldplay.ts'), true);
    assert.equal(paths.includes('src/sandboxes/backend.ts'), true);
    assert.equal(paths.includes('worlds/helpdesk/world.yaml'), true);
    assert.equal(paths.some((p) => p.includes('node_modules') || p.startsWith('test/')), false);
  });
});

describe('dirWorkspace', () => {
  it('writes the files under <root>/<name>, replaces old content, and removes the directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sbx-ws-'));
    const ws = dirWorkspace(root);
    await mkdir(path.join(root, 'w1'), { recursive: true });
    await writeFile(path.join(root, 'w1', 'stale.txt'), 'old');
    const files: SandboxFile[] = [
      { path: 'package.json', data: enc('{"name":"worldgen"}') },
      { path: 'worlds/helpdesk/world.yaml', data: enc('meta: {}\n') },
    ];
    const dir = await ws.write('w1', files);
    assert.equal(dir, path.join(root, 'w1'));
    assert.equal(ws.path('w1'), path.join(root, 'w1'));
    assert.equal(await readFile(path.join(dir, 'worlds', 'helpdesk', 'world.yaml'), 'utf8'), 'meta: {}\n');
    await assert.rejects(stat(path.join(dir, 'stale.txt')), { code: 'ENOENT' });
    await ws.remove('w1');
    await assert.rejects(stat(dir), { code: 'ENOENT' });
    await ws.remove('w1');
    await rm(root, { recursive: true, force: true });
  });

  it('refuses paths that escape the workspace and names that are not slugs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sbx-ws-'));
    const ws = dirWorkspace(root);
    await assert.rejects(ws.write('w1', [{ path: '../evil', data: enc('x') }]), {
      message: 'bad sandbox file path "../evil": use a relative POSIX path without . or .. segments',
    });
    await assert.rejects(ws.write('w1', [{ path: '/etc/passwd', data: enc('x') }]), SandboxError);
    assert.throws(() => ws.path('../up'), SandboxError);
    await assert.rejects(stat(path.join(root, 'w1')), { code: 'ENOENT' });
    await rm(root, { recursive: true, force: true });
  });
});
