/**
 * The Studio World Builder (YOS-188): OpenAPI and CSV uploads stored in the caller's tenant, generations that read
 * them, and the plan view of a generated world. The spawner and runner are fakes, so no child starts and no model is
 * called; every studio binds loopback port 0 only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkWorld, saveWorld, type World } from '#engine';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { studioPage } from '../src/studio/page.ts';
import { studioServer, type StudioOptions, type StudioUser } from '../src/studio/server.ts';
import { minimalWorld } from './helpers/world.ts';

type Json = { [k: string]: unknown };

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const ANN = 'ann-token-acme-viewer';
const OTTO = 'otto-token-acme-operator';
const GINA = 'gina-token-globex-operator';
const ADA = 'ada-token-ops-admin';
const DEE = 'dee-token-default-operator';
const USERS: readonly StudioUser[] = [
  { name: 'ann', role: 'viewer', tenant: 'acme', tokenSha256: digest(ANN) },
  { name: 'otto', role: 'operator', tenant: 'acme', tokenSha256: digest(OTTO) },
  { name: 'gina', role: 'operator', tenant: 'globex', tokenSha256: digest(GINA) },
  { name: 'ada', role: 'admin', tenant: 'ops', tokenSha256: digest(ADA) },
  { name: 'dee', role: 'operator', tenant: 'default', tokenSha256: digest(DEE) },
];

async function call(base: string, method: 'GET' | 'POST', p: string, token?: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}

const refusal = (status: number, code: string, message: string): unknown[] => [status, { error: { code, message } }];
const answer = async (r: Promise<{ status: number; body: Json }>): Promise<unknown[]> => {
  const done = await r;
  return [done.status, done.body];
};
const codeOf = (body: Json): unknown => (body['error'] as Json | undefined)?.['code'];

function fakeSpawner(): { spawner: Spawner; spawned: string[][] } {
  const spawned: string[][] = [];
  const spawner: Spawner = (argv) => {
    spawned.push([...argv]);
    const child: SpawnedChild = { pid: 47000 + spawned.length, exited: new Promise<number | null>(() => {}), kill: () => true, output: () => '' };
    return child;
  };
  return { spawner, spawned };
}

const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });

const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

// ---- fixture facts --------------------------------------------------------------------------------

const PET = 'openapi: 3.1.0\ninfo:\n  title: Pets\n  version: 1.0.0\npaths:\n  /pet: {}\n  /pet/{petId}: {}\n  /store/order: {}\n';
const PET_ID = 'b17a23cd7ab3-petstore.yaml';
const ORDERS = 'id,customer\no1,cus_0001\n';
const ORDERS_ID = '3adb605544fc-orders.csv';
const CUSTOMERS = 'id,name\ncus_0001,Acme\n';
const CUSTOMERS_ID = '34491aa5d585-customers.csv';
const REFUNDS_JSON = '{"swagger":"2.0","paths":{"/refunds":{}}}';
const REFUNDS_ID = 'f0890abd8705-refunds.json';
const NAME_RULE = 'name must be a bare file name: 1 to 100 letters, digits, dots, underscores or dashes, starting with a letter or digit';

const PLAN_YAML = `revision: 1
software: Petstore-style shop
summary: Customers adopt pets.
clock:
  start: '2026-01-05T09:00:00.000Z'
  tick: 0s
verdict:
  kind: proceed
entities:
  - name: pet
    purpose: an animal for adoption
    keyFields: [name, status]
workflows:
  - name: adoption
    entity: pet
    states: [available, adopted]
    rules: [A pet is adopted once.]
    actions: [adopt_pet]
routes:
  - id: list_pets
    method: GET
    path: /pets
    purpose: browse pets
seed:
  rowsPerEntity: { pet: 10 }
  mix: half adopted
tasks:
  - { id: adopt_one, difficulty: easy, intent: adopt one named pet, decoyIdea: adopts a look-alike }
  - { id: adopt_pair, difficulty: medium, intent: adopt two siblings, decoyIdea: adopts one }
  - { id: adopt_oldest, difficulty: hard, intent: adopt the oldest available pet, decoyIdea: adopts the youngest }
open_questions:
  - question: Can a pet be returned?
    default_answer: 'No, adoption is final.'
assumptions:
  - decision: Prices are in USD.
    why: The spec names no currency.
outOfScope:
  - what: Payments
    why: The spec has no payment route.
`;
const PLAN_MD = '# Hand-written plan\n\nAdopt pets; no payments.\n';
const PLAN_LISTS = {
  assumptions: [{ decision: 'Prices are in USD.', why: 'The spec names no currency.' }],
  openQuestions: [{ question: 'Can a pet be returned?', default_answer: 'No, adoption is final.' }],
  outOfScope: [{ what: 'Payments', why: 'The spec has no payment route.' }],
};
const CANARY = 'STUDIO_BUILDER_CANARY_GRADER';

/** minimalWorld with a canary comment right after the first arrow of one grader, and that grader's source. */
function canaryWorld(): { world: World; grader: string } {
  const base = minimalWorld();
  const [id, task] = Object.entries(base.tasks)[0] ?? [];
  assert.ok(id !== undefined && task !== undefined && task.grader !== undefined && task.grader.includes('=>'));
  const grader = task.grader.replace('=>', `=> /* ${CANARY} */`);
  return { world: minimalWorld({ tasks: { ...base.tasks, [id]: { ...task, grader } } }), grader };
}

