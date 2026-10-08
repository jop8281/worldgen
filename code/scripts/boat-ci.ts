/**
 * The test gate on a large Boat VM: `bun run check` on one archived ref, with a summary per run.
 * Driven by scripts/boat-ci.sh; reads BOAT_API_KEY from
 * the environment only. The VM always goes down. It is metered like every Boat VM: its 2-hour TTL
 * is reserved in the spend ledger before creation, so `reconcile-orphans` sees a live claim.
 *
 *   bun scripts/boat-ci.ts <archive.tgz> [label] [junit-out]
 *
 * When the ref has scripts/factory-check.sh it runs too, and its .factory/junit.xml is copied to junit-out.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { SANDBOX_BUN_VERSION, nodeRunner } from '../src/sandboxes/backend.ts';
import { backendFor } from '../src/sandboxes/registry.ts';

const [archive, label = 'ref', junitOut] = process.argv.slice(2);
if (archive === undefined) {
  process.stderr.write('usage: bun scripts/boat-ci.ts <archive.tgz> [label]\n');
  process.exit(2);
}

const BUN_DIR = '/tmp/worldgen-bun';
/** A guard scale for suites sharing 8 CPUs, so failures map onto CI's. */
const GUARD_SCALE = '2';
const PATHS = `export PATH=${BUN_DIR}/node_modules/.bin:$PATH WORLDGEN_GUARD_SCALE=${GUARD_SCALE}; cd /tmp/worldgen/repo/code`;
const RUNS: Record<string, string> = {
  bun: 'bun run check',
};
const POLL_MS = 20_000;
const MAX_MS = 100 * 60_000;

const t0 = Date.now();
const elapsed = (): string => `${Math.round((Date.now() - t0) / 1000)}s`;
const log = (line: string): void => void process.stderr.write(`[boat-ci ${label} ${elapsed()}] ${line}\n`);

/**
 * A long-lived VM sometimes answers 502, or 409 `sandbox_not_ready` while boat.dev updates it, and refuses stop meanwhile.
 * Both pass within minutes, so a lost poll or stop must not end the run or leak the VM.
 */
async function retry<T>(f: () => Promise<T>, tries = 15): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await f();
    } catch (err) {
      if (n >= tries) throw err;
      log(`retry ${n} after: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      await new Promise((r) => setTimeout(r, Math.min(5_000 * n, 30_000)));
    }
  }
}

const b = backendFor('boat', process.env, nodeRunner, { size: 'large', ttlSeconds: 7200, runId: `boat-ci ${label}` }).backend;
const sb = await b.up([{ path: 'repo.tgz', data: readFileSync(archive) }], { name: 'boat-ci' });
log(`up ${sb.id} (large)`);
let failed = false;
try {
  const sh = async (cmd: string, timeoutSec = 600): Promise<string> => {
    const r = await retry(() => b.exec(sb.id, ['bash', '-c', cmd], { workdir: sb.workdir, timeoutSec }));
    if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}: ${cmd}\n${(r.stderr || r.stdout).trim().split('\n').slice(-15).join('\n')}`);
    return r.stdout;
  };
  await sh('mkdir -p repo && tar -xzf repo.tgz -C repo');
  await sh(`npm install --silent --no-audit --no-fund --prefix ${BUN_DIR} bun@${SANDBOX_BUN_VERSION}`);
  await sh(`${PATHS} && bun --version && bun install --frozen-lockfile >/tmp/install.log 2>&1`);
  log(`installed bun ${SANDBOX_BUN_VERSION}, ${(await sh('nproc')).trim()} cpus, WORLDGEN_GUARD_SCALE=${GUARD_SCALE}`);
  if ((await sh('test -f repo/scripts/factory-check.sh && echo yes || true')).trim() === 'yes') RUNS['factory'] = 'cd .. && bash scripts/factory-check.sh';
  for (const [name, cmd] of Object.entries(RUNS)) {
    await b.start(sb.id, ['bash', '-c', `${PATHS} && { ${cmd}; echo $? > /tmp/${name}.exit; }`], { workdir: sb.workdir, log: `/tmp/${name}.log` });
  }
  const done = async (): Promise<boolean> => (await sh(`ls /tmp/*.exit 2>/dev/null | wc -l`)).trim() === String(Object.keys(RUNS).length);
  while (!(await done())) {
    if (Date.now() - t0 > MAX_MS) throw new Error(`checks still running after ${MAX_MS / 60_000} min`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  for (const name of Object.keys(RUNS)) {
    const exit = (await sh(`cat /tmp/${name}.exit`)).trim();
    const summary = await sh(`grep -E '^ *[0-9]+ (pass|fail|skip|todo)$|^Ran [0-9]+ tests|^\\(fail\\)' /tmp/${name}.log | sort -u | head -60 || true`);
    const tc = await sh(`grep -E 'error TS' /tmp/${name}.log | head -10 || true`);
    process.stdout.write(`\n== ${name} (${RUNS[name]}) exit ${exit}\n${tc}${summary}`);
    if (name === 'factory' && junitOut !== undefined) {
      writeFileSync(junitOut, await sh('cat /tmp/worldgen/repo/.factory/junit.xml || true'));
      process.stdout.write(`junit: ${junitOut}\n`);
    }
    if (exit !== '0') failed = true;
  }
} catch (err) {
  failed = true;
  log(err instanceof Error ? err.message : String(err));
} finally {
  await retry(() => b.down(sb.id));
  log(`down ${sb.id}`);
}
process.stdout.write(`\nboat-ci ${label}: ${failed ? 'FAIL' : 'PASS'} on ${sb.id} in ${elapsed()}\n`);
process.exit(failed ? 1 : 0);
