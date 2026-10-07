/**
 * Black-box proof that the WORLD port never shows grader source, reference solutions or decoys
 * (scripts and "why" text). Every world under prod/worlds/ gets a canary in each private source and
 * a probe matrix of request classes. Only the world port is probed; the admin port is used by the
 * harness (reset, clock, grade) and never by a probe. This is routing and serialization privacy,
 * not process isolation (research/architecture.md, "Private task boundary").
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEdit, checkWorld, createRuntime, loadWorld, openApiOf, serve, type CheckedWorld, type WorldServer } from '#engine';
import { minimalWorld } from './helpers/world.ts';

const WORLDS_DIR = fileURLToPath(new URL('../../prod/worlds', import.meta.url));

// ---- Data shape: the canary set and the probe matrix -------------------------------------------

type PrivateKind = 'GRADER' | 'SOLUTION' | 'DECOY_SCRIPT' | 'DECOY_WHY';
type Canary = { readonly text: string; readonly task: string; readonly kind: PrivateKind };
/** One request class. `probes` lists the requests of that class for one world. */
type Probe = { readonly method: string; readonly path: string; readonly body?: string };
type Op = { readonly method: string; readonly path: string; readonly template: string; readonly schema: Json | undefined };
type Json = { [k: string]: unknown };
type Seen = { readonly status: string; readonly headers: string; readonly body: string };
type Fixture = { readonly ids: readonly string[]; readonly byEntity: Readonly<Record<string, string>>; readonly ops: readonly Op[]; readonly tasks: readonly string[]; readonly components: Json };

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const BAD_BODY = '{oops';

// ---- Scanner -----------------------------------------------------------------------------------

/** The forbidden strings found in one response: status line, every header and the whole body. */
function leaks(seen: Seen, forbidden: readonly string[]): string[] {
  const text = `${seen.status}\n${seen.headers}\n${seen.body}`;
  return forbidden.filter((f) => text.includes(f));
}

// ---- Canaries and fragments --------------------------------------------------------------------

/** A comment right after the first arrow, so the snippet stays one function expression with the same behavior. */
function comment(canary: string, source: string): string {
  assert.equal(source.includes('=>'), true, 'snippet has no arrow');
  return source.replace('=>', `=> /* ${canary} */`);
}

function privateSources(world: CheckedWorld): string[] {
  return Object.values(world.tasks)
    .flatMap((t) => [t.grader, t.solution, ...t.decoys.flatMap((d) => [d.script, d.why])])
    .filter((s): s is string => s !== undefined);
}

/** What the world port may return besides the OpenAPI body: task instructions and the seed rows. The OpenAPI body is computed from a task-less copy so a leak in it cannot excuse itself. */
function servedExtras(world: CheckedWorld): string {
  const instructions = Object.values(world.tasks).map((t) => t.instruction);
  return [...instructions, JSON.stringify(createRuntime(world).dump())].join('\n');
}

const WINDOW = 40;
const STEP = 20;

/**
 * Fixed-width windows of every private source, at every step, so a leak of any span (head, middle or
 * tail of a one-line snippet) contains one. Windows holding characters that JSON escapes are skipped,
 * and so is any window already in `served` (text the agent legitimately sees).
 */