/** The only writer of a fixture world.yaml: through checkWorld and saveWorld. */
async function writeWorld(dir: string, world: World): Promise<void> {
  const report = checkWorld(world);
  if (!report.ok) assert.fail(`fixture world failed check:\n${JSON.stringify(report.issues, null, 2)}`);
  await mkdir(dir, { recursive: true });
  await saveWorld(dir, report.world);
}

type Fixture = { root: string; worldsDir: string; inputsDir: string; spawned: string[][] };

/** A repo with one CSV under eval/inputs and the given plan-only world dirs, keyed by their path under the worlds dir. */
async function fixture(plans: Readonly<Record<string, string>> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-builder-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  const inputsDir = path.join(root, 'eval', 'inputs');
  await mkdir(path.join(root, 'code'), { recursive: true });
  await mkdir(inputsDir, { recursive: true });
  await writeFile(path.join(inputsDir, 'refunds.csv'), 'id,amount\nre_1,100\n');
  for (const [dir, text] of Object.entries(plans)) {
    await mkdir(path.join(worldsDir, dir), { recursive: true });
    await writeFile(path.join(worldsDir, dir, 'plan.yaml'), text);
  }
  return { root, worldsDir, inputsDir, spawned: [] };
}

async function start(f: Fixture, opts: Partial<StudioOptions> = {}): Promise<string> {
  const fake = fakeSpawner();
  f.spawned = fake.spawned;
  const studio = await studioServer({
    port: 0, repoRoot: f.root, worldsDir: f.worldsDir, spawner: fake.spawner, runner,
    rateLimit: { capacity: 1000, refillPerSecond: 1000 }, maxConcurrentRuns: 100, ...opts,
  });
  closers.push(() => studio.close());
  return studio.url;
}

const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

