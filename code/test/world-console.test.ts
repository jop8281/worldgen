/**
 * The operator console: the self-contained page the admin port serves at `GET /`, and the
 * admin OpenAPI mirror at `GET /_world/openapi` (the operator-console issue).
 *
 * The world port must stay exactly as it was: `/` and every `/_world*` path answer 404 there
 * (A-31), so the agent under test never sees the console. The page is fully offline (no
 * absolute URL anywhere in the document), and no private task material (graders, solutions,
 * decoys) reaches it or the admin OpenAPI body, which `openApiOf` builds without tasks.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { applyEdit, checkWorld, serve, type CheckedWorld, type World, type WorldServer } from '#engine';
import { minimalWorld } from './helpers/world.ts';

type Reply = { status: number; body: unknown; text: string; type: string | null };

async function send(base: string, method: string, p: string, body?: string): Promise<Reply> {
  const res = await fetch(`${base}${p}`, {
    method,
    ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
  });
  const text = await res.text();
  // The console page is HTML, so only a JSON content type carries a parsed body.
  const json = text !== '' && (res.headers.get('content-type') ?? '').startsWith('application/json');
  return { status: res.status, text, body: json ? JSON.parse(text) : null, type: res.headers.get('content-type') };
}

function checked(world: World): CheckedWorld {
  const report = checkWorld(world);
  if (!report.ok) assert.fail(`world did not pass check:\n${JSON.stringify(report.issues, null, 2)}`);
  return report.world;
}

/** One served minimal world per describe, reset to seed before each case. */
function servedWorld(world: () => World = () => minimalWorld()): {
  srv: () => WorldServer;
  api: (m: string, p: string, b?: string) => Promise<Reply>;
  admin: (m: string, p: string, b?: string) => Promise<Reply>;
} {
  let server: WorldServer | undefined;
  before(async () => {
    server = await serve(checked(world()), { port: 0 });
  });
  after(async () => {
    await server?.close();
  });
  const srv = (): WorldServer => {
    assert.ok(server, 'server did not start');
    return server;
  };
  return {
    srv,
    api: (m, p, b) => send(srv().url, m, p, b),
    admin: (m, p, b) => send(srv().adminUrl, m, p, b),
  };
}

describe('console: the admin port', () => {
  const { srv, admin } = servedWorld();

  it('GET / serves the operator console: HTML with the world name and the world port number', async () => {
    const r = await admin('GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.type, 'text/html; charset=utf-8');
    assert.equal(r.text.startsWith('<!DOCTYPE html>'), true);
    assert.equal(r.text.includes('minimal'), true);
    assert.equal(r.text.includes(`world port ${srv().port}`), true);
  });

  it('the page is fully offline: no absolute URL anywhere in the document', async () => {
    const r = await admin('GET', '/');
    assert.equal(r.text.includes('http://'), false);
    assert.equal(r.text.includes('https://'), false);
  });

  it('GET /_world/openapi deep-equals GET /openapi.json on the world port', async () => {
    const mirror = await admin('GET', '/_world/openapi');
    assert.equal(mirror.status, 200);
    assert.equal(mirror.type, 'application/json; charset=utf-8');
    const worldDoc = await send(srv().url, 'GET', '/openapi.json');
    assert.equal(worldDoc.status, 200);
    assert.deepEqual(mirror.body, worldDoc.body);
  });

  it('an unknown admin path names the admin routes, the openapi mirror among them', async () => {
    const r = await admin('GET', '/_world/nope');
    assert.equal(r.status, 404);
    assert.deepEqual(r.body, {
      error: {
        code: 'route.not_found',
        message: 'No admin route GET /_world/nope. Admin routes: GET /_world/state, POST /_world/reset, GET /_world/log, GET /_world/openapi, POST /_world/clock, POST /_world/grade/<task>',
      },
    });
  });

  it('the console route is not a world call: state and log stay untouched by GET /', async () => {
    await admin('POST', '/_world/reset');
    const before = (await admin('GET', '/_world/state')).body;
    await admin('GET', '/');
    await admin('GET', '/_world/openapi');
    assert.deepEqual((await admin('GET', '/_world/state')).body, before);
    assert.deepEqual((await admin('GET', '/_world/log')).body, { calls: [] });
  });
});

describe('console: the world port stays unchanged', () => {
  const { api } = servedWorld();

  it('GET / and every /_world path answer 404 in the world envelope', async () => {
    const cases = [
      ['GET', '/'],
      ['GET', '/_world'],
      ['GET', '/_world/state'],
      ['GET', '/_world/openapi'],
      ['POST', '/_world/reset'],
    ] as const;
    for (const [method, p] of cases) {
      const r = await api(method, p);
      assert.equal(r.status, 404, `${method} ${p}`);
      assert.equal((r.body as { error: { code: string } }).error.code, 'route.not_found');
      assert.equal(r.type, 'application/json; charset=utf-8');
    }
  });
});

describe('console: private task material', () => {
  /** A comment right after the first arrow, so the snippet stays one function expression with the same behavior. */
  const comment = (canary: string, source: string): string => {
    assert.equal(source.includes('=>'), true, 'snippet has no arrow');
    return source.replace('=>', `=> /* ${canary} */`);
  };

  /** The world with a canary in every grader, solution, decoy script and decoy why, still passing check. */
  function canaryWorld(base: CheckedWorld): { world: CheckedWorld; canaries: string[] } {
    const canaries: string[] = [];
    const mark = (): string => {
      const text = `PRIVATE_CANARY_CONSOLE_${canaries.length}`;
      canaries.push(text);
      return text;
    };
    const tasks = Object.fromEntries(Object.entries(base.tasks).map(([id, t]) => [id, {
      ...t,
      grader: t.grader === undefined ? t.grader : comment(mark(), t.grader),
      solution: t.solution === undefined ? t.solution : comment(mark(), t.solution),
      decoys: t.decoys.map((d) => ({ script: comment(mark(), d.script), why: `${mark()}: ${d.why}` })),
    }]));
    const edited = applyEdit(base, { note: 'Mark private task sources without changing behavior', upsert: { tasks } });
    if (!edited.ok) assert.fail(JSON.stringify(edited.error));
    const rechecked = checkWorld(edited.value.world);
    if (!rechecked.ok) assert.fail(JSON.stringify(rechecked.issues));
    return { world: rechecked.world, canaries };
  }

  it('no canary reaches the console page or the admin OpenAPI body', async () => {
    const { world, canaries } = canaryWorld(checked(minimalWorld()));
    const server = await serve(world, { port: 0 });
    try {
      // Positive control: every canary is in the checked world's private task sources.
      const privateText = JSON.stringify(world.tasks);
      for (const c of canaries) assert.equal(privateText.includes(c), true, `canary ${c} missing`);
      const page = await send(server.adminUrl, 'GET', '/');
      assert.equal(page.status, 200);
      const openapi = await send(server.adminUrl, 'GET', '/_world/openapi');
      assert.equal(openapi.status, 200);
      const adminText = `${page.text}\n${openapi.text}`;
      for (const c of canaries) assert.equal(adminText.includes(c), false, `canary ${c} leaked`);
    } finally {
      await server.close();
    }
  });
});
