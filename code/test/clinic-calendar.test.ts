import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { checkWorld, createRuntime, loadWorld, type CheckedWorld } from '#engine';

const slotSchema = z.object({ id: z.string(), starts_at: z.string(), ends_at: z.string() });
const appointmentSchema = z.object({ id: z.string(), slot_id: z.string(), status: z.string() });

describe('generated clinic calendar at reset', () => {
  let world: CheckedWorld;

  before(async () => {
    const loaded = await loadWorld(fileURLToPath(new URL('../../prod/worlds/gen-clinic-appointments', import.meta.url)));
    assert.ok(loaded.ok, loaded.ok ? '' : JSON.stringify(loaded.error));
    const checked = checkWorld(loaded.value);
    assert.ok(checked.ok, checked.ok ? '' : JSON.stringify(checked.issues));
    world = checked.world;
  });

  it('every publicly listed slot falls on a weekday within business hours and lasts 30 minutes', () => {
    const runtime = createRuntime(world);
    const slots: z.infer<typeof slotSchema>[] = [];
    let cursor: string | null = null;
    do {
      const response = runtime.call({ method: 'GET', path: '/slots', query: { limit: '100', ...(cursor === null ? {} : { cursor }) }, body: null });
      assert.equal(response.status, 200);
      const page = z.object({ data: z.array(slotSchema), next_cursor: z.string().nullable() }).parse(response.body);
      slots.push(...page.data);
      cursor = page.next_cursor;
    } while (cursor !== null);
    assert.equal(slots.length, 342);
    for (const slot of slots) {
      const start = new Date(slot.starts_at);
      assert.ok(start.getUTCDay() >= 1 && start.getUTCDay() <= 5, slot.id);
      assert.ok(slot.starts_at.slice(11, 16) >= '09:00', slot.id);
      assert.ok(slot.ends_at.slice(11, 16) <= '17:00', slot.id);
      assert.equal(slot.starts_at.slice(0, 10), slot.ends_at.slice(0, 10), slot.id);
      assert.equal(Date.parse(slot.ends_at) - start.getTime(), 1_800_000, slot.id);
    }
  });

  it('retains nine checked-in appointments inside the legal check-in window', () => {
    const runtime = createRuntime(world);
    assert.equal(runtime.dump().now, '2026-10-06T09:00:00.000Z');
    const response = runtime.call({ method: 'GET', path: '/appointments', query: { status: 'checked_in' }, body: null });
    assert.equal(response.status, 200);
    const page = z.object({ data: z.array(appointmentSchema), next_cursor: z.string().nullable() }).parse(response.body);
    assert.equal(page.data.length, 9);
    assert.equal(page.next_cursor, null);
    for (const appointment of page.data) {
      const slotResponse = runtime.call({ method: 'GET', path: `/slots/${appointment.slot_id}`, query: {}, body: null });
      assert.equal(slotResponse.status, 200);
      const slot = slotSchema.parse(slotResponse.body);
      const untilStart = Date.parse(slot.starts_at) - Date.parse(runtime.dump().now);
      assert.ok(untilStart >= -1_800_000 && untilStart <= 1_800_000, appointment.id);
      assert.ok(runtime.dump().now <= slot.ends_at, appointment.id);
    }
  });
});