describe('studio builder: upload validation (YOS-188)', () => {
  it('refuses each bad upload with 400 and one upload.* code, and stores nothing', async () => {
    const f = await fixture();
    const base = await start(f);
    const csv = (content: unknown, name = 'x.csv'): Json => ({ kind: 'csv', name, content });
    const spec = (content: string, name = 'x.yaml'): Json => ({ kind: 'openapi', name, content });
    const cases: readonly [unknown, string, string | null][] = [
      [undefined, 'upload.body', 'the body must be a JSON object: {"kind", "name", "content"}'],
      [['petstore.yaml'], 'upload.body', 'the body must be a JSON object: {"kind", "name", "content"}'],
      [{ kind: 'pdf', name: 'a.pdf', content: 'x' }, 'upload.kind', 'kind must be openapi or csv'],
      [{ name: 'a.csv', content: 'id\n' }, 'upload.kind', 'kind must be openapi or csv'],
      [csv('id\n', '../evil.csv'), 'upload.name', NAME_RULE],
      [csv('id\n', 'dir/evil.csv'), 'upload.name', NAME_RULE],
      [csv('id\n', '.hidden.csv'), 'upload.name', NAME_RULE],
      [csv('id\n', 'with space.csv'), 'upload.name', NAME_RULE],
      [csv('id\n', `${'a'.repeat(97)}.csv`), 'upload.name', NAME_RULE],
      [{ kind: 'csv', name: 7, content: 'id\n' }, 'upload.name', NAME_RULE],
      [spec(PET, 'petstore.txt'), 'upload.extension', 'an openapi upload is named .yaml, .yml or .json'],
      [csv('id\n', 'orders.yaml'), 'upload.extension', 'a csv upload is named .csv'],
      [csv(42), 'upload.content', 'content must be the file\'s text'],
      [csv('id\0,name\n'), 'upload.nul', 'content holds a NUL character, so it is not a text file'],
      [csv('a'.repeat(524_289)), 'upload.too_large', 'content is 524289 bytes; the most is 524288'],
      [csv('é'.repeat(262_145)), 'upload.too_large', 'content is 524290 bytes; the most is 524288'],
      [spec('openapi: [unclosed'), 'upload.openapi', null],
      [spec('- /pet\n- /store\n'), 'upload.openapi', 'the spec is not a YAML or JSON object'],
      [spec('title: Pets\npaths: {}\n'), 'upload.openapi', 'the spec has no openapi or swagger version string'],
      [spec('openapi: 3.1\npaths: {}\n'), 'upload.openapi', 'the spec has no openapi or swagger version string'],
      [spec('{"openapi":"3.1.0"}', 'x.json'), 'upload.openapi', 'the spec has no paths object'],
      [spec('openapi: 3.1.0\npaths: [/pet]\n'), 'upload.openapi', 'the spec has no paths object'],
      [csv(''), 'upload.csv', 'the first line must be a header with at least one named column'],
      [csv('\nid,name\n'), 'upload.csv', 'the first line must be a header with at least one named column'],
      [csv(' , ,\n1,2\n'), 'upload.csv', 'the first line must be a header with at least one named column'],
    ];
    for (const [body, code, message] of cases) {
      const r = await call(base, 'POST', '/api/uploads', undefined, body);
      const error = r.body['error'] as Json | undefined;
      assert.deepEqual([r.status, error?.['code']], [400, code], JSON.stringify(body)?.slice(0, 80));
      if (message !== null) assert.equal(error?.['message'], message);
    }
    const unparsable = await call(base, 'POST', '/api/uploads', undefined, spec('openapi: [unclosed'));
    assert.match(String((unparsable.body['error'] as Json)['message']), /^the spec does not parse as YAML or JSON: /);
    assert.deepEqual(await answer(call(base, 'GET', '/api/uploads')), [200, { uploads: [] }]);
    assert.equal(await stat(path.join(f.worldsDir, '.uploads')).then(() => true, () => false), false);
  });

  it('reads an upload whose JSON body passes 1 MiB, since the limit is the content\'s 512 KiB of UTF-8', async () => {
    const f = await fixture();
    const base = await start(f);
    const quotes = await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'quotes.csv', content: '"'.repeat(524_288) });
    assert.deepEqual([quotes.status, quotes.body], [201, { upload: { id: 'b7189c7f7cb4-quotes.csv', kind: 'csv', name: 'quotes.csv', bytes: 524_288 } }]);
  });
});

