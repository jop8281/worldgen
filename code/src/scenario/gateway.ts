import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type CallRecord, type StateDump, type WorldServer } from '#engine';
import { linkResult, SEQ_HEADER, type LinkResult } from './links.ts';
import type { FaultKind, LoadedScenario } from './manifest.ts';

export type BoundaryCall = { readonly seq: number; readonly world: string; readonly method: string; readonly path: string; readonly status: number; readonly fault: FaultKind | null };
export type GateResult = { readonly world: string; readonly task: string; readonly score: number };
export type ScenarioVerdict = { readonly verdict: 0 | 1; readonly gates: readonly GateResult[]; readonly links: readonly LinkResult[] };
export interface ScenarioServer {
  readonly url: string;
  readonly adminUrl: string;
  readonly port: number;
  readonly adminPort: number;
  readonly worlds: Readonly<Record<string, WorldServer>>;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const MAX_BODY = 1_048_576;
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive']);

type Upstream = { readonly status: number; readonly type: string | null; readonly body: Buffer };
type Reply = { readonly status: number; readonly type: string; readonly body: Buffer | string };

const DELIVERY: Record<FaultKind | 'normal', { readonly deliveries: number; readonly reply: (first: Upstream) => Upstream | Reply }> = {
  normal: { deliveries: 1, reply: (first) => first },
  drop_response: {
    deliveries: 1,
    reply: () => ({
      status: 504,
      type: 'application/json',
      body: JSON.stringify({ error: { code: 'gateway.timeout', message: 'The upstream did not answer in time.' } }),
    }),
  },
  duplicate: { deliveries: 2, reply: (first) => first },
};

const json = (status: number, body: unknown): Reply => ({ status, type: 'application/json', body: JSON.stringify(body) });

function send(res: ServerResponse, r: Upstream | Reply): void {
  const type = r.type ?? 'application/json';
  res.writeHead(r.status, { 'content-type': type });
  res.end(r.body);
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY) return null;
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function listenOn(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function serveScenario(loaded: LoadedScenario, opts: { port: number; adminPort?: number }): Promise<ScenarioServer> {
  const { scenario } = loaded;
  const worlds: Record<string, WorldServer> = {};
  const servers: Server[] = [];
  let closed: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closed ??= (async () => {
      await Promise.all([...servers.map(stop), ...Object.values(worlds).map((w) => w.close())]);
    })();
    return closed;
  };
  try {
    for (const [name, world] of Object.entries(loaded.worlds)) worlds[name] = await serve(world, { port: 0 });

    const calls: BoundaryCall[] = [];
    const faults = scenario.faults.map((f) => ({ ...f, seen: 0 }));
    let delivered = 0;
    let turn: Promise<unknown> = Promise.resolve();
    // One delivery at a time, and no grade during one, so the trace's seq is the order the worlds ran the calls in.
    const serially = <T>(job: () => Promise<T>): Promise<T> => {
      const run = turn.then(job);
      turn = run.catch(() => undefined);
      return run;
    };

    const deliver = async (world: string, method: string, path: string, headers: Record<string, string>, body: Buffer | undefined, fault: FaultKind | null): Promise<Upstream> => {
      delivered += 1;
      const seq = delivered;
      const init: RequestInit = { method, headers: { ...headers, [SEQ_HEADER]: String(seq) } };
      if (body !== undefined && body.length > 0) init.body = new Uint8Array(body);
      const r = await fetch(`${worlds[world]!.url}${path}`, init);
      const out = { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
      calls.push({ seq, world, method, path, status: out.status, fault });
      return out;
    };

    const gateway = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://gateway');
        const [, seg = '', ...rest] = url.pathname.split('/');
        const method = req.method ?? 'GET';
        if (!Object.hasOwn(worlds, seg)) {
          send(res, json(404, { error: { code: 'route.unknown', message: `No world at /${seg}. Worlds: ${Object.keys(worlds).join(', ')}` } }));
          return;
        }
        const pathname = `/${rest.join('/')}`;
        const body = await readBody(req);
        if (body === null) {
          send(res, json(413, { error: { code: 'request.too_large', message: `The request body is larger than ${MAX_BODY} bytes.` } }));
          return;
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        const path = `${pathname}${url.search}`;
        const reply = await serially(async () => {
          let fault: FaultKind | null = null;
          for (const f of faults) {
            if (f.world === seg && f.method === method && f.path === pathname) {
              f.seen += 1;
              if (f.seen === f.nth && fault === null) fault = f.kind;
            }
          }
          const row = DELIVERY[fault ?? 'normal'];
          let first: Upstream | null = null;
          for (let i = 0; i < row.deliveries; i += 1) {
            const r = await deliver(seg, method, path, headers, body, fault);
            first ??= r;
          }
          return row.reply(first!);
        });
        send(res, reply);
      })().catch(() => {
        if (!res.headersSent) send(res, json(502, { error: { code: 'gateway.error', message: 'The gateway could not reach the world.' } }));
        else res.end();
      });
    });

    const grade = async (): Promise<Reply> => {
      const gates: GateResult[] = [];
      for (const g of scenario.gates) {
        const r = await fetch(`${worlds[g.world]!.adminUrl}/_world/grade/${encodeURIComponent(g.task)}`, { method: 'POST' });
        if (r.status !== 200) return json(500, { error: { code: 'grade.failed', message: `Gate ${g.world}/${g.task}: the world's grade route answered ${r.status}.` } });
        const score = ((await r.json()) as { score: number }).score;
        gates.push({ world: g.world, task: g.task, score });
      }
      const tables: Record<string, StateDump['tables']> = {};
      const logs: Record<string, readonly CallRecord[]> = {};
      for (const name of new Set(scenario.links.flatMap((l) => [l.from.world, l.to.world]))) {
        const state = await fetch(`${worlds[name]!.adminUrl}/_world/state`);
        const log = await fetch(`${worlds[name]!.adminUrl}/_world/log`);
        for (const [route, r] of [['state', state], ['log', log]] as const) {
          if (r.status !== 200) return json(500, { error: { code: 'grade.failed', message: `World ${name}: the world's ${route} route answered ${r.status}.` } });
        }
        tables[name] = ((await state.json()) as StateDump).tables;
        logs[name] = ((await log.json()) as { calls: CallRecord[] }).calls;
      }
      const evidence = { trace: calls, logs: (world: string) => logs[world] ?? [] };
      const links = scenario.links.map((l) => linkResult(l, (world, entity) => tables[world]?.[entity] ?? [], evidence));
      const verdict: ScenarioVerdict = { verdict: gates.every((g) => g.score === 1) && links.every((l) => l.held) ? 1 : 0, gates, links };
      return json(200, verdict);
    };

    const admin = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://admin');
        if (req.method === 'GET' && url.pathname === '/_scenario/trace') return send(res, json(200, { calls }));
        if (req.method === 'POST' && url.pathname === '/_scenario/grade') return send(res, await serially(grade));
        send(res, json(404, { error: { code: 'route.unknown', message: 'No such scenario admin route.' } }));
      })().catch(() => {
        if (!res.headersSent) send(res, json(500, { error: { code: 'admin.error', message: 'The scenario admin failed.' } }));
        else res.end();
      });
    });

    servers.push(gateway, admin);
    const port = await listenOn(gateway, opts.port);
    const adminPort = await listenOn(admin, opts.port === 0 ? (opts.adminPort ?? 0) : (opts.adminPort ?? opts.port + 1));
    return { url: `http://${HOST}:${port}`, adminUrl: `http://${HOST}:${adminPort}`, port, adminPort, worlds, close };
  } catch (e) {
    await close();
    throw e;
  }
}
