import assert from 'node:assert/strict';
import { it } from 'node:test';
import { startServer } from './redteam/harness.ts';

it('reports the default 60000 ms readiness bound before cleanup', { timeout: 10_000 }, async () => {
  const original = Date.now;
  let reads = 0;
  Date.now = () => reads++ === 0 ? 0 : 60_001;
  try {
    await assert.rejects(startServer('../prod/worlds/helpdesk'), /readiness timed out after 60000 ms/);
  } finally {
    Date.now = original;
  }
});

it('reports an explicit readiness bound before cleanup', { timeout: 10_000 }, async () => {
  const original = Date.now;
  let reads = 0;
  Date.now = () => reads++ === 0 ? 0 : 18;
  try {
    await assert.rejects(startServer('../prod/worlds/helpdesk', { timeoutMs: 17 }), /readiness timed out after 17 ms/);
  } finally {
    Date.now = original;
  }
});