describe('studio builder: stored uploads (YOS-188)', () => {
  it('stores an openapi upload once under the default tenant\'s worlds dir, 0600 in 0700 dirs, and answers its paths', async () => {
    const f = await fixture();
    const base = await start(f);
    const first = await call(base, 'POST', '/api/uploads', undefined, { kind: 'openapi', name: 'petstore.yaml', content: PET });
    const stored = { upload: { id: PET_ID, kind: 'openapi', name: 'petstore.yaml', bytes: 108, paths: ['/pet', '/pet/{petId}', '/store/order'] } };
    assert.deepEqual([first.status, first.body], [201, stored]);
    const file = path.join(f.worldsDir, '.uploads', 'b17a23cd7ab3', 'petstore.yaml');
    assert.equal(await readFile(file, 'utf8'), PET);
    assert.deepEqual([await mode(file), await mode(path.dirname(file)), await mode(path.join(f.worldsDir, '.uploads'))], [0o600, 0o700, 0o700]);
    const before = (await stat(file)).mtimeMs;

    const again = await call(base, 'POST', '/api/uploads', undefined, { kind: 'openapi', name: 'petstore.yaml', content: PET });
    assert.deepEqual([again.status, again.body], [200, stored]);
    assert.equal((await stat(file)).mtimeMs, before);
    assert.equal(await readFile(file, 'utf8'), PET);

    assert.deepEqual(await answer(call(base, 'GET', `/api/uploads/${PET_ID}/paths`)), [200, { upload: PET_ID, paths: ['/pet', '/pet/{petId}', '/store/order'] }]);
    const swagger = await call(base, 'POST', '/api/uploads', undefined, { kind: 'openapi', name: 'refunds.json', content: REFUNDS_JSON });
    assert.deepEqual([swagger.status, swagger.body], [201, { upload: { id: REFUNDS_ID, kind: 'openapi', name: 'refunds.json', bytes: 41, paths: ['/refunds'] } }]);
    assert.deepEqual(await answer(call(base, 'GET', '/api/uploads')), [200, { uploads: [
      { id: PET_ID, kind: 'openapi', name: 'petstore.yaml', bytes: 108 },
      { id: REFUNDS_ID, kind: 'openapi', name: 'refunds.json', bytes: 41 },
    ] }]);
  });

  it('lies under a path git ignores, on the library shelf and on a tenant\'s, since the default worlds dir is prod/worlds', () => {
    const paths = ['prod/worlds/.uploads/b17a23cd7ab3/petstore.yaml', 'prod/worlds/acme/.uploads/3adb605544fc/orders.csv', 'prod/worlds/helpdesk/world.yaml'];
    const repo = path.resolve(import.meta.dirname, '../..');
    const ignored = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', ...paths], { cwd: repo, encoding: 'utf8' });
    assert.deepEqual([ignored.status, ignored.stdout], [0, 'prod/worlds/.uploads/b17a23cd7ab3/petstore.yaml\nprod/worlds/acme/.uploads/3adb605544fc/orders.csv\n']);
  });

  it('stores csv uploads by their original names, lists every upload by name, and resolves no id outside the dir', async () => {
    const f = await fixture();
    const base = await start(f);
    const orders = await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'orders.csv', content: ORDERS });
    assert.deepEqual([orders.status, orders.body], [201, { upload: { id: ORDERS_ID, kind: 'csv', name: 'orders.csv', bytes: 24 } }]);
    assert.equal((await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'customers.csv', content: CUSTOMERS })).status, 201);
    assert.equal((await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'orders.csv', content: 'id,total\no2,9\n' })).status, 201);
    assert.equal(await readFile(path.join(f.worldsDir, '.uploads', '3adb605544fc', 'orders.csv'), 'utf8'), ORDERS);
    assert.deepEqual((await call(base, 'GET', '/api/uploads')).body, { uploads: [
      { id: CUSTOMERS_ID, kind: 'csv', name: 'customers.csv', bytes: 22 },
      { id: ORDERS_ID, kind: 'csv', name: 'orders.csv', bytes: 24 },
      { id: 'afcb8903921b-orders.csv', kind: 'csv', name: 'orders.csv', bytes: 14 },
    ] });

    assert.deepEqual(await answer(call(base, 'GET', `/api/uploads/${ORDERS_ID}/paths`)), refusal(400, 'upload.kind', `upload ${ORDERS_ID} is a csv table; only an OpenAPI upload has paths`));
    await writeFile(path.join(f.worldsDir, 'world.yaml.csv'), 'id\n');
    for (const id of ['nope', '3adb605544fc-..%2F..%2Fworld.yaml.csv', '3adb605544fc', '3ADB605544FC-orders.csv', '000000000000-orders.csv']) {
      assert.deepEqual(await answer(call(base, 'GET', `/api/uploads/${id}/paths`)), refusal(404, 'upload.unknown', `No upload ${decodeURIComponent(id)}`), id);
    }
  });

  it('refuses a new upload past 100 per tenant with 409 upload.full, and still answers one stored before', async () => {
    const f = await fixture();
    const base = await start(f);
    for (let i = 0; i < 100; i++) {
      const r = await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: `t${i}.csv`, content: 'id\n' });
      assert.equal(r.status, 201, String(i));
    }
    assert.deepEqual(await answer(call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 't100.csv', content: 'id\n' })),
      refusal(409, 'upload.full', 'this tenant already stores 100 uploads, the most the studio keeps for one tenant'));
    assert.equal((await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 't0.csv', content: 'id\n' })).status, 200);
    assert.equal(((await call(base, 'GET', '/api/uploads')).body['uploads'] as unknown[]).length, 100);
  });
});

