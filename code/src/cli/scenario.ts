/** Exit codes: 0 ok, 1 the scenario failed to load, 2 bad usage. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { serveScenario } from '../scenario/gateway.ts';
import { loadScenario } from '../scenario/manifest.ts';
import { UsageError } from './options.ts';

export const USAGE = `usage: scenario <command> <dir> [options]
Commands:
  check <dir>          load <dir>/scenario.yaml, check every world, and print one summary line
  serve <dir>          serve every world in process behind one gateway, until SIGINT or SIGTERM
Options for serve:
  --port <n>           the gateway port, the only one an agent gets (default 4100; 0 picks a free port)
  --admin-port <n>     the operator's admin port: GET /_scenario/trace and POST /_scenario/grade (default port + 1)
  -h, --help           this text
The gateway forwards /<alias>/<rest> to that world's world port.
POST /_scenario/grade scores every gate, link and provenance gate and delivers nothing, so a mid-run grade
changes no world; its heldEvents counts the events an out_of_order rule still holds. POST /_scenario/grade?final=1
first delivers every held event, then grades. Use it at the end of a run.`;

export type Args = { readonly command: 'check' | 'serve'; readonly dir: string; readonly port: number; readonly adminPort: number | undefined };

const portOf = (flag: string, v: string): number => {
  if (!/^\d+$/.test(v) || Number(v) > 65535) throw new UsageError(`${flag} must be a port from 0 to 65535, got ${v}`);
  return Number(v);
};

export function parse(argv: readonly string[]): Args | 'help' {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { port: { type: 'string' }, 'admin-port': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  if (parsed.values['help'] === true) return 'help';
  const [command, dir, ...extra] = parsed.positionals;
  if (command !== 'check' && command !== 'serve') throw new UsageError(`the command must be check or serve, got ${command ?? 'nothing'}`);
  if (dir === undefined || extra.length > 0) throw new UsageError(`${command} takes exactly one scenario directory`);
  const port = parsed.values['port'] as string | undefined;
  const admin = parsed.values['admin-port'] as string | undefined;
  if (command === 'check' && (port !== undefined || admin !== undefined)) throw new UsageError('--port and --admin-port belong to serve');
  return { command, dir: path.resolve(dir), port: port === undefined ? 4100 : portOf('--port', port), adminPort: admin === undefined ? undefined : portOf('--admin-port', admin) };
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const loaded = await loadScenario(args.dir);
  if (!loaded.ok) {
    for (const e of loaded.errors) process.stderr.write(`${e}\n`);
    return 1;
  }
  const { scenario } = loaded.value;
  const aliases = Object.keys(scenario.worlds);
  if (args.command === 'check') {
    process.stdout.write(`ok ${scenario.name}: ${plural(aliases.length, 'world')} (${aliases.join(', ')}), ${plural(scenario.gates.length, 'gate')}, ${plural(scenario.faults.length, 'fault')}, ${plural(scenario.events.length, 'event')}, ${plural(scenario.links.length, 'link')}, ${plural(scenario.provenance.length, 'provenance gate')}\n`);
    return 0;
  }
  const server = await serveScenario(loaded.value, { port: args.port, ...(args.adminPort === undefined ? {} : { adminPort: args.adminPort }) });
  const ports = Object.fromEntries(Object.entries(server.worlds).map(([a, w]) => [a, { world: w.port, admin: w.adminPort }]));
  process.stdout.write(`${JSON.stringify({ listening: { gateway: server.port, admin: server.adminPort, worlds: ports } })}\n`);
  process.stdout.write(`gateway ${server.url}\nadmin ${server.adminUrl}\n`);
  for (const [a, w] of Object.entries(server.worlds)) process.stdout.write(`world ${a} ${w.url} admin ${w.adminUrl}\n`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await server.close();
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
