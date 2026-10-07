/**
 * A check run inside withDeadline stops when the instant passes, even while a snippet keeps
 * calling ctx often enough that neither the no-call guard nor the call quota ever trips.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DeadlineExpired, checkWorld, withDeadline } from '#engine';
import { minimalWorld } from './helpers/world.ts';

/** About 0.5 s of CPU between ctx calls, 20 times: far under guardMs per gap, about 10 s in all. */
const SPIN20 = `(ctx) => { let x = 0; for (let k = 0; k < 20; k++) { for (let i = 0; i < 3e8; i++) x += i; ctx.rng(); } return [{ name: 'Acme', tier: 'pro' }]; }`;

describe('withDeadline', () => {
  it('cuts a snippet that spins between ctx calls at the instant', () => {
    const w = minimalWorld({ seed: { customer: SPIN20 } });
    const t0 = performance.now();
    assert.throws(() => withDeadline(t0 + 500, () => checkWorld(w)), (e: unknown) => e instanceof DeadlineExpired && e.name === 'DeadlineExpired');
    assert.equal(performance.now() - t0 < 2_500, true);
  });

  it('returns the same report as an unscoped check when the instant does not pass', () => {
    const g = minimalWorld();
    assert.deepEqual(withDeadline(performance.now() + 600_000, () => checkWorld(g)), checkWorld(g));
    assert.equal(checkWorld(g).ok, true);
  });

  it('throws at once when the instant has already passed', () => {
    assert.throws(() => withDeadline(performance.now() - 1, () => checkWorld(minimalWorld())), DeadlineExpired);
  });

  it('leaves the host working and no deadline behind after an abort', () => {
    assert.equal(checkWorld(minimalWorld()).ok, true);
    assert.doesNotThrow(() => checkWorld(minimalWorld()));
  });
});