describe('studio builder: generating from uploads (YOS-188)', () => {
  it('passes an openapi upload\'s absolute path to worldgen and checks --only against its paths', async () => {
    const f = await fixture();
    const base = await start(f);
    await call(base, 'POST', '/api/uploads', undefined, { kind: 'openapi', name: 'petstore.yaml', content: PET });
    await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'orders.csv', content: ORDERS });
    const r = await call(base, 'POST', '/api/generate', undefined, { kind: 'openapi', upload: PET_ID, only: ['/pet'], outSlug: 'pets-up' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(f.spawned, [[
      'bun', 'src/cli/worldgen.ts', '--openapi', path.join(f.worldsDir, '.uploads', 'b17a23cd7ab3', 'petstore.yaml'),
      '--only', '/pet', '--out', path.join(f.worldsDir, 'gen-pets-up'),
    ]]);

    const gen = (body: Json): Promise<unknown[]> => answer(call(base, 'POST', '/api/generate', undefined, { kind: 'openapi', outSlug: 'pets-bad', ...body }));
    assert.deepEqual(await gen({ upload: PET_ID, only: ['/refunds'] }), refusal(400, 'generate.only', 'no path in the spec starts with /refunds; the spec has /pet, /pet/{petId}, /store/order'));
    assert.deepEqual(await gen({ upload: PET_ID, spec: 'petstore.openapi.yaml' }), refusal(400, 'generate.spec', 'give either an upload or a spec under eval/inputs, not both'));
    assert.deepEqual(await gen({ upload: PET_ID, text: 'petstore.openapi.yaml' }), refusal(400, 'generate.spec', 'give either an upload or a spec under eval/inputs, not both'));
    assert.deepEqual(await gen({ upload: ORDERS_ID }), refusal(400, 'generate.upload', `upload ${ORDERS_ID} is a csv table, not an OpenAPI spec`));
    assert.deepEqual(await gen({ upload: 'b17a23cd7ab3-../../world.yaml' }), refusal(400, 'generate.upload', 'No upload b17a23cd7ab3-../../world.yaml'));
    assert.deepEqual(await gen({ upload: 7 }), refusal(400, 'generate.upload', 'upload must be an upload id, such as the id POST /api/uploads answered'));
    assert.equal(f.spawned.length, 1);
  });

  it('passes eval/inputs CSV files first, then uploads in the order given, under their original names', async () => {
    const f = await fixture();
    const base = await start(f);
    await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'orders.csv', content: ORDERS });
    await call(base, 'POST', '/api/uploads', undefined, { kind: 'csv', name: 'customers.csv', content: CUSTOMERS });
    await call(base, 'POST', '/api/uploads', undefined, { kind: 'openapi', name: 'petstore.yaml', content: PET });
    const up = (sha12: string, name: string): string => path.join(f.worldsDir, '.uploads', sha12, name);

    const mixed = await call(base, 'POST', '/api/generate', undefined, { kind: 'csv', files: ['refunds.csv'], uploads: [ORDERS_ID, CUSTOMERS_ID], outSlug: 'shop' });
    assert.equal(mixed.status, 200, JSON.stringify(mixed.body));
    const only = await call(base, 'POST', '/api/generate', undefined, { kind: 'csv', uploads: [CUSTOMERS_ID], outSlug: 'people' });
    assert.equal(only.status, 200, JSON.stringify(only.body));
    assert.deepEqual(f.spawned, [
      ['bun', 'src/cli/worldgen.ts', '--csv', path.join(f.inputsDir, 'refunds.csv'), up('3adb605544fc', 'orders.csv'), up('34491aa5d585', 'customers.csv'), '--out', path.join(f.worldsDir, 'gen-shop')],
      ['bun', 'src/cli/worldgen.ts', '--csv', up('34491aa5d585', 'customers.csv'), '--out', path.join(f.worldsDir, 'gen-people')],
    ]);

    const gen = (body: Json): Promise<unknown[]> => answer(call(base, 'POST', '/api/generate', undefined, { kind: 'csv', outSlug: 'shop-bad', ...body }));
    assert.deepEqual(await gen({ files: ['refunds.csv'], uploads: [ORDERS_ID, '000000000000-ghost.csv'] }), refusal(400, 'generate.upload', 'No upload 000000000000-ghost.csv'));
    assert.deepEqual(await gen({ uploads: [PET_ID] }), refusal(400, 'generate.upload', `upload ${PET_ID} is an OpenAPI spec, not a csv table`));
    assert.deepEqual(await gen({ uploads: ORDERS_ID }), refusal(400, 'generate.upload', 'uploads must be a list of upload ids, such as the ids POST /api/uploads answered'));
    assert.deepEqual(await gen({ files: [], uploads: [] }), refusal(400, 'generate.files', 'csv needs 1 to 8 CSV files, under eval/inputs or uploaded'));
    assert.deepEqual(await gen({ files: ['refunds.csv'], uploads: Array.from({ length: 8 }, () => ORDERS_ID) }), refusal(400, 'generate.files', 'csv needs 1 to 8 CSV files, under eval/inputs or uploaded'));
    assert.equal(f.spawned.length, 2);
  });
});

