/**
 * Loaded by `test:node` with --import. A test process still alive after 120 s prints to stderr, then every 60 s,
 * what keeps it alive: each active handle, with the pid and command of a child process (A-223). A file whose
 * tests passed but whose process lingers otherwise hangs the runner with no output. The timer is unref'd, so the
 * hook never keeps a process alive itself.
 */
type Handle = { constructor?: { name?: string }; pid?: number; spawnfile?: string; spawnargs?: string[]; fd?: number; _handle?: { fd?: number } };

function describe(h: Handle): string {
  const kind = h.constructor?.name ?? typeof h;
  if (h.pid !== undefined) return `${kind} pid ${h.pid}: ${[h.spawnfile, ...(h.spawnargs ?? []).slice(1)].join(' ').slice(0, 160)}`;
  const fd = h.fd ?? h._handle?.fd;
  return fd === undefined ? kind : `${kind} fd ${fd}`;
}

const FIRST_MS = 120_000;
const EVERY_MS = 60_000;
const started = Date.now();
const report = (): void => {
  const get = Reflect.get(process, '_getActiveHandles') as (() => Handle[]) | undefined;
  const handles = (get?.call(process) ?? []).filter((h) => h !== (timer as unknown));
  const file = process.argv[1] ?? '(unknown file)';
  process.stderr.write(`[active-handles] pid ${process.pid} ${file} after ${Math.round((Date.now() - started) / 1000)} s: ${handles.map(describe).join('; ') || 'none'}\n`);
};
let timer: NodeJS.Timeout | undefined;
setTimeout(() => {
  report();
  timer = setInterval(report, EVERY_MS);
  timer.unref();
}, FIRST_MS).unref();
