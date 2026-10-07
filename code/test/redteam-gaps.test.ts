/**
 * Red-team: gaps found by the coverage matrix in test/redteam/README.md.
 *
 * - G-00: the mutation table has a firm row (no todo, expected present) for every
 *   world-triggerable code, except the codes listed in KNOWN_GAPS with the RT that blocks them.
 * - G-06, G-18, G-20: host entropy never reaches engine output. The host's `Math.random` and
 *   `Date` are replaced with fixed values (node:test mocks), and the check report and a fixed
 *   runtime script must give deep-equal results under every host setting. An engine that
 *   draws cursors, ids, hashes or timestamps from the host fails here even when one process
 *   happens to agree with itself.
 *
 * Expected values are literals or invariance comparisons between host settings.
 */
import { describe, it, type TestContext, type TestOptions } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorld, ISSUES, type ApiRequest, type IssueCode } from '#engine';
import { baseOk, cap, freshRuntime, opts } from './redteam/harness.ts';
import { MUTATIONS, NO_MUTATION_ROW } from './redteam/mutations.ts';
import { FACTS, TASK_IDS, baseWorld } from './redteam/world.ts';

// ---------------------------------------------------------------------------------------
// G-00: firm coverage of every world-triggerable code

/** Codes with no firm mutation row, and the ambiguity that keeps their only row a todo. */
const KNOWN_GAPS: Readonly<Partial<Record<IssueCode, `RT-${string}`>>> = {
};