describe('studio builder: uploads per tenant (YOS-188)', () => {
  it('keeps each tenant\'s uploads in its own dir, and an id of one tenant unknown to every other', async () => {
    const f = await fixture();
    const base = await start(f, { users: USERS });
    const pet = { kind: 'openapi', name: 'petstore.yaml', content: PET };
    assert.equal((await call(base, 'POST', '/api/uploads', OTTO, pet)).status, 201);
    assert.equal((await call(base, 'POST', '/api/uploads', OTTO, { kind: 'csv', name: 'orders.csv', content: ORDERS })).status, 201);
    assert.equal(await readFile(path.join(f.worldsDir, 'acme', '.uploads', 'b17a23cd7ab3', 'petstore.yaml'), 'utf8'), PET);
    assert.equal(codeOf((await call(base, 'POST', '/api/uploads', ANN, pet)).body), 'auth.forbidden');
    const acme = [{ id: ORDERS_ID, kind: 'csv', name: 'orders.csv', bytes: 24 }, { id: PET_ID, kind: 'openapi', name: 'petstore.yaml', bytes: 108 }];
    assert.deepEqual(await answer(call(base, 'GET', '/api/uploads', ANN)), [200, { uploads: acme }]);

    assert.deepEqual(await answer(call(base, 'GET', '/api/uploads', GINA)), [200, { uploads: [] }]);
    assert.deepEqual(await answer(call(base, 'GET', `/api/uploads/${PET_ID}/paths`, GINA)), refusal(404, 'upload.unknown', `No upload ${PET_ID}`));
    assert.deepEqual(await answer(call(base, 'POST', '/api/generate', GINA, { kind: 'openapi', upload: PET_ID, outSlug: 'stolen' })), refusal(400, 'generate.upload', `No upload ${PET_ID}`));
    assert.deepEqual(await answer(call(base, 'POST', '/api/generate', GINA, { kind: 'csv', uploads: [ORDERS_ID], outSlug: 'stolen' })), refusal(400, 'generate.upload', `No upload ${ORDERS_ID}`));
    assert.deepEqual(await answer(call(base, 'GET', '/api/uploads?tenant=acme', ADA)), [200, { uploads: [] }]);
    assert.deepEqual(await answer(call(base, 'GET', '/api/uploads', DEE)), [200, { uploads: [] }]);
    assert.deepEqual(f.spawned, []);

    assert.equal((await call(base, 'POST', '/api/generate', OTTO, { kind: 'openapi', upload: PET_ID, outSlug: 'pets' })).status, 200);
    assert.equal((await call(base, 'POST', '/api/uploads', DEE, pet)).status, 201);
    assert.equal(await readFile(path.join(f.worldsDir, '.uploads', 'b17a23cd7ab3', 'petstore.yaml'), 'utf8'), PET);
    assert.equal((await call(base, 'POST', '/api/generate', DEE, { kind: 'openapi', upload: PET_ID, outSlug: 'pets' })).status, 200);
    assert.deepEqual(f.spawned, [
      ['bun', 'src/cli/worldgen.ts', '--openapi', path.join(f.worldsDir, 'acme', '.uploads', 'b17a23cd7ab3', 'petstore.yaml'), '--out', path.join(f.worldsDir, 'acme', 'gen-pets')],
      ['bun', 'src/cli/worldgen.ts', '--openapi', path.join(f.worldsDir, '.uploads', 'b17a23cd7ab3', 'petstore.yaml'), '--out', path.join(f.worldsDir, 'gen-pets')],
    ]);
  });

  it('never lists .uploads as a world or a run source, never resolves it as a world, and never takes it as a tenant', async () => {
    const f = await fixture({ 'gen-shared': PLAN_YAML, 'acme/gen-acme-plan': PLAN_YAML });
    const base = await start(f, { users: USERS });
    // Uploads named like a world's own files, in the library's .uploads and in a tenant's.
    for (const token of [DEE, OTTO]) {
      for (const name of ['world.yaml', 'plan.yaml']) {
        assert.equal((await call(base, 'POST', '/api/uploads', token, { kind: 'openapi', name, content: PET })).status, 201);
      }
    }
    const rows = async (p: string): Promise<unknown[]> => ((await call(base, 'GET', p, ADA)).body['worlds'] as Json[]).map((w) => [w['name'], w['tenant']]);
    assert.deepEqual(await rows('/api/worlds'), [['gen-shared', null], ['gen-acme-plan', 'acme']]);
    assert.deepEqual(await rows('/api/worlds?tenant=acme'), [['gen-shared', null], ['gen-acme-plan', 'acme']]);
    assert.deepEqual(((await call(base, 'GET', '/api/worlds', OTTO)).body['worlds'] as Json[]).map((w) => w['name']), ['gen-shared', 'gen-acme-plan']);
    assert.deepEqual(await answer(call(base, 'GET', '/api/runs', ADA)), [200, { runs: [] }]);
    assert.equal((await call(base, 'GET', '/api/health')).body['worlds'], 1);
    for (const [p, token] of [['/api/worlds/.uploads/report', ADA], ['/api/worlds/.uploads/report?tenant=acme', ADA], ['/api/worlds/.uploads/plan', OTTO], ['/api/worlds/.uploads/tasks', DEE]] as const) {
      assert.deepEqual(await answer(call(base, 'GET', p, token)), refusal(404, 'world.unknown', `No world .uploads under ${f.worldsDir}`), p);
    }
    assert.equal(codeOf((await call(base, 'POST', '/api/worlds/.uploads/serve', DEE, {})).body), 'world.unknown');
    assert.equal(codeOf((await call(base, 'GET', '/api/worlds?tenant=.uploads', ADA)).body), 'tenant.invalid');
    assert.deepEqual(f.spawned, []);
  });

  it('keeps .uploads out of the open studio\'s worlds too', async () => {
    const f = await fixture({ 'gen-shared': PLAN_YAML });
    const base = await start(f);
    assert.equal((await call(base, 'POST', '/api/uploads', undefined, { kind: 'openapi', name: 'world.yaml', content: PET })).status, 201);
    assert.deepEqual(((await call(base, 'GET', '/api/worlds')).body['worlds'] as Json[]).map((w) => w['name']), ['gen-shared']);
    assert.equal(codeOf((await call(base, 'GET', '/api/worlds/.uploads/report')).body), 'world.unknown');
  });
});

