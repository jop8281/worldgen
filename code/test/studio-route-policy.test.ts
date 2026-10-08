/**
 * The studio's route policy (YOS-208, YOS-187): every route the router answers is named here with the role it needs,
 * whose data it serves, and the gate on any row value or issue text it can carry. Each row runs against a real studio
 * on a copy of the helpdesk, whose customer emails are sensitive (A-356), as each role of two tenants, and no email,
 * read from the world's own seed, reaches a role below admin. A route the table does not name fails the drift guard,
 * as a module the architecture tests do not know does.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkWorld, loadWorld, serve, type WorldServer } from '#engine';
import { runLocalEpisode } from '../src/dataset/local.ts';
import { redactor } from '../src/dataset/schema.ts';
import { nodeRunner, type Runner, type SpawnedChild, type Spawner } from '../src/sandboxes/backend.ts';
import { studioServer, type StudioServer, type StudioUser } from '../src/studio/server.ts';
import { scripted } from './dataset-kit.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOKENS = { viewer: 'ann-acme-viewer', foreign: 'gina-globex-operator', operator: 'otto-acme-operator', admin: 'ada-ops-admin' } as const;
const USERS: readonly StudioUser[] = [
  { name: 'ann', role: 'viewer', tenant: 'acme', tokenSha256: digest(TOKENS.viewer) },
  { name: 'gina', role: 'operator', tenant: 'globex', tokenSha256: digest(TOKENS.foreign) },
  { name: 'otto', role: 'operator', tenant: 'acme', tokenSha256: digest(TOKENS.operator) },
  { name: 'ada', role: 'admin', tenant: 'ops', tokenSha256: digest(TOKENS.admin) },
];

/** Who asks: no token, acme's viewer, globex's operator (the other tenant), acme's operator, and an admin of tenant ops. */
const ACTORS = ['anon', 'viewer', 'foreign', 'operator', 'admin'] as const;
type Actor = (typeof ACTORS)[number];
type Need = 'public' | 'viewer' | 'operator' | 'admin';

/** The ids the fixture made as acme's operator: a served helpdesk, a generation run, an exported episode and an upload. */
type Fixture = { readonly svc: string; readonly runId: string; readonly episodeId: string; readonly uploadId: string };

/**
 * One route. `tenant`: `none` serves no tenant's data; `listing` lists each caller's own and the library's; `own` acts on
 * the caller's own tenant, so another tenant's id is unknown even to an admin; `acme's` is a resource of tenant acme,
 * which globex asks for and which the admin reaches with `?tenant=acme`. `foreign` is what globex gets for it.
 * `carries`: what row values or issue text can reach the caller, and the gate on them.
 */
type Row = {
  readonly route: string;
  readonly need: Need;
  readonly tenant: 'none' | 'listing' | 'own' | "acme's";
  readonly foreign?: 404;
  readonly carries: 'nothing' | 'masked' | 'withheld' | '403 *.sensitive' | 'admin only';
  readonly path: (fx: Fixture) => string;
  readonly body?: unknown;
  /** The status for anon, viewer, foreign, operator and admin, in that order. */
  readonly status: readonly [number, number, number, number, number];
  /** The admin's answer holds an email, so the probe below can see one when the gate is off. */
  readonly adminSees?: boolean;
  /** Text of acme's that globex's answer must not hold. */
  readonly foreignHides?: (fx: Fixture) => string;
};

