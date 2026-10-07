import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEdit, checkWorld, loadWorld, serve, type WorldServer } from '#engine';

const HELPDESK = fileURLToPath(new URL('../../prod/worlds/helpdesk', import.meta.url));
const TASK = 'assign_newest_acme_ticket';

describe('public HTTP task-source privacy (not process isolation)', () => {
  let server: WorldServer;
  const canaries: string[] = [];

  function mark(kind: string, source: string): string {
    const canary = `PRIVATE_TASK_SOURCE_${kind}_${canaries.length}`;
    canaries.push(canary);
    if (kind === 'DECOY_WHY') return `${canary}: ${source}`;
    assert.equal(source.startsWith('(ctx) => {'), true);
    return source.replace('(ctx) => {', `(ctx) => { /* ${canary} */`);
  }

  function privateFree(text: string): void {
    for (const canary of canaries) assert.equal(text.includes(canary), false, `public output contains ${canary}`);
  }

  async function request(base: string, method: string, path: string, body?: string) {
    const response = await fetch(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'content-type': 'application/json' } }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as unknown };
  }

  before(async () => {
    const loaded = await loadWorld(HELPDESK);
    if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
    const base = checkWorld(loaded.value);
    if (!base.ok) assert.fail(JSON.stringify(base.issues));
    const edited = applyEdit(base.world, {
      note: 'Mark private task sources without changing their behavior',
      upsert: { tasks: Object.fromEntries(Object.entries(base.world.tasks).map(([id, task]) => [id, {
        ...task,
        // The worlds here are the private forms: every task carries its grader and solution.
        grader: mark('GRADER', task.grader ?? assert.fail(`${id} carries no grader to canary`)),
        solution: mark('SOLUTION', task.solution ?? assert.fail(`${id} carries no solution to canary`)),
        decoys: task.decoys.map((decoy) => ({
          why: mark('DECOY_WHY', decoy.why), script: mark('DECOY_SCRIPT', decoy.script),
        })),
      }])) },
    });
    if (!edited.ok) assert.fail(JSON.stringify(edited.error));
    const checked = checkWorld(edited.value.world);
    if (!checked.ok) assert.fail(JSON.stringify(checked.issues));
    // Positive control: every forbidden marker is really loaded, including each decoy.
    assert.equal(canaries.length > 6, true);
    const privateTasks = JSON.stringify(checked.world.tasks);
    for (const canary of canaries) assert.equal(privateTasks.includes(canary), true);
    server = await serve(checked.world, { port: 0 });
  });
  after(async () => { await server?.close(); });
  beforeEach(async () => {
    assert.equal((await request(server.adminUrl, 'POST', '/_world/reset')).status, 200);
  });

  it('R3 serves useful OpenAPI without grader, solution or decoy source', async () => {
    const result = await request(server.url, 'GET', '/openapi.json');
    assert.equal(result.status, 200);
    const doc = result.body as { openapi: string; paths: Record<string, unknown> };
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(Object.hasOwn(doc.paths, '/tickets/{id}/assign'), true);
    assert.equal(Object.keys(doc.paths).some((path) => path.startsWith('/_world')), false);
    assert.equal(result.text.includes(TASK), false);
    privateFree(result.text);
  });

  it('R3 keeps private source out of successful reads and workflow actions', async () => {
    const read = await request(server.url, 'GET', '/tickets/tkt_0004');
    assert.equal(read.status, 200);
    assert.equal((read.body as { id: string }).id, 'tkt_0004');
    privateFree(read.text);
    const action = await request(server.url, 'POST', '/tickets/tkt_0004/escalate', '{"reason":"Drivers cannot start routes"}');
    assert.equal(action.status, 200);
    privateFree(action.text);
  });

  it('R3 keeps private source out of parser, routing and action errors', async () => {
    const cases = [
      ['POST', '/customers', '{oops}', 400, 'body.invalid'],
      ['OPTIONS', '/tickets', undefined, 405, 'method.not_allowed'],
      ['GET', '/tickets/tkt_9999', undefined, 404, 'row.not_found'],
      ['POST', '/tickets/tkt_9999/escalate', '{"reason":"Missing ticket"}', 404, 'not_found'],
    ] as const;
    for (const [method, path, body, status, code] of cases) {
      const result = await request(server.url, method, path, body);
      assert.equal(result.status, status);
      assert.equal((result.body as { error: { code: string } }).error.code, code);
      privateFree(result.text);
    }
  });

  it('R4 public admin probes cannot grade, enumerate tasks or mutate the episode', async () => {
    // A reset bug must be observable: start with changed state and a nonempty call log.
    const mutation = await request(server.url, 'POST', '/tickets/tkt_0004/escalate', '{"reason":"Retain this episode"}');
    assert.equal(mutation.status, 200);
    const before = await request(server.adminUrl, 'GET', '/_world/state');
    const beforeLog = (await request(server.adminUrl, 'GET', '/_world/log')).body as { calls: unknown[] };
    assert.equal(beforeLog.calls.length, 1);
    const probes = [
      ['GET', '/_world/state'], ['GET', '/_world/log'], ['POST', '/_world/reset'],
      ['POST', '/_world/clock'], ['POST', `/_world/grade/${TASK}`], ['POST', '/_world/grade/unknown'],
      ['GET', '/%5fworld/state'], ['POST', '/%5Fworld/grade/unknown'],
      ['POST', '/_world%2fgrade/unknown'], ['POST', '//_world/grade/unknown'],
    ] as const;
    for (const [method, path] of probes) {
      const result = await request(server.url, method, path, method === 'POST' ? '{"advance":"4h"}' : undefined);
      assert.equal(result.status, 404);
      assert.equal((result.body as { error: { code: string } }).error.code, 'route.not_found');
      assert.equal(result.text.includes('Known tasks:'), false);
      privateFree(result.text);
    }
    assert.deepEqual((await request(server.adminUrl, 'GET', '/_world/state')).body, before.body);
    // The encoded slash follows ordinary routing, so it may be logged as a refused call.
    const log = (await request(server.adminUrl, 'GET', '/_world/log')).body as { calls: { res: { status: number }; writes: unknown[] }[] };
    assert.deepEqual(log.calls.slice(0, beforeLog.calls.length), beforeLog.calls);
    for (const call of log.calls.slice(beforeLog.calls.length)) {
      assert.equal(call.res.status, 404);
      assert.deepEqual(call.writes, []);
    }
    const grade = await request(server.adminUrl, 'POST', `/_world/grade/${TASK}`);
    assert.equal(grade.status, 200);
    assert.equal((grade.body as { score: number }).score, 0);
    const unknown = await request(server.adminUrl, 'POST', '/_world/grade/unknown');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.text.includes(`Known tasks: ${TASK}`), true);
  });
});