describe('studio builder: the plan view (YOS-188)', () => {
  it('answers plan.yaml\'s lists with plan.md as the run wrote it', async () => {
    const f = await fixture({ 'gen-planned': PLAN_YAML });
    await writeFile(path.join(f.worldsDir, 'gen-planned', 'plan.md'), PLAN_MD);
    const base = await start(f);
    assert.deepEqual(await answer(call(base, 'GET', '/api/worlds/gen-planned/plan')), [200, { name: 'gen-planned', ...PLAN_LISTS, planMd: PLAN_MD }]);
  });

  it('renders plan.md from plan.yaml when the run wrote none', async () => {
    const f = await fixture({ 'gen-rendered': PLAN_YAML });
    const base = await start(f);
    const r = await call(base, 'GET', '/api/worlds/gen-rendered/plan');
    assert.equal(r.status, 200);
    const { planMd, ...lists } = r.body;
    assert.deepEqual(lists, { name: 'gen-rendered', ...PLAN_LISTS });
    assert.equal(String(planMd).startsWith('# WorldGen plan: Petstore-style shop\n\nCustomers adopt pets.\n\n- Revision: 1\n- Verdict: proceed\n- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s\n\n## Entities\n'), true, String(planMd));
    assert.equal(String(planMd).includes('## Assumptions\n\n- Prices are in USD.\n  - Why: The spec names no currency.\n'), true);
  });

  it('refuses a plan that embeds grader source with 403 plan.private_source, and never answers the canary', async () => {
    const f = await fixture({ 'gen-leaky': PLAN_YAML });
    const dir = path.join(f.worldsDir, 'gen-leaky');
    const { world, grader } = canaryWorld();
    await writeWorld(dir, world);
    assert.equal((await readFile(path.join(dir, 'world.yaml'), 'utf8')).includes(CANARY), true);
    await writeFile(path.join(dir, 'plan.md'), `# Plan\n\nThe grader we built:\n\n${grader}\n`);
    const base = await start(f);
    const r = await fetch(`${base}/api/worlds/gen-leaky/plan`);
    const text = await r.text();
    assert.deepEqual([r.status, JSON.parse(text)], refusal(403, 'plan.private_source', 'gen-leaky\'s plan contains private task source; the studio refuses to serve it'));
    assert.equal(text.includes(CANARY), false);

    await writeFile(path.join(dir, 'plan.md'), PLAN_MD);
    assert.deepEqual(await answer(call(base, 'GET', '/api/worlds/gen-leaky/plan')), [200, { name: 'gen-leaky', ...PLAN_LISTS, planMd: PLAN_MD }]);
  });

  it('answers 404 plan.missing without plan.yaml, 422 plan.invalid for one that is no plan, and 404 for another tenant\'s world', async () => {
    const f = await fixture({ 'gen-badplan': 'revision: 1\n', 'acme/gen-acme-plan': PLAN_YAML, 'gen-planonly': PLAN_YAML });
    await mkdir(path.join(f.worldsDir, 'hand-only'), { recursive: true });
    await writeFile(path.join(f.worldsDir, 'hand-only', 'REPORT.md'), '# Hand-built\n');
    // Each has a world with no sensitive field, so a viewer may read its plan (A-367); gen-planonly has none to tell.
    for (const dir of ['hand-only', 'gen-badplan', 'acme/gen-acme-plan']) await writeWorld(path.join(f.worldsDir, dir), minimalWorld());
    const base = await start(f, { users: USERS });
    assert.deepEqual(await answer(call(base, 'GET', '/api/worlds/gen-planonly/plan', ANN)), refusal(403, 'plan.sensitive', 'gen-planonly cannot be read to find its sensitive fields, so only an admin may read its plan'));
    assert.deepEqual(await answer(call(base, 'GET', '/api/worlds/hand-only/plan', ANN)), refusal(404, 'plan.missing', 'hand-only has no plan.yaml; only a generated world has a plan'));
    assert.deepEqual(await answer(call(base, 'GET', '/api/worlds/gen-badplan/plan', ANN)), refusal(422, 'plan.invalid', 'gen-badplan/plan.yaml does not parse as a WorldGen plan'));
    const own = await call(base, 'GET', '/api/worlds/gen-acme-plan/plan', ANN);
    const { planMd, ...lists } = own.body;
    assert.deepEqual([own.status, lists], [200, { name: 'gen-acme-plan', ...PLAN_LISTS }]);
    assert.equal(String(planMd).startsWith('# WorldGen plan: Petstore-style shop\n'), true);
    assert.deepEqual(await answer(call(base, 'GET', '/api/worlds/gen-acme-plan/plan', GINA)), refusal(404, 'world.unknown', `No world gen-acme-plan under ${f.worldsDir}`));
    assert.equal((await call(base, 'GET', '/api/worlds/gen-acme-plan/plan?tenant=acme', ADA)).status, 200);
    assert.equal(codeOf((await call(base, 'GET', '/api/worlds/gen-acme-plan/plan')).body), 'auth.required');
  });
});