const TABLE: readonly Row[] = [
  { route: 'GET /', need: 'public', tenant: 'none', carries: 'nothing', path: () => '/', status: [200, 200, 200, 200, 200] },
  { route: 'GET /api/health', need: 'public', tenant: 'none', carries: 'nothing', path: () => '/api/health', status: [200, 200, 200, 200, 200] },
  { route: 'GET /api/me', need: 'viewer', tenant: 'none', carries: 'nothing', path: () => '/api/me', status: [401, 200, 200, 200, 200] },
  { route: 'GET /api/worlds', need: 'viewer', tenant: 'listing', carries: 'nothing', path: () => '/api/worlds', status: [401, 200, 200, 200, 200], foreignHides: () => 'helpdesk' },
  { route: 'GET /api/worlds/:name/report', need: 'viewer', tenant: "acme's", foreign: 404, carries: '403 *.sensitive', path: () => '/api/worlds/helpdesk/report', status: [401, 403, 404, 403, 200], adminSees: true },
  { route: 'GET /api/worlds/:name/plan', need: 'viewer', tenant: "acme's", foreign: 404, carries: '403 *.sensitive', path: () => '/api/worlds/helpdesk/plan', status: [401, 403, 404, 403, 404] },
  { route: 'GET /api/worlds/:name/export', need: 'admin', tenant: "acme's", carries: 'admin only', path: () => '/api/worlds/helpdesk/export', status: [401, 403, 403, 403, 200] },
  { route: 'GET /api/worlds/:name/explorer', need: 'viewer', tenant: "acme's", foreign: 404, carries: 'nothing', path: () => '/api/worlds/helpdesk/explorer', status: [401, 200, 404, 200, 200] },
  { route: 'GET /api/worlds/:name/tasks', need: 'viewer', tenant: "acme's", foreign: 404, carries: 'nothing', path: () => '/api/worlds/helpdesk/tasks', status: [401, 200, 404, 200, 200] },
  { route: 'POST /api/worlds/:name/serve', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: () => '/api/worlds/helpdesk/serve', body: {}, status: [401, 403, 404, 409, 409] },
  { route: 'POST /api/worlds/:name/iterate', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: () => '/api/worlds/helpdesk/iterate', body: { change: 'add a note field' }, status: [401, 403, 404, 200, 200] },
  { route: 'POST /api/worlds/:name/proof', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: () => '/api/worlds/helpdesk/proof', status: [401, 403, 404, 200, 200] },
  { route: 'GET /api/services', need: 'viewer', tenant: 'listing', carries: 'nothing', path: () => '/api/services', status: [401, 200, 200, 200, 200], foreignHides: (fx) => fx.svc },
  { route: 'POST /api/services/:id/call', need: 'operator', tenant: "acme's", foreign: 404, carries: 'masked', path: (fx) => `/api/services/${fx.svc}/call`, body: { method: 'GET', path: '/customers' }, status: [401, 403, 404, 200, 200], adminSees: true },
  { route: 'POST /api/services/:id/reset', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: (fx) => `/api/services/${fx.svc}/reset`, body: { confirm: 'helpdesk' }, status: [401, 403, 404, 200, 200] },
  { route: 'GET /api/inputs', need: 'viewer', tenant: 'none', carries: 'nothing', path: () => '/api/inputs', status: [401, 200, 200, 200, 200] },
  { route: 'GET /api/inputs/:spec/paths', need: 'viewer', tenant: 'none', carries: 'nothing', path: () => '/api/inputs/petstore.openapi.yaml/paths', status: [401, 200, 200, 200, 200] },
  { route: 'GET /api/uploads', need: 'viewer', tenant: 'own', carries: 'nothing', path: () => '/api/uploads', status: [401, 200, 200, 200, 200], foreignHides: (fx) => fx.uploadId },
  { route: 'POST /api/uploads', need: 'operator', tenant: 'own', carries: 'nothing', path: () => '/api/uploads', body: { kind: 'csv', name: 'notes.csv', content: 'id,note\n1,hello\n' }, status: [401, 403, 201, 201, 201] },
  { route: 'GET /api/uploads/:id/paths', need: 'viewer', tenant: 'own', carries: 'nothing', path: (fx) => `/api/uploads/${fx.uploadId}/paths`, status: [401, 200, 404, 200, 404] },
  { route: 'POST /api/generate', need: 'operator', tenant: 'own', carries: 'nothing', path: () => '/api/generate', body: { kind: 'description', text: 'A tiny helpdesk', outSlug: 'policy-probe' }, status: [401, 403, 200, 200, 200] },
  { route: 'GET /api/generate/:runId', need: 'viewer', tenant: "acme's", foreign: 404, carries: 'withheld', path: (fx) => `/api/generate/${fx.runId}`, status: [401, 200, 404, 200, 200], adminSees: true },
  { route: 'GET /api/generate/:runId/events', need: 'viewer', tenant: "acme's", foreign: 404, carries: 'withheld', path: (fx) => `/api/generate/${fx.runId}/events`, status: [401, 200, 404, 200, 200], adminSees: true },
  { route: 'GET /api/runs', need: 'viewer', tenant: 'listing', carries: 'nothing', path: () => '/api/runs', status: [401, 200, 200, 200, 200] },
  { route: 'GET /api/eval', need: 'admin', tenant: 'none', carries: 'admin only', path: () => '/api/eval', status: [401, 403, 403, 403, 200], adminSees: true },
  { route: 'GET /api/eval/:dir', need: 'admin', tenant: 'none', carries: 'admin only', path: () => '/api/eval/run-leaky', status: [401, 403, 403, 403, 200], adminSees: true },
  { route: 'GET /api/costs', need: 'admin', tenant: 'none', carries: 'nothing', path: () => '/api/costs', status: [401, 403, 403, 403, 200] },
  { route: 'GET /api/audit', need: 'admin', tenant: 'none', carries: 'nothing', path: () => '/api/audit', status: [401, 403, 403, 403, 200] },
  { route: 'GET /api/episodes', need: 'viewer', tenant: 'listing', carries: 'nothing', path: () => '/api/episodes', status: [401, 200, 200, 200, 200], foreignHides: (fx) => fx.episodeId },
  { route: 'POST /api/episodes', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: () => '/api/episodes', body: { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop' }, status: [401, 403, 404, 200, 200] },
  { route: 'GET /api/episodes/analytics', need: 'viewer', tenant: 'listing', carries: 'nothing', path: () => '/api/episodes/analytics', status: [401, 200, 200, 200, 200] },
  { route: 'GET /api/episodes/:runId', need: 'viewer', tenant: "acme's", foreign: 404, carries: 'masked', path: (fx) => `/api/episodes/${fx.episodeId}`, status: [401, 200, 404, 200, 200], adminSees: true },
  { route: 'POST /api/episodes/:runId/stop', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: (fx) => `/api/episodes/${fx.episodeId}/stop`, status: [401, 403, 404, 409, 409] },
  // Last: they end what the rows above use.
  { route: 'POST /api/generate/:runId/stop', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: (fx) => `/api/generate/${fx.runId}/stop`, status: [401, 403, 404, 200, 409] },
  { route: 'POST /api/services/:id/stop', need: 'operator', tenant: "acme's", foreign: 404, carries: 'nothing', path: (fx) => `/api/services/${fx.svc}/stop`, status: [401, 403, 404, 200, 404] },
];

const RANK: Record<Need, number> = { public: 0, viewer: 1, operator: 2, admin: 3 };
const ROLE_RANK: Record<Actor, number> = { anon: 0, viewer: 1, foreign: 2, operator: 2, admin: 3 };

describe('the studio route policy (YOS-208)', () => {
  let root: string;
  let engine: WorldServer;
  let studio: StudioServer;
  let emails: string[] = [];
  let fx: Fixture;
  /** Set while the fixture's own episode runs, so only that one runs a real agent episode on the helpdesk. */
  let realEpisode = false;

  const send = async (actor: Actor, method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; text: string }> => {
    const res = await fetch(`${studio.url}${p}`, {
      method,
      headers: { ...(actor === 'anon' ? {} : { authorization: `Bearer ${TOKENS[actor]}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('latin1') };
  };

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-route-policy-'));
    await symlink(CODE_DIR, path.join(root, 'code'));
    const worldsDir = path.join(root, 'prod', 'worlds');
    const acmeWorld = path.join(worldsDir, 'acme', 'helpdesk');
    await mkdir(acmeWorld, { recursive: true });
    await copyFile(path.join(CODE_DIR, '../prod/worlds/helpdesk/world.yaml'), path.join(acmeWorld, 'world.yaml'));
    const loaded = await loadWorld(acmeWorld);
    assert.ok(loaded.ok);
    const report = checkWorld(loaded.value);
    assert.ok(report.ok);
    engine = await serve(report.world, { port: 0 });
    // The probe: every customer email the world's own seed makes, which the helpdesk marks sensitive.
    const state = (await (await fetch(`${engine.adminUrl}/_world/state`)).json()) as { tables: { customer: { email: string }[] } };
    emails = state.tables.customer.map((c) => c.email);
    assert.equal(emails.length > 0 && emails.every((e) => e.includes('@')), true);
    await writeFile(path.join(acmeWorld, 'REPORT.md'), `# Report\n\nLast issues:\n\n- \`test.failed\` at \`tests.create\`: create returned {"email":"${emails[0]}"}\n`);
    const evalRun = path.join(root, 'eval', 'runs', 'run-leaky');
    await mkdir(evalRun, { recursive: true });
    await writeFile(path.join(evalRun, 'summary.md'), [
      '# Eval run run-leaky', '', '| case | expect | result | stop reason | pass |', '|---|---|---|---|---|',
      `| helpdesk | done | stopped | crashed: row 0 email "${emails[0]}" | no |`, '', '**Pass rate:** 0/1 (0%)', '',
      '## Triage', '', `- test.failed (1): create returned {"email":"${emails[1] ?? emails[0]}"}`, '',
    ].join('\n'));
    await mkdir(path.join(root, 'eval', 'inputs'), { recursive: true });
    await copyFile(path.join(CODE_DIR, '../eval/inputs/petstore.openapi.yaml'), path.join(root, 'eval', 'inputs', 'petstore.openapi.yaml'));

    const spawner: Spawner = (argv) => {
      let exit: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => (exit = resolve));
      let said = argv[1] === 'src/cli/worldplay.ts' && argv[2] === 'serve' ? `{"listening":{"world":${engine.port},"admin":${engine.adminPort}}}\n` : '';
      const child: SpawnedChild = { pid: 47000, exited, kill: () => (exit(null), true), output: () => said };
      if (argv[1] === 'src/cli/episode.ts') {
        const arg = (flag: string): string => String(argv[argv.indexOf(flag) + 1]);
        if (!realEpisode) exit(0);
        else {
          // The real episode, on the helpdesk the studio resolved: the agent lists the customers, then finishes. Its
          // child then fails, printing a customer's email, so its last lines are a value too.
          void runLocalEpisode({
            worldDir: arg('--world'), taskId: arg('--task'), out: arg('--out'), runId: arg('--run-id'), engineCommit: arg('--engine-commit'),
            model: null, nextTurn: scripted([{ action: 'request', method: 'GET', path: '/customers', query: {} }]),
            maxTurns: 3, budgetUsd: 0.01, maxMinutes: 2, redact: redactor([]),
          }).then(() => {
            said = `episode: GET /customers answered ${emails[0]}\n`;
            exit(1);
          }, (e: unknown) => {
            said = `episode failed: ${e instanceof Error ? e.message : String(e)}\n`;
            exit(2);
          });
        }
      }
      return child;
    };
    const runner: Runner = async (argv, o) => {
      if (argv[0] === 'git') return { code: 0, stdout: 'abc1234\n', stderr: '' };
      if (argv[1] === 'src/cli/costs.ts') return { code: 0, stdout: '{"meters":{},"rows":[]}', stderr: '' };
      return nodeRunner(argv, o);
    };
    studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, users: USERS, maxConcurrentRuns: 100, maxConcurrentEpisodes: 100 });

    const made = async (p: string, body: unknown, key: string): Promise<string> => {
      const r = await send('operator', 'POST', p, body);
      assert.equal(r.status < 300, true, `${p}: ${r.text}`);
      return String((JSON.parse(r.text) as Record<string, unknown>)[key]);
    };
    const svc = await made('/api/worlds/helpdesk/serve', {}, 'id');
    const run = JSON.parse((await send('operator', 'POST', '/api/generate', { kind: 'description', text: 'A tiny helpdesk', outSlug: 'policy-run' })).text) as { runId: string; outDir: string };
    // The run is still building in <out>.partial, and one of its seed attempts quoted a customer's email.
    const events = [
      { t: 'attempt', step: 'seed', n: 1, outcome: { kind: 'rejected', issues: [{ code: 'constraint.violation', severity: 'error', path: ['seed', 'customer'], expected: 'customer.email to satisfy unique', found: `row 1, field email: "${emails[0]}"`, hint: 'The engine refused this write. Fix the value or the field definition.' }] } },
      { t: 'attempt', step: 'seed', n: 2, outcome: { kind: 'model_error', message: `the model wrote ${emails[0]}` } },
    ];
    await mkdir(path.join(`${run.outDir}.partial`, 'runs', run.runId), { recursive: true });
    await writeFile(path.join(`${run.outDir}.partial`, 'runs', run.runId, 'events.jsonl'), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    realEpisode = true;
    const episodeId = await made('/api/episodes', { world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop' }, 'runId');
    for (let i = 0; i < 600 && JSON.parse((await send('operator', 'GET', `/api/episodes/${episodeId}`)).text)['running'] !== false; i++) await new Promise((r) => setTimeout(r, 50));
    realEpisode = false;
    const spec = await readFile(path.join(CODE_DIR, '../eval/inputs/petstore.openapi.yaml'), 'utf8');
    const uploaded = await send('operator', 'POST', '/api/uploads', { kind: 'openapi', name: 'pets.yaml', content: spec });
    assert.equal(uploaded.status, 201, uploaded.text);
    const uploadId = (JSON.parse(uploaded.text) as { upload: { id: string } }).upload.id;
    fx = { svc, runId: run.runId, episodeId, uploadId };
  });

  after(async () => {
    await studio.close();
    await engine.close();
    await rm(root, { recursive: true, force: true });
  });

  it('names every route the router answers, with the role the router requires: a new route must join this table', () => {
    const routed = studio.routes.map((r) => [`${r.method} ${r.path}`, r.need]).sort();
    const tabled = TABLE.map((r) => [r.route, r.need]).sort();
    assert.deepEqual(routed, tabled);
  });

  it('states statuses that agree with each row: 401 without a token, 403 below the role, 404 to another tenant for acme\'s', () => {
    for (const row of TABLE) {
      ACTORS.forEach((actor, i) => {
        const status = row.status[i];
        if (row.need !== 'public' && actor === 'anon') assert.equal(status, 401, `${row.route} ${actor}`);
        else if (ROLE_RANK[actor] < RANK[row.need]) assert.equal(status, 403, `${row.route} ${actor}`);
        else if (actor === 'foreign' && row.tenant === "acme's") assert.equal(status, row.foreign, `${row.route} ${actor}`);
      });
    }
  });

  for (const row of TABLE) {
    it(`${row.route}: ${row.need}, ${row.tenant}, carries ${row.carries}`, async () => {
      const [method] = row.route.split(' ') as ['GET' | 'POST'];
      const seen: number[] = [];
      for (const actor of ACTORS) {
        const p = row.path(fx);
        const asked = actor === 'admin' && row.tenant === "acme's" ? `${p}${p.includes('?') ? '&' : '?'}tenant=acme` : p;
        const r = await send(actor, method, asked, row.body);
        seen.push(r.status);
        const leaked = emails.filter((e) => r.text.includes(e));
        if (actor === 'admin') {
          if (row.adminSees === true) assert.notDeepEqual(leaked, [], `${row.route}: the admin's answer should hold an email, or the probe proves nothing`);
        } else {
          assert.deepEqual(leaked, [], `${row.route} as ${actor}: ${r.text.slice(0, 300)}`);
        }
        if (actor === 'foreign' && row.foreignHides !== undefined) assert.equal(r.text.includes(row.foreignHides(fx)), false, `${row.route}: globex sees acme's ${row.foreignHides(fx)}`);
      }
      assert.deepEqual(seen, row.status);
    });
  }
});
