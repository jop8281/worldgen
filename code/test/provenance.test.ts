import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { canonicalWorld, contentDigest, emptyWorld, loadWorld, taskIdOf, worldIdOf, worldSchema, type Task, type World } from '#engine';

const HELPDESK = fileURLToPath(new URL('../../prod/worlds/helpdesk', import.meta.url));

async function helpdesk(): Promise<World> {
  const loaded = await loadWorld(HELPDESK);
  if (!loaded.ok) assert.fail('the helpdesk world did not load');
  return worldSchema.parse(loaded.value);
}

describe('content ids (YOS-83)', () => {
  it('canonicalWorld of a tiny world is sorted JSON with entities, routes and actions as [name, item] pairs', () => {
    assert.equal(
      canonicalWorld(emptyWorld('tiny', 'hand')),
      '{"actions":[],"entities":[],"fixtures":{},"format":1,"jobs":{},"meta":{"api":{"error":{"error":{"code":"$code","message":"$message"}},"list":{"cursorKey":"next_cursor","cursorParam":"cursor","dataKey":"data","endingBeforeParam":"ending_before","hasMoreKey":"has_more","limitParam":"limit","mode":"cursor","startingAfterParam":"starting_after"}},"clock":{"start":"2026-01-05T09:00:00.000Z","tick":"0s"},"description":"","name":"tiny","resembles":"","seed":0,"source":"hand"},"routes":[],"seed":{},"tasks":{},"tests":{}}',
    );
  });

  it('worldIdOf is sha256 of the canonical text, as shasum -a 256 computes it', () => {
    assert.equal(worldIdOf(emptyWorld('tiny', 'hand')), 'wid_925f362c1da1fd26667679e8d6024197344e626694c1771c302a907f9c035b4b');
  });

  it('a meta.api.list default written out gives the same WID as leaving it out', () => {
    const tiny = emptyWorld('tiny', 'hand');
    const explicit = worldSchema.parse({ ...tiny, meta: { ...tiny.meta, api: { list: { mode: 'cursor', hasMoreKey: 'has_more' } } } });
    assert.equal(worldIdOf(explicit), 'wid_925f362c1da1fd26667679e8d6024197344e626694c1771c302a907f9c035b4b');
    const stripe = worldSchema.parse({ ...tiny, meta: { ...tiny.meta, api: { list: { mode: 'stripe' } } } });
    assert.notEqual(worldIdOf(stripe), 'wid_925f362c1da1fd26667679e8d6024197344e626694c1771c302a907f9c035b4b');
  });

  it('routes hash in declaration order with their own keys sorted', () => {
    const TWO_ROUTES: World = {
      ...emptyWorld('tiny', 'hand'),
      routes: {
        get_x: { op: 'get', entity: 'x', method: 'GET', path: '/x/{id}' },
        delete_x: { op: 'delete', entity: 'x', method: 'DELETE', path: '/x/{id}' },
      },
    };
    assert.equal(worldIdOf(TWO_ROUTES), 'wid_feb77909fddef9cee5294782ea986bd16c66d08bdcbde296aa5427d1e3733593');
  });

  it('taskIdOf is sha256 of the canonical task definition, without its name', () => {
    const TASK: Task = { difficulty: 'easy', instruction: 'Resolve the ticket about the password reset.', grader: '(ctx) => 1', solution: '(ctx) => {}', decoys: [], alternatives: [] };
    assert.equal(taskIdOf(TASK), 'tid_076ba8e5c9e603595d69a6017c750ff10ba388edacdb8f93b4bb6e281ce98421');
  });

  it('contentDigest sorts keys at every depth and keeps array order', () => {
    assert.equal(contentDigest({ b: 1, a: [1, 'x', null], c: undefined }), '26417a223ab477f8e008da7934835a26a7fa2af33015bc021931654d2e59061a');
    assert.equal(
      contentDigest({ summary: 'A helpdesk where overdue tickets escalate', observations: [], kind: 'description', apiShape: null, fixtures: {} }),
      'e60aa60a53b4ae7478832876fcd9d57d2bd06e9216e31bc60a46a5f752c45548',
    );
  });

  it('the same helpdesk world gives the same WID from JSON text and with its keys reordered', async () => {
    const w = await helpdesk();
    assert.match(worldIdOf(w), /^wid_[0-9a-f]{64}$/);
    assert.equal(worldIdOf(worldSchema.parse(YAML.parse(JSON.stringify(w)))), worldIdOf(w));
    const reordered = {
      tasks: w.tasks, tests: w.tests, seed: w.seed, fixtures: w.fixtures, jobs: w.jobs, actions: w.actions, routes: w.routes, entities: w.entities,
      meta: { ...Object.fromEntries(Object.entries(w.meta).reverse()), clock: { tick: w.meta.clock.tick, start: w.meta.clock.start } },
      format: w.format,
    };
    assert.equal(worldIdOf(worldSchema.parse(reordered)), worldIdOf(w));
  });

  it('route declaration order changes the WID; job order does not', async () => {
    const w = await helpdesk();
    assert.notEqual(worldIdOf({ ...w, routes: Object.fromEntries(Object.entries(w.routes).reverse()) }), worldIdOf(w));
    assert.equal(Object.keys(w.jobs).length, 3);
    assert.equal(worldIdOf({ ...w, jobs: Object.fromEntries(Object.entries(w.jobs).reverse()) }), worldIdOf(w));
  });

  it('field declaration order and action input order change the WID', async () => {
    const w = await helpdesk();
    const customer = w.entities['customer']!;
    assert.deepEqual(Object.keys(customer.fields), ['name', 'tier', 'email']);
    const reordered = { ...w, entities: { ...w.entities, customer: { ...customer, fields: Object.fromEntries(Object.entries(customer.fields).reverse()) } } };
    assert.notEqual(worldIdOf(reordered), worldIdOf(w));
    const [an, action] = Object.entries(w.actions)[0]!;
    const [first, def] = Object.entries(action.input)[0]!;
    const withTwo = (order: string[]) => ({ ...w, actions: { ...w.actions, [an]: { ...action, input: Object.fromEntries(order.map((k) => [k, def])) } } });
    assert.notEqual(worldIdOf(withTwo([first, 'zz_extra'])), worldIdOf(withTwo(['zz_extra', first])));
  });

  it("changing one task changes the WID and that task's TID only", async () => {
    const w = await helpdesk();
    const [name, t] = Object.entries(w.tasks)[0] ?? assert.fail('no tasks');
    const changed: World = { ...w, tasks: { ...w.tasks, [name]: { ...t, instruction: `${t.instruction} Do it today.` } } };
    assert.notEqual(worldIdOf(changed), worldIdOf(w));
    assert.notEqual(taskIdOf(changed.tasks[name] ?? assert.fail('gone')), taskIdOf(t));
    for (const [k, other] of Object.entries(w.tasks)) {
      if (k !== name) assert.equal(taskIdOf(changed.tasks[k] ?? assert.fail('gone')), taskIdOf(other));
    }
  });
});