describe('studio builder: the page (YOS-188)', () => {
  const html = studioPage();

  it('offers a file input and an upload button for each input kind, and lists uploads beside eval/inputs', () => {
    for (const fragment of [
      '<input id="gen-spec-file" type="file" accept=".yaml,.yml,.json">',
      '<button id="gen-spec-upload" type="button">upload</button>',
      '<input id="gen-csv-file" type="file" accept=".csv" multiple>',
      '<button id="gen-csv-upload" type="button">upload</button>',
      '<div id="world-plan" hidden></div>',
    ]) {
      assert.equal(html.includes(fragment), true, fragment);
    }
    const openapiRow = html.slice(html.indexOf('<div id="gen-openapi-row"'), html.indexOf('</div>', html.indexOf('<div id="gen-openapi-row"')));
    assert.equal(openapiRow.includes('id="gen-spec-file"'), true);
    const csvRow = html.slice(html.indexOf('<div id="gen-csv-row"'), html.indexOf('</div>', html.indexOf('<div id="gen-csv-row"')));
    assert.equal(csvRow.includes('id="gen-csv-file"'), true);
  });

  it('reads files as text, posts each to /api/uploads, fetches upload paths and a world\'s plan, and renders by textContent', () => {
    for (const fragment of [
      'f.text()',
      "post('/api/uploads', { kind: kind, name: f.name, content: content })",
      "getJson('/api/uploads')",
      "'/api/uploads/' + encodeURIComponent(spec.slice(UPLOAD.length)) + '/paths'",
      "'/api/worlds/' + encodeURIComponent(name) + '/plan'",
      "var UPLOAD = 'upload:';",
      'body.upload = spec.slice(UPLOAD.length)',
      'body.uploads = uploaded',
      "'uploaded: ' + u.name",
      "el('pre', body.planMd)",
    ]) {
      assert.equal(html.includes(fragment), true, fragment);
    }
    for (const banned of ['innerHTML', 'http://', 'https://', 'FileReader', 'readAsDataURL']) assert.equal(html.includes(banned), false, banned);
  });

  it('names an element of the document in every byId the script calls, so no listener throws at load', () => {
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const used = [...new Set([...html.matchAll(/byId\('([^']+)'\)/g)].map((m) => m[1]))];
    assert.equal(used.includes('gen-spec-upload') && used.includes('gen-csv-upload') && used.includes('world-plan'), true);
    assert.deepEqual(used.filter((id) => !ids.has(id)), []);
  });
});
