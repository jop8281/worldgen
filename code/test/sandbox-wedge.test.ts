/**
 * The snippet host must never wait forever on its worker. A live WorldGen run hung with the main
 * thread blocked in readSync and the worker blocked in readSync, so no timer could fire.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkWorld } from '#engine';
import { readExact } from '../src/engine/sandbox.ts';
import { minimalWorld } from './helpers/world.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');

describe('snippet host liveness', () => {
  it('an outer run whose guard expires while a nested run replies faults instead of wedging the host', () => {
    const r = spawnSync(process.execPath, ['test/helpers/wedge-repro.ts'], { cwd: CODE_DIR, encoding: 'utf8', timeout: 90_000, killSignal: 'SIGKILL' });
    assert.equal(r.error, undefined, `the child did not finish in 90 s; it printed:\n${r.stdout}`);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.at(-1), 'done');
    assert.equal(lines.length, 9);
    for (const line of lines.slice(0, -1)) assert.match(line, /^host=\d+ rep=\d ok 30000$|^host=\d+ rep=\d threw snippet\.timeout_guard$/, line);
  });
});

describe('readExact', () => {
  const fifo = (): { path: string; dir: string } => {
    const dir = mkdtempSync(path.join(tmpdir(), 'readexact-'));
    const p = path.join(dir, 'f');
    execFileSync('mkfifo', [p]);
    return { path: p, dir };
  };

  it('reads what a writer sends, returns eof when the writer closes, and stalls on silence', () => {
    const { path: p, dir } = fifo();
    const reader = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
    const writer = openSync(p, constants.O_WRONLY);
    try {
      writeSync(writer, Buffer.from([1, 2, 3, 4]));
      assert.deepEqual(readExact(reader, 4, 500), Buffer.from([1, 2, 3, 4]));

      const t0 = performance.now();
      assert.equal(readExact(reader, 4, 150), 'stalled');
      const waited = performance.now() - t0;
      assert.ok(waited >= 150 && waited < 1500, `waited ${waited} ms`);

      writeSync(writer, Buffer.from([9, 9]));
      assert.equal(readExact(reader, 4, 150), 'stalled');

      closeSync(writer);
      assert.equal(readExact(reader, 4, 500), 'eof');
    } finally {
      closeSync(reader);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a frame whose halves arrive after the host has started sleeping between polls', () => {
    const { path: p, dir } = fifo();
    const reader = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
    const held = openSync(p, constants.O_WRONLY);
    const late = `const fs = require('node:fs'); const fd = fs.openSync(${JSON.stringify(p)}, 'w');
      setTimeout(() => fs.writeSync(fd, Buffer.from([1, 2])), 40);
      setTimeout(() => { fs.writeSync(fd, Buffer.from([3, 4])); fs.closeSync(fd); }, 120);`;
    const child = spawn(process.execPath, ['-e', late], { stdio: 'ignore' });
    try {
      assert.deepEqual(readExact(reader, 4, 5_000), Buffer.from([1, 2, 3, 4]));
    } finally {
      child.kill('SIGKILL');
      closeSync(held);
      closeSync(reader);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops a long wait when stop() turns true, well before the stall', () => {
    const { path: p, dir } = fifo();
    const reader = openSync(p, constants.O_RDONLY | constants.O_NONBLOCK);
    const writer = openSync(p, constants.O_WRONLY);
    try {
      const t0 = performance.now();
      assert.equal(readExact(reader, 4, 60_000, () => performance.now() - t0 > 200), 'aborted');
      const waited = performance.now() - t0;
      assert.ok(waited >= 200 && waited < 5_000, `waited ${waited} ms`);
    } finally {
      closeSync(writer);
      closeSync(reader);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('slow ctx replies', () => {
  it('a seed that computes between ctx calls checks exactly like one that does not', () => {
    const SLOW = `(ctx) => { let x = 0; for (let k = 0; k < 8; k++) { for (let i = 0; i < 2e7; i++) x += i; ctx.rng(); } return [
  { name: 'Acme', tier: 'enterprise' },
  { name: 'Globex', tier: 'pro' },
  { name: 'Initech', tier: 'pro' },
  { name: 'Umbrella', tier: 'free' },
  { name: 'Hooli', tier: 'free' },
]; }`;
    const slow = checkWorld(minimalWorld({ seed: { customer: SLOW } }));
    const plain = checkWorld(minimalWorld());
    assert.equal(slow.ok, true);
    assert.equal(plain.ok, true);
    const { world: _slowWorld, ...slowRest } = slow;
    const { world: _plainWorld, ...plainRest } = plain;
    assert.deepEqual(slowRest, plainRest);
  });
});
