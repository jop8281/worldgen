import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve, type CallRecord, type StateDump, type WorldServer } from '#engine';
import { EVENT_DELIVERY, filled, type JsonRequest } from './events.ts';
import { linkResult, SEQ_HEADER, type LinkResult, type Source } from './links.ts';
import type { EventFault, FaultKind, LoadedScenario } from './manifest.ts';
import { provenanceResult, type ProvenanceResult } from './provenance.ts';

export type BoundaryCall = {
  readonly seq: number;
  readonly world: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly fault: FaultKind | EventFault | null;
  readonly source: Source;
};
export type Undelivered = { readonly after: number; readonly event: string; readonly reason: string };
export type GateResult = { readonly world: string; readonly task: string; readonly score: number };
export type ScenarioVerdict = {
  readonly verdict: 0 | 1;
  readonly gates: readonly GateResult[];
  readonly links: readonly LinkResult[];
  readonly provenance: readonly ProvenanceResult[];
  /** Events an `out_of_order` rule still holds: a grade delivers them only when it is final. */
  readonly heldEvents: number;
};
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
type Delivered = Upstream & { readonly seq: number };
type Delivery = { readonly world: string; readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: Buffer | undefined };
type Reply = { readonly status: number; readonly type: string; readonly body: Buffer | string };
/** One firing of the event rule at index `event` of the scenario's events, triggered by the delivery at gateway seq `after`. */
type Firing = { readonly event: number; readonly after: number; readonly delivery: Delivery };

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
  operator: { deliveries: 1, reply: (first) => first },
};

const jsonDelivery = (r: JsonRequest): Delivery => ({
  world: r.world,
  method: r.method,
  path: r.path,
  headers: r.body === undefined ? {} : { 'content-type': 'application/json' },
  body: r.body === undefined ? undefined : Buffer.from(JSON.stringify(r.body)),
});

const parsed = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
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
    const undelivered: Undelivered[] = [];
    const faults = scenario.faults.map((f) => ({ ...f, seen: 0 }));
    const held = new Map<number, Firing>();
    let delivered = 0;
    let turn: Promise<unknown> = Promise.resolve();
    // One delivery at a time, and no grade during one, so the trace's seq is the order the worlds ran the calls in.
    const serially = <T>(job: () => Promise<T>): Promise<T> => {
      const run = turn.then(job);
      turn = run.catch(() => undefined);
      return run;
    };

    const deliver = async (d: Delivery, source: Source, fault: BoundaryCall['fault']): Promise<Delivered> => {
      delivered += 1;
      const seq = delivered;
      const init: RequestInit = { method: d.method, headers: { ...d.headers, [SEQ_HEADER]: String(seq) } };
      if (d.body !== undefined && d.body.length > 0) init.body = new Uint8Array(d.body);
      const r = await fetch(`${worlds[d.world]!.url}${d.path}`, init);
      const out = { seq, status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) };
      calls.push({ seq, world: d.world, method: d.method, path: d.path, status: out.status, fault, source });
      if (source !== 'event') await fire(seq, d, out);
      return out;
    };

    const deliverEvent = async ({ event, after, delivery }: Firing): Promise<void> => {
      const e = scenario.events[event]!;
      const out = await deliver(delivery, 'event', e.fault ?? null);
      if (out.status >= 400) undelivered.push({ after, event: e.name, reason: `${delivery.world} answered ${out.status} to the delivery at gateway seq ${out.seq}` });
    };

    const fire = async (seq: number, d: Delivery, out: Upstream): Promise<void> => {
      const pathname = d.path.split('?')[0];
      for (const [i, e] of scenario.events.entries()) {
        const { on } = e;
        if (on.world !== d.world || on.method !== d.method || on.path !== pathname || on.status !== out.status) continue;
        const request = filled(e.deliver, parsed(out.body));
        if (!request.ok) {
          undelivered.push({ after: seq, event: e.name, reason: request.reason });
          continue;
        }
        const { send, hold } = EVENT_DELIVERY[e.fault ?? 'none']({ event: i, after: seq, delivery: jsonDelivery(request.value) }, held.get(i));
        held.delete(i);
        if (hold !== undefined) held.set(i, hold);
        for (const f of send) await deliverEvent(f);
      }
    };

    const flush = async (): Promise<void> => {
      for (const [i, f] of [...held]) {
        held.delete(i);
        await deliverEvent(f);
      }
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
        const reply = await serially(async () => {
          const matched = faults.filter((f) => f.world === seg && f.method === method && f.path === pathname);
          for (const f of matched) f.seen += 1;
          const fault = matched.find((f) => f.seen === f.nth) ?? null;
          if (fault?.kind === 'operator') await deliver(jsonDelivery({ ...fault.request, world: fault.request.world ?? seg }), 'operator', null);
          const row = DELIVERY[fault?.kind ?? 'normal'];
          let first: Upstream | null = null;
          for (let i = 0; i < row.deliveries; i += 1) {
            const r = await deliver({ world: seg, method, path: `${pathname}${url.search}`, headers, body }, 'agent', fault?.kind ?? null);
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
      const read = [...scenario.links.flatMap((l) => [l.from.world, l.to.world]), ...scenario.provenance.flatMap((p) => [p.rows.world, ...(p.cites === undefined ? [] : [p.cites.world])])];
      for (const name of new Set(read)) {
        const state = await fetch(`${worlds[name]!.adminUrl}/_world/state`);
        const log = await fetch(`${worlds[name]!.adminUrl}/_world/log`);
        for (const [route, r] of [['state', state], ['log', log]] as const) {
          if (r.status !== 200) return json(500, { error: { code: 'grade.failed', message: `World ${name}: the world's ${route} route answered ${r.status}.` } });
        }
        tables[name] = ((await state.json()) as StateDump).tables;
        logs[name] = ((await log.json()) as { calls: CallRecord[] }).calls;
      }
      const evidence = { trace: calls, logs: (world: string) => logs[world] ?? [] };
      const rows = (world: string, entity: string) => tables[world]?.[entity] ?? [];
      const links = scenario.links.map((l) => linkResult(l, rows, evidence));
      const provenance = scenario.provenance.map((p) => provenanceResult(p, rows, evidence, (world, entity) => loaded.worlds[world]!.entities[entity]!.idPrefix));
      const passed = gates.every((g) => g.score === 1) && links.every((l) => l.held) && provenance.every((p) => p.held);
      const verdict: ScenarioVerdict = { verdict: passed ? 1 : 0, gates, links, provenance, heldEvents: held.size };
      return json(200, verdict);
    };

    const admin = createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://admin');
        if (req.method === 'GET' && url.pathname === '/_scenario/trace') return send(res, json(200, { calls, undelivered }));
        if (req.method === 'POST' && url.pathname === '/_scenario/grade') {
          const final = url.search === '?final=1';
          if (url.search !== '' && !final) {
            return send(res, json(400, { error: { code: 'request.invalid', message: 'POST /_scenario/grade takes no query, or final=1 to deliver every held event before it grades.' } }));
          }
          return send(res, await serially(async () => {
            if (final) await flush();
            return grade();
          }));
        }
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