function fragmentsOf(sources: readonly string[], served: string): string[] {
  const found = new Set<string>();
  for (const src of sources) {
    const last = Math.max(src.length - WINDOW, 0);
    const starts = new Set<number>([last]);
    for (let i = 0; i < last; i += STEP) starts.add(i);
    for (const i of starts) {
      const w = src.slice(i, i + WINDOW);
      if (w.trim().length >= 24 && !/["\\\u0000-\u001f]/.test(w) && !served.includes(w)) found.add(w);
    }
  }
  return [...found];
}

function canaryWorld(world: CheckedWorld, label: string): { world: CheckedWorld; canaries: Canary[] } {
  const canaries: Canary[] = [];
  const mark = (task: string, kind: PrivateKind): string => {
    const text = `PRIVATE_CANARY_${label}_${canaries.length}_${kind}`;
    canaries.push({ text, task, kind });
    return text;
  };
  const tasks = Object.fromEntries(Object.entries(world.tasks).map(([id, t]) => [id, {
    ...t,
    // The worlds here are the private forms: every task carries its grader and solution.
    grader: comment(mark(id, 'GRADER'), t.grader ?? assert.fail(`${id} carries no grader to canary`)),
    solution: comment(mark(id, 'SOLUTION'), t.solution ?? assert.fail(`${id} carries no solution to canary`)),
    decoys: t.decoys.map((d) => ({ script: comment(mark(id, 'DECOY_SCRIPT'), d.script), why: `${mark(id, 'DECOY_WHY')}: ${d.why}` })),
  }]));
  const edited = applyEdit(world, { note: 'Mark private task sources without changing behavior', upsert: { tasks } });
  if (!edited.ok) assert.fail(JSON.stringify(edited.error));
  const checked = checkWorld(edited.value.world);
  if (!checked.ok) assert.fail(JSON.stringify(checked.issues));
  return { world: checked.world, canaries };
}

// ---- Transport: raw node:http so paths such as //x and /a/../b reach the server unchanged ------

function send(base: string, p: Probe): Promise<Seen> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method: p.method, path: p.path, agent: false,
      headers: p.body === undefined ? {} : { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({
        status: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}`,
        headers: res.rawHeaders.join('\n'),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (e) => reject(new Error(`${p.method} ${p.path.slice(0, 80)} body=${p.body?.slice(0, 40)}: ${e.message}`)));
    if (p.body !== undefined) req.write(p.body);
    req.end();
  });
}

async function adminJson(server: WorldServer, method: string, path: string, body?: string): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${server.adminUrl}${path}`, { method, ...(body === undefined ? {} : { body }) });
  return { status: res.status, json: (await res.json()) as Json };
}

// ---- Request generation from the world's own OpenAPI document ------------------------------------

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function resolveRef(schema: unknown, components: Json): Json | undefined {
  if (!isObj(schema)) return undefined;
  const ref = schema['$ref'];
  if (typeof ref === 'string') return resolveRef((components['schemas'] as Json)[ref.split('/').pop() ?? ''], components);
  return schema;
}

function sample(schema: unknown, components: Json, depth = 0): unknown {
  const s = resolveRef(schema, components);
  if (s === undefined || depth > 3) return 'x';
  if (Array.isArray(s['enum'])) return s['enum'][0];
  switch (s['type']) {
    case 'integer': case 'number': return 1;
    case 'boolean': return true;
    case 'array': return [];
    case 'object': {
      const props = isObj(s['properties']) ? s['properties'] : {};
      const required = Array.isArray(s['required']) ? s['required'] : [];
      return Object.fromEntries(Object.entries(props).filter(([k]) => required.includes(k)).map(([k, v]) => [k, sample(v, components, depth + 1)]));
    }
    case 'string': return s['format'] === 'date-time' ? '2026-01-01T00:00:00.000Z' : 'x';
    default: return 'x';
  }
}

/** Every property set to a value of the wrong type. */
function wrongTypes(schema: unknown, components: Json): unknown {
  const s = resolveRef(schema, components);
  const props = s !== undefined && isObj(s['properties']) ? Object.keys(s['properties']) : ['x'];
  return Object.fromEntries(props.map((k) => [k, { nested: [12345] }]));
}

function fixtureOf(world: CheckedWorld, openapi: Json): Fixture {
  const dump = createRuntime(world).dump();
  const ids: string[] = [];
  const byEntity: Record<string, string> = {};
  for (const [entity, rows] of Object.entries(dump.tables)) {
    for (const row of rows) {
      const id = (row as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      ids.push(id);
      byEntity[entity] ??= id;
    }
  }
  const ops: Op[] = [];
  for (const [path, item] of Object.entries(openapi['paths'] as Json)) {
    for (const [method, op] of Object.entries(item as Json)) {
      const body = isObj(op) && isObj(op['requestBody']) ? (op['requestBody']['content'] as Json)['application/json'] : undefined;
      ops.push({ method: method.toUpperCase(), path, template: path, schema: isObj(body) ? (body['schema'] as Json) : undefined });
    }
  }
  return { ids, byEntity, ops, tasks: Object.keys(world.tasks), components: openapi['components'] as Json };
}

/** Fills `{param}` with a seed id of the entity the path starts with, else any seed id, else `x`. */
function fill(fx: Fixture, template: string, unknown_: boolean): string {
  const first = template.split('/').filter((s) => s !== '')[0] ?? '';
  const guess = Object.keys(fx.byEntity).find((e) => first === e || first === `${e}s` || first.startsWith(e)) ;
  const id = unknown_ ? 'zzz_9999999' : (guess !== undefined ? fx.byEntity[guess] : undefined) ?? fx.ids[0] ?? 'x';
  return template.replace(/\{[^}]+\}/g, id ?? 'x');
}

// ---- The probe matrix: one entry per request class ----------------------------------------------

const CLASSES: Readonly<Record<string, (fx: Fixture) => Probe[]>> = {
  openapi: () => ['GET', 'HEAD', 'OPTIONS', 'POST'].map((method) => ({ method, path: '/openapi.json' }))
    .concat([{ method: 'GET', path: '/openapi.json/' }, { method: 'GET', path: '/openapi.json?x=1' }, { method: 'GET', path: '/openapi' }]),
  valid: (fx) => fx.ops.map((o) => ({ method: o.method, path: fill(fx, o.path, false), ...(o.schema === undefined ? {} : { body: JSON.stringify(sample(o.schema, fx.components)) }) })),
  'unknown-id': (fx) => fx.ops.map((o) => ({ method: o.method, path: fill(fx, o.path, true), ...(o.schema === undefined ? {} : { body: JSON.stringify(sample(o.schema, fx.components)) }) })),
  'malformed-json': (fx) => fx.ops.map((o) => ({ method: o.method, path: fill(fx, o.path, false), body: BAD_BODY })),
  'wrong-types': (fx) => fx.ops.flatMap((o) => ['{}', '[]', 'null', '"x"', JSON.stringify(wrongTypes(o.schema, fx.components))]
    .map((body) => ({ method: o.method, path: fill(fx, o.path, false), body }))),
  'unknown-path': () => ['/nope', '/a/b/c/d/e', '/' + 'a'.repeat(3000), '/', '/%zz', '/é', '/?q=1'].map((path) => ({ method: 'GET', path })),
  'wrong-method': (fx) => [...new Set(fx.ops.map((o) => o.path))].flatMap((path) => {
    const declared = fx.ops.filter((o) => o.path === path).map((o) => o.method);
    const missing = METHODS.filter((m) => !declared.includes(m)).slice(0, 2);
    return [...missing, 'BREW', 'TRACE'].map((method) => ({ method, path: fill(fx, path, false) }));
  }),
  'admin-paths': (fx) => {
    const base = ['/_world/state', '/_world/log', '/_world/reset', '/_world/clock', '/_world/grade', '/_world', '/_world/',
      '/%5Fworld/state', '/%5fworld/log', '/_world%2Fstate', '/_world%2fgrade/x', '/_world/../_world/state', '/x/../_world/state',
      '//_world/state', '/_world//state', '/_world/state/', '/./_world/state', '/_WORLD/state', '/admin', '/_admin/state'];
    const graded = fx.tasks.flatMap((t) => [`/_world/grade/${t}`, `/%5Fworld/grade/${t}`, `//_world/grade/${t}`]);
    return [...base, ...graded, '/_world/grade/unknown'].flatMap((path) => ['GET', 'POST', 'DELETE']
      .map((method) => ({ method, path, ...(method === 'POST' ? { body: '{"advance":"4h"}' } : {}) })));
  },
  'task-paths': (fx) => {
    const paths = ['/tasks', '/task', '/graders', '/solutions', '/decoys', '/world', '/world.yaml', '/plan.yaml', '/REPORT.md', '/meta', '/tests', '/_tasks', '/_private'];
    const perTask = fx.tasks.flatMap((t) => [`/tasks/${t}`, `/_tasks/${t}`, `/${t}`, `/tasks/${t}/grader`, `/tasks/${t}/solution`, `/tasks/${t}/decoys`, `/${t}/grade`]);
    return [...paths, ...perTask].flatMap((path) => ['GET', 'POST'].map((method) => ({ method, path, ...(method === 'POST' ? { body: '{}' } : {}) })));
  },
  'head-options': (fx) => ['/', ...new Set(fx.ops.map((o) => fill(fx, o.path, false)))].flatMap((path) => ['HEAD', 'OPTIONS'].map((method) => ({ method, path }))),
};

// ---- Tests --------------------------------------------------------------------------------------

describe('scanner self-check', () => {
  it('reports a canary hidden in the body, a header or the status line', () => {
    assert.deepEqual(leaks({ status: 'HTTP/1.1 200 OK', headers: 'x-a\nb', body: '{"note":"C1 here"}' }, ['C1', 'C2']), ['C1']);
    assert.deepEqual(leaks({ status: 'HTTP/1.1 200 OK', headers: 'x-leak\nC2', body: '{}' }, ['C1', 'C2']), ['C2']);
    assert.deepEqual(leaks({ status: 'HTTP/1.1 418 C1', headers: '', body: 'C2' }, ['C1', 'C2']), ['C1', 'C2']);
    assert.deepEqual(leaks({ status: 'HTTP/1.1 200 OK', headers: '', body: '{}' }, ['C1']), []);
  });
  it('finds fragments of unmodified private source in a copied world', () => {
    const world = checkWorld(minimalWorld());
    if (!world.ok) assert.fail(JSON.stringify(world.issues));
    const frags = fragmentsOf(privateSources(world.world), '');
    assert.equal(frags.length > 0, true);
    assert.equal(leaks({ status: '', headers: '', body: `echo ${frags[0]}` }, frags).length, 1);
  });
  it('reports a tail-only echo of a one-line grader', () => {
    const grader = `(ctx) => { ${'ctx.goal(0.5, "x", true); '.repeat(3)}const tailMarkerValue = ctx.score(); return tailMarkerValue; }`;
    const frags = fragmentsOf([grader], '');
    assert.equal(leaks({ status: '', headers: '', body: grader.slice(-45) }, frags).length > 0, true);
  });
});

const worldDirs = readdirSync(WORLDS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

it('covers at least the hand-built world', () => {
  assert.equal(worldDirs.includes('helpdesk'), true);
});

for (const [index, name] of worldDirs.entries()) {
  describe(`private boundary: ${name}`, () => {
    let server: WorldServer;
    let canaries: Canary[] = [];
    let forbidden: string[] = [];
    let fx: Fixture;
    let checked: CheckedWorld;
    const counts: Record<string, number> = {};

    before(async () => {
      const loaded = await loadWorld(`${WORLDS_DIR}/${name}`);
      if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
      const base = checkWorld(loaded.value);
      if (!base.ok) assert.fail(JSON.stringify(base.issues));
      const marked = canaryWorld(base.world, String(index));
      canaries = marked.canaries;
      checked = marked.world;
      server = await serve(checked, { port: 0 });
      const doc = JSON.parse((await send(server.url, { method: 'GET', path: '/openapi.json' })).body) as Json;
      forbidden = [...canaries.map((c) => c.text), ...fragmentsOf(privateSources(base.world), `${JSON.stringify(openApiOf({ ...base.world, tasks: {} }))}\n${servedExtras(base.world)}`)];
      fx = fixtureOf(checked, doc);
    });
    after(async () => {
      await server?.close();
      console.log(`probe counts ${name}: ${JSON.stringify(counts)}`);
    });

    it('positive control: every canary is in the checked world', () => {
      const tasks = Object.values(checked.tasks);
      assert.equal(tasks.length >= 3, true);
      const expected = tasks.length * 2 + tasks.reduce((n, t) => n + t.decoys.length * 2, 0);
      assert.equal(canaries.length, expected);
      const privateText = JSON.stringify(checked.tasks);
      for (const c of canaries) assert.equal(privateText.includes(c.text), true, `${c.kind} canary of ${c.task} missing`);
      assert.equal(canaries.filter((c) => c.kind === 'GRADER').length, tasks.length);
      assert.equal(fx.ops.length > 0, true);
    });

    it('positive control: private grading still works on the admin port', async () => {
      assert.equal((await adminJson(server, 'POST', '/_world/reset')).status, 200);
      for (const task of Object.keys(checked.tasks)) {
        const res = await adminJson(server, 'POST', `/_world/grade/${task}`);
        assert.equal(res.status, 200);
        assert.equal(res.json['score'], 0);
      }
      const unknown = await adminJson(server, 'POST', '/_world/grade/unknown');
      assert.equal(unknown.status, 404);
      assert.equal(JSON.stringify(unknown.json).includes(Object.keys(checked.tasks)[0] ?? 'none'), true);
    });

    for (const [cls, build] of Object.entries(CLASSES)) {
      it(`world port leaks nothing: ${cls}`, async () => {
        await adminJson(server, 'POST', '/_world/reset');
        const before = (await adminJson(server, 'GET', '/_world/state')).json;
        if (cls === 'admin-paths') assert.equal((await adminJson(server, 'POST', '/_world/clock', '{"advance":"1h"}')).status, 200);
        const baseline = (await adminJson(server, 'GET', '/_world/state')).json;
        const probes = build(fx);
        assert.equal(probes.length > 0, true);
        for (const p of probes) {
          const seen = await send(server.url, p);
          assert.deepEqual(leaks(seen, forbidden), [], `${p.method} ${p.path.slice(0, 80)} leaked`);
        }
        counts[cls] = probes.length;
        if (cls === 'admin-paths') {
          // Admin routes on the world port must do nothing: no reset, no clock move, no change.
          const after = (await adminJson(server, 'GET', '/_world/state')).json;
          assert.equal(after['now'], baseline['now']);
          assert.notEqual(after['now'], before['now']);
          assert.equal(after['hash'], baseline['hash']);
        }
      });
    }
  });
}

describe('handler ctx holds no task material', () => {
  it('a handler that hunts for tasks finds none', async () => {
    const marker = 'PRIVATE_CANARY_HANDLER_PROBE';
    const handler = `(ctx) => {
      const found = [];
      const seen = new Set();
      const walk = (v, path, depth) => {
        if (depth > 4 || v === null || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v)) return;
        seen.add(v);
        let names = [];
        try { names = Object.getOwnPropertyNames(v); } catch (e) {}
        for (const k of names) {
          if (/task|grader|solution|decoy/i.test(k)) found.push(path + '.' + k);
          let child;
          try { child = v[k]; } catch (e) { continue; }
          if (typeof child === 'string' && child.indexOf('${marker}') >= 0) found.push(path + '.' + k);
          walk(child, path + '.' + k, depth + 1);
        }
      };
      walk(ctx, 'ctx', 0);
      walk(globalThis, 'g', 0);
      let thisKeys = 'none';
      try { thisKeys = Object.getOwnPropertyNames((function () { return this; })() || {}).length > 0 ? 'some' : 'empty'; } catch (e) { thisKeys = 'throws'; }
      return { status: 200, body: { ctxKeys: Object.keys(ctx).sort(), found: found, thisKeys: thisKeys } };
    }`;
    const first = Object.keys(minimalWorld().tasks)[0] ?? '';
    const marked = comment(marker, minimalWorld().tasks[first]?.grader ?? '');
    const probe = checkWorld(minimalWorld({ actions: { peek: { method: 'POST', path: '/peek', handler } }, tasks: { [first]: { grader: marked } } }));
    if (!probe.ok) assert.fail(JSON.stringify(probe.issues));
    const server = await serve(probe.world, { port: 0 });
    try {
      const seen = await send(server.url, { method: 'POST', path: '/peek', body: '{}' });
      assert.equal(seen.status.includes(' 200 '), true, seen.body);
      assert.equal(seen.body.includes(marker), false);
      assert.deepEqual(JSON.parse(seen.body), { ctxKeys: ['body', 'db', 'fail', 'now', 'params', 'query', 'time'], found: [], thisKeys: JSON.parse(seen.body).thisKeys });
    } finally {
      await server.close();
    }
  });
});
