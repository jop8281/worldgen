/**
 * gen-clinic-appointments starts at 2026-10-06T09:00Z, the date its plan describes. The seed is relative to the
 * clock, and the 30-minute check-in window around "now" must hold slots, so 08:00 (when the first slots are at
 * 09:00) would seed no checked_in appointment at all.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadWorld } from '#engine';
import type { World } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { seedState, type State } from '../src/engine/store.ts';
import { parsePlanYaml } from '../src/worldgen/plan.ts';

const DIR = path.resolve(import.meta.dirname, '../../prod/worlds/gen-clinic-appointments');
const NEW_CLOCK = '2026-10-06T09:00:00.000Z';
const OLD_CLOCK = '2026-01-05T09:00:00.000Z';
const loaded = await loadWorld(DIR);
if (!loaded.ok) throw new Error('gen-clinic-appointments does not load');
const base = loaded.value as World;
const host = createVmHost();

function seededAt(start: string): State {
  const world = { ...base, meta: { ...base.meta, clock: { ...base.meta.clock, start } } };
  const r = seedState(world, host);
  if (!r.ok) throw new Error(`${r.issue.code}: ${r.issue.found}`);
  return r.state;
}

const counts = (state: State): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const a of state.tables['appointment']!.values()) out[String(a['status'])] = (out[String(a['status'])] ?? 0) + 1;
  return out;
};

describe('gen-clinic-appointments clock', () => {
  it('is 2026-10-06T09:00Z in the world and in plan.yaml', async () => {
    assert.equal(base.meta.clock.start, NEW_CLOCK);
    const plan = parsePlanYaml(await readFile(path.join(DIR, 'plan.yaml'), 'utf8'));
    assert.equal(plan?.clock.start, NEW_CLOCK);
    assert.equal(plan?.seed.mix.startsWith('Clock starts 2026-10-06T09:00Z'), true);
  });

  it('seeds the nine checked_in appointments, and none at 08:00 where the window is empty', () => {
    assert.deepEqual(counts(seededAt(NEW_CLOCK)), { no_show: 26, completed: 34, booked: 73, checked_in: 9, cancelled: 25 });
    assert.equal(counts(seededAt('2026-10-06T08:00:00.000Z'))['checked_in'], undefined);
  });

  it('uses the actual weekdays at both the current Tuesday clock and the former Monday clock', () => {
    for (const clock of [NEW_CLOCK, OLD_CLOCK]) {
      const state = seededAt(clock);
      assert.equal(counts(state)['checked_in'], 9);
      for (const slot of state.tables['slot']!.values()) {
        const start = slot['starts_at'];
        const end = slot['ends_at'];
        assert.ok(typeof start === 'string' && typeof end === 'string');
        const weekday = new Date(start).getUTCDay();
        assert.ok(weekday >= 1 && weekday <= 5, `${clock}: ${slot['id']}`);
        assert.ok(start.slice(11, 16) >= '09:00' && end.slice(11, 16) <= '17:00', `${clock}: ${slot['id']}`);
        assert.equal(Date.parse(end) - Date.parse(start), 1_800_000);
      }
    }
  });
});