describe('coverage', () => {
  it('G-00 every world-triggerable code has a firm mutation row, apart from the known gaps', () => {
    const firm = new Set<IssueCode>();
    for (const m of MUTATIONS) if (!m.todo && m.expect !== 'absent') firm.add(m.code);
    const lacking = (Object.keys(ISSUES) as IssueCode[]).filter((c) => !firm.has(c) && !NO_MUTATION_ROW.includes(c));
    assert.deepEqual(lacking.sort(), Object.keys(KNOWN_GAPS).sort(), 'update KNOWN_GAPS and the README coverage matrix');
    for (const code of Object.keys(KNOWN_GAPS) as IssueCode[]) {
      assert.ok(MUTATIONS.some((m) => m.code === code && m.todo === KNOWN_GAPS[code]), `${code} has no todo row under ${KNOWN_GAPS[code]}`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// G-06, G-18, G-20: host entropy

type Host = { readonly label: string; readonly random: number; readonly now: number };

/** Fixed host settings far apart in time and at both ends of Math.random. */
const HOSTS: readonly Host[] = [
  { label: 'random 0, year 2000', random: 0, now: Date.UTC(2000, 0, 1) },
  { label: 'random 0.999999, year 2100', random: 0.999999, now: Date.UTC(2100, 6, 15, 13, 37, 42, 123) },
  { label: 'random 0.5, epoch', random: 0.5, now: 0 },
];

/** Run fn with the host's Math.random and Date replaced, restoring both afterwards. */
function underHost<T>(t: TestContext, h: Host, fn: () => T): T {
  const random = t.mock.method(Math, 'random', () => h.random);
  t.mock.timers.enable({ apis: ['Date'], now: h.now });
  try {
    return fn();
  } finally {
    t.mock.timers.reset();
    random.mock.restore();
  }
}

const BASE_OK: TestOptions = baseOk();
const RUNTIME: TestOptions = opts(
  BASE_OK,
  cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.log', 'runtime.advance', 'runtime.grade', 'runtime.reset'),
);

function req(method: ApiRequest['method'], path: string, query: Readonly<Record<string, string>> = {}, body: unknown = null): ApiRequest {
  return { method, path, query, body } as ApiRequest;
}

/** A fixed script over the base world. Every output that could carry host entropy is kept. */
function script(): unknown {
  // freshRuntime() checks nothing new: the checked world comes from the import-time probe.
  const rt = freshRuntime();
  const out: Record<string, unknown> = { seed: structuredClone(rt.dump()) };
  // Walk every page of /tickets, so cursors are part of the compared output.
  const pages: unknown[] = [];
  let cursor: unknown = undefined;
  for (let i = 0; i < 10; i++) {
    const res = rt.call(req('GET', '/tickets', cursor == null ? {} : { cursor: String(cursor) }));
    pages.push(structuredClone(res));
    const body = res.body as { next_cursor?: unknown } | null;
    cursor = res.status === 200 && body && typeof body === 'object' ? body.next_cursor : null;
    if (cursor == null) break;
  }
  out['pages'] = pages;
  out['patch'] = structuredClone(rt.call(req('PATCH', '/tickets/tkt_0001', {}, { status: 'pending' })));
  out['create'] = structuredClone(rt.call(req('POST', '/tickets', {}, { subject: 'Entropy probe', status: 'open', priority: 'low', ref_code: 'HD-2002' })));
  out['refused'] = structuredClone(rt.call(req('PATCH', '/tickets/tkt_0002', {}, { status: 'closed' })));
  out['advance'] = structuredClone(rt.advance('1h'));
  out['grades'] = TASK_IDS.map((id) => rt.grade(id));
  out['dump'] = structuredClone(rt.dump());
  out['log'] = structuredClone(rt.log());
  rt.reset();
  out['reset'] = structuredClone(rt.dump());
  return out;
}

describe('host entropy', () => {
  it('G-06 G-20 the check report is the same under every host Math.random and Date', cap('checkWorld'), (t) => {
    const reports = HOSTS.map((h) => underHost(t, h, () => checkWorld(baseWorld())));
    const first = reports[0];
    for (let i = 1; i < reports.length; i++) {
      assert.deepEqual(reports[i], first, `report under "${HOSTS[i]?.label}" differs from "${HOSTS[0]?.label}"`);
    }
  });

  it('G-06 G-20 a broken world reports the same issues under every host Math.random and Date', cap('checkWorld'), (t) => {
    const broken = (): unknown => {
      const w = baseWorld();
      w.meta.clock.start = 'yesterday';
      return w;
    };
    const reports = HOSTS.map((h) => underHost(t, h, () => checkWorld(broken())));
    assert.equal(reports[0]?.ok, false, 'a world with clock.start "yesterday" checked ok');
    for (let i = 1; i < reports.length; i++) assert.deepEqual(reports[i], reports[0], `under "${HOSTS[i]?.label}"`);
  });

  it('G-18 G-20 runtime responses, cursors, dumps, logs, jobs and grades ignore host Math.random and Date', RUNTIME, (t) => {
    const runs = HOSTS.map((h) => underHost(t, h, script) as Record<string, unknown>);
    const a = runs[0] ?? {};
    // Non-vacuity: hand-derived outcomes, so a runtime that fails every call cannot pass.
    assert.equal((a['seed'] as { now?: unknown } | undefined)?.now, FACTS.clockStart, 'a fresh dump does not start at meta.clock.start');
    assert.equal((a['patch'] as { status?: unknown } | undefined)?.status, 200, `open -> pending gave ${JSON.stringify(a['patch'])}`);
    const created = a['create'] as { status?: number; body?: { id?: unknown } } | undefined;
    assert.ok(created && typeof created.status === 'number' && created.status >= 200 && created.status < 300, `create gave ${JSON.stringify(created)}`);
    assert.equal(created.body?.id, FACTS.nextTicketId);
    const refused = a['refused'] as { status?: number } | undefined;
    assert.ok(refused && typeof refused.status === 'number' && refused.status >= 400, `open -> closed was accepted: ${JSON.stringify(refused)}`);
    assert.deepEqual((a['advance'] as { jobsFired?: unknown } | undefined)?.jobsFired, [...FACTS.jobsAfter1h]);
    assert.equal((a['pages'] as unknown[]).length, FACTS.ticketPages.length, 'the cursor walk did not take FACTS.ticketPages.length pages');
    assert.deepEqual(a['reset'], a['seed'], 'reset did not restore the seed dump');
    for (let i = 1; i < runs.length; i++) {
      const b = runs[i] ?? {};
      for (const key of Object.keys(a)) {
        assert.deepEqual(b[key], a[key], `${key} under "${HOSTS[i]?.label}" differs from "${HOSTS[0]?.label}"`);
      }
    }
  });
});
