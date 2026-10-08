/**
 * The recorded browser E2E of a served world's controls (YOS-189, YOS-193), in headless Chrome over CDP. No Playwright:
 * Chrome and Bun only, and no model call.
 *
 *   bun scripts/studio-e2e.ts [out-dir]
 *
 * It starts its own studio on a free loopback port, signed in from a scratch users file: ana (operator, tenant acme)
 * does the work, vic (viewer, acme) and bob (operator, globex) try what their roles must refuse. Their tokens are random
 * and live only in this process; the page gets them through its sign-in form. For helpdesk and for gen-billing-dunning,
 * a world WorldGen generated, ana serves the world and, through the API console, makes a legal read, a legal write, and
 * an illegal write that mixes a legal half with an illegal one. The engine refuses it whole with 422, and the state hash
 * on the world's own admin console reads the same before and after. A reset without the typed name is refused; with it,
 * the world returns to its seed hash. vic's reset is refused 403, and bob is told the world is not running for him, while
 * the studio answers his reset of ana's service 404.
 *
 * It writes one numbered PNG per step and steps.json: each step's requests as the page sent them (method, path, body,
 * status, and the world's own status for a console call), and the state hash the admin console showed. It exits 0 only
 * when every step holds and the page threw nothing.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(CODE_DIR, '..');
const OUT = process.argv[2] ?? path.join(tmpdir(), 'studio-e2e');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How much of a world's answer body steps.json keeps per request. */
const LOG_BODY_CHARS = 2000;

const PEOPLE = [
  { name: 'ana', role: 'operator', tenant: 'acme' },
  { name: 'vic', role: 'viewer', tenant: 'acme' },
  { name: 'bob', role: 'operator', tenant: 'globex' },
] as const;
type Name = (typeof PEOPLE)[number]['name'];
const tokens = new Map<Name, string>(PEOPLE.map((p) => [p.name, randomBytes(24).toString('hex')]));
const who = (name: Name): string => { const p = PEOPLE.find((x) => x.name === name)!; return `${p.name} (${p.role}, ${p.tenant})`; };

/** One world's script: a legal read, a legal write, an illegal write refused whole, and the read that shows it. */
type Plan = {
  readonly world: string;
  readonly read: string;
  /** The record the writes touch, from the legal read's body. */
  readonly pick: (body: any) => string;
  readonly legal: (id: string) => { readonly path: string; readonly body: object };
  readonly illegal: (id: string) => { readonly path: string; readonly body: object; readonly code: string };
  /** True when the record read after the 422 still holds the legal write and none of the illegal one. */
  readonly kept: (record: any) => boolean;
};
const PLANS: readonly Plan[] = [
  {
    world: 'helpdesk',
    read: '/tickets?status=open&limit=3',
    pick: (body) => body.data[0].id,
    legal: (id) => ({ path: `/tickets/${id}`, body: { priority: 'low' } }),
    illegal: (id) => ({ path: `/tickets/${id}`, body: { status: 'new', priority: 'urgent' }, code: 'state.transition' }),
    kept: (t) => t.priority === 'low' && t.status === 'open',
  },
  {
    world: 'gen-billing-dunning',
    read: '/customers?limit=2',
    pick: (body) => body.data[0].id,
    legal: (id) => ({ path: `/customers/${id}`, body: { name: `Renamed in the E2E ${id}` } }),
    illegal: (id) => ({ path: `/customers/${id}`, body: { name: 'Never applied', email: 'not-an-email' }, code: 'field.type' }),
    kept: (c) => typeof c.name === 'string' && c.name.startsWith('Renamed in the E2E') && c.email !== 'not-an-email',
  },
];

// A scratch worlds dir with a copy of each world, so the run never writes the repository's run store or audit log.
const work = mkdtempSync(path.join(tmpdir(), 'studio-e2e-'));
const worldsDir = path.join(work, 'worlds');
for (const p of PLANS) cpSync(path.join(REPO, 'prod', 'worlds', p.world), path.join(worldsDir, p.world), { recursive: true });
const usersFile = path.join(work, 'users.json');
writeFileSync(usersFile, JSON.stringify({ users: PEOPLE.map((p) => ({ ...p, token_sha256: createHash('sha256').update(tokens.get(p.name)!).digest('hex') })) }), { mode: 0o600 });

// The studio refuses --users together with WORLDGEN_STUDIO_TOKEN, and the run never needs a model key.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WORLDGEN_STUDIO_TOKEN' && k !== 'LLM_KEY'));
const studio = spawn(process.execPath, ['src/cli/studio.ts', '--port', '0', '--users', usersFile, '--worlds-dir', worldsDir, '--repo-root', REPO], { cwd: CODE_DIR, env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
const CHROME = process.env['CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(OUT, 'chrome-profile');
// Port 0 lets Chrome pick a free port and write it to DevToolsActivePort; a fixed port can reach another session's Chrome.
rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
// Every exit stops Chrome and the studio's whole process group (each world it serves), and removes the scratch dir.
process.on('exit', () => {
  chrome.kill();
  try { process.kill(-studio.pid!, 'SIGTERM'); } catch {}
  rmSync(work, { recursive: true, force: true });
});
process.on('SIGINT', () => process.exit(130));
const fail = (why: string): never => { console.error(why); process.exit(1); };

let STUDIO = '';
let said = '';
studio.stdout!.setEncoding('utf8').on('data', (s: string) => { said += s; STUDIO = /studio on (http:\/\/\S+)/.exec(said)?.[1] ?? STUDIO; });
for (let i = 0; i < 150 && STUDIO === ''; i++) await sleep(100);
if (STUDIO === '') fail(`the scratch studio printed no URL (exit ${studio.exitCode})`);

let port = '';
let pageWs = '';
for (let i = 0; i < 50 && pageWs === ''; i++) {
  await sleep(200);
  try {
    port = readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]!;
    pageWs = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch {}
}
if (pageWs === '') fail(`no devtools page from Chrome (port '${port}', exit ${chrome.exitCode})`);
// The port must be this Chrome's own: only its pid may listen there.
const owners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l !== '').map(Number);
if (owners.length === 0 || owners.some((pid) => pid !== chrome.pid)) fail(`devtools port ${port} is held by ${owners.join(', ') || 'nobody'}, not this Chrome (${chrome.pid})`);
console.log(`studio ${STUDIO} (pid ${studio.pid}); chrome devtools 127.0.0.1:${port}, owned by pid ${chrome.pid}`);

/** One request the page sent to the studio: what went out and what came back. */
type Call = { method: string; path: string; sent: unknown; status: number; answer: unknown };
type Tab = { ev: (expr: string) => Promise<any>; until: (expr: string, ms?: number) => Promise<boolean>; shot: (file: string, focus: string, height?: number) => Promise<void>; calls: () => Promise<Call[]>; errors: string[] };

/** A CDP session on one page target. With `network`, it keeps every /api/ request the page sends, for the step log. */
async function connect(wsUrl: string, network: boolean): Promise<Tab> {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const errors: string[] = [];
  const sent = new Map<string, { method: string; path: string; body: string | undefined; status?: number }>();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id !== undefined) pending.get(m.id)?.(m);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(' '));
    if (m.method === 'Network.requestWillBeSent') {
      const u = new URL(m.params.request.url);
      if (u.pathname.startsWith('/api/') && m.params.request.method !== 'GET') sent.set(m.params.requestId, { method: m.params.request.method, path: u.pathname, body: m.params.request.postData });
    }
    if (m.method === 'Network.responseReceived' && sent.has(m.params.requestId)) sent.get(m.params.requestId)!.status = m.params.response.status;
  });
  const cdp = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr: string) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  if (network) await cdp('Network.enable');
  return {
    ev,
    errors,
    until: async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(150); } return false; },
    shot: async (file, focus, height = 560) => {
      const top = Number(await ev(`(()=>{const e=document.querySelector(${JSON.stringify(focus)});if(!e)return 0;e.scrollIntoView({block:'start'});return Math.max(0,e.getBoundingClientRect().top+window.scrollY-12)})()`) ?? 0);
      const shot = await cdp('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: top, width: 1400, height, scale: 1 } });
      writeFileSync(path.join(OUT, file), Buffer.from(shot.result.data, 'base64'));
    },
    /** The /api/ writes sent since the last call, with their answers; a GET is left out, since the page polls. */
    calls: async () => {
      const out: Call[] = [];
      for (const [requestId, c] of sent) {
        if (c.status === undefined) continue;
        const body = (await cdp('Network.getResponseBody', { requestId })).result?.body;
        let answer: any = body;
        try { answer = JSON.parse(body); } catch {}
        // A console call's answer carries the world's whole body; the log keeps its first 2000 characters.
        if (typeof answer?.body === 'string' && answer.body.length > LOG_BODY_CHARS) answer = { ...answer, body: `${answer.body.slice(0, LOG_BODY_CHARS)}…`, cutForLog: answer.body.length };
        let parsed: unknown = c.body;
        try { parsed = c.body === undefined ? null : JSON.parse(c.body); } catch {}
        out.push({ method: c.method, path: c.path, sent: parsed, status: c.status, answer });
        sent.delete(requestId);
      }
      return out;
    },
  };
}

const page = await connect(pageWs, true);
// The world's admin console, in a second tab: the state hash the engine reports, never reachable from the world port.
const adminTarget = (await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()) as { webSocketDebuggerUrl: string };
const admin = await connect(adminTarget.webSocketDebuggerUrl, false);

type Step = { n: number; file: string; who: string; world: string | null; what: string; requests: Call[]; stateHash: string | null; checks: Record<string, boolean>; ok: boolean };
const steps: Step[] = [];
let n = 0;
/** Records one step: its screenshot, the page's requests since the last step, the hash shown, and whether each check held. */
async function record(tab: Tab, name: string, actor: Name, world: string | null, what: string, focus: string, checks: Record<string, boolean>, stateHash: string | null = null, height?: number): Promise<Call[]> {
  n += 1;
  const file = `${String(n).padStart(2, '0')}-${name}.png`;
  await tab.shot(file, focus, height);
  const requests = await page.calls();
  const ok = Object.values(checks).every(Boolean);
  steps.push({ n, file, who: who(actor), world, what, requests, stateHash, checks, ok });
  console.log(`${ok ? 'ok   ' : 'BREAK'} ${file}${ok ? '' : ` | failed: ${Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(', ')}`}`);
  return requests;
}

const signedOut = `!!document.querySelector('#signin-form')&&!document.querySelector('#signin-form').hidden`;
const signedInAs = (name: Name) => `document.querySelector('#who')?.textContent===${JSON.stringify(`${name} (${PEOPLE.find((p) => p.name === name)!.role})`)}&&document.querySelectorAll('#worlds-table tr, table tr').length>2`;
const typeToken = (name: Name) => `(()=>{document.querySelector('#signin-token').value=${JSON.stringify(tokens.get(name)!)};document.querySelector('#signin-form').requestSubmit();return true})()`;
/** Signs out if someone is signed in, then signs `name` in through the page's token form. */
async function signIn(name: Name): Promise<boolean> {
  if (!await page.ev(signedOut)) {
    await page.ev(`document.querySelector('#signout').click(), true`);
    if (!await page.until(signedOut)) return false;
  }
  await page.ev(typeToken(name));
  return page.until(signedInAs(name));
}
const row = (world: string) => `[...document.querySelectorAll('tr')].find(t=>t.cells[0]?.textContent.trim()===${JSON.stringify(world)})`;
const rowBtn = (world: string, text: string) => `(()=>{const b=[...(${row(world)}?.querySelectorAll('button')??[])].find(b=>b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text)}));b?.click();return !!b})()`;
const explore = (world: string) => `(()=>{const s=document.querySelector('#explorer-world');s.value=${JSON.stringify(world)};s.dispatchEvent(new Event('change'));document.querySelector('#explorer-load').click();return true})()`;
const explored = (world: string) => `document.querySelector('#explorer-world')?.value===${JSON.stringify(world)}&&!!document.querySelector('#explorer-meta')?.textContent.includes('definition')`;
/** Sends one console request and waits for the world's answer line; answers the world's status and parsed body. */
async function consoleCall(method: string, p: string, body: object | null): Promise<{ status: number; body: any }> {
  await page.ev(`(()=>{const c=document.querySelector('#console-result');if(c)c.textContent='';document.querySelector('#console-method').value=${JSON.stringify(method)};document.querySelector('#console-path').value=${JSON.stringify(p)};document.querySelector('#console-body').value=${JSON.stringify(body === null ? '' : JSON.stringify(body))};document.querySelector('#console-send').click();return true})()`);
  await page.until(`/^HTTP \\d+ from /m.test(document.querySelector('#console-result')?.innerText??'')`);
  const status = Number(await page.ev(`(/^HTTP (\\d+) from /m.exec(document.querySelector('#console-result')?.innerText??'')??[])[1]`));
  const text = String(await page.ev(`document.querySelector('#console-result pre')?.textContent??'null'`));
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch {}
  return { status, body: parsed };
}
/** Reads the state hash off the world's admin console, after a fresh refresh. */
async function stateHash(adminPort: number): Promise<string | null> {
  const url = `http://127.0.0.1:${adminPort}/`;
  if (await admin.ev('location.href') !== url) { await admin.ev(`location.href=${JSON.stringify(url)}, true`); await admin.until(`!!document.querySelector('#state-refresh')`); }
  await admin.ev(`(document.querySelector('#state-meta').textContent='', document.querySelector('#state-refresh').click(), true)`);
  await admin.until(`/hash \\S+/.test(document.querySelector('#state-meta')?.textContent??'')`);
  return (/hash (\S+?),/.exec(String(await admin.ev(`document.querySelector('#state-meta')?.textContent??''`))) ?? [])[1] ?? null;
}
/** Types `typed` into the reset box and presses reset; answers the console result's text once it changes. */
async function pressReset(typed: string): Promise<string> {
  await page.ev(`(()=>{document.querySelector('#console-result').textContent='';document.querySelector('#console-meta').textContent='';document.querySelector('#reset-confirm').value=${JSON.stringify(typed)};document.querySelector('#reset-send').click();return true})()`);
  await page.until(`(document.querySelector('#console-result')?.textContent??'')!==''||/not running/.test(document.querySelector('#console-meta')?.textContent??'')||!document.querySelector('#auth-error')?.hidden`);
  await sleep(200);
  return String(await page.ev(`[document.querySelector('#console-meta')?.textContent,document.querySelector('#console-result')?.textContent,document.querySelector('#auth-error')?.hidden?'':document.querySelector('#auth-error')?.textContent].filter(Boolean).join(' | ')`));
}

await page.ev(`location.href=${JSON.stringify(STUDIO)}, true`);
await page.until(signedOut);
const anaIn = await signIn('ana');
await record(page, 'sign-in', 'ana', null, 'ana signs in through the token field; the bar names her and her role', 'header', { signedIn: anaIn }, null, 260);

for (const plan of PLANS) {
  const w = plan.world;
  if (!await page.ev(signedInAs('ana'))) await signIn('ana');
  await page.ev(rowBtn(w, 'serve'));
  const served = await page.until(`${row(w)}?.innerText.includes('stop')`);
  const svc = (await page.ev(`fetch('/api/services',{headers:{authorization:'Bearer '+sessionStorage.getItem('studio-token')}}).then(r=>r.json()).then(b=>b.services.find(s=>s.name===${JSON.stringify(w)})??null)`)) as { id: string; adminPort: number; worldPort: number } | null;
  await record(page, `${w}-serve`, 'ana', w, `ana serves ${w}; it runs on its own world port, and its admin port stays on loopback`, 'table', { served, recorded: svc !== null }, null, 420);
  if (svc === null) break;

  const seed = await stateHash(svc.adminPort);
  await record(admin, `${w}-seed-hash`, 'ana', w, `the world's admin console reads the seed state hash`, 'body', { hash: seed !== null }, seed, 300);

  await page.ev(explore(w));
  await page.until(explored(w));
  const read = await consoleCall('GET', plan.read, null);
  const target = read.status === 200 ? plan.pick(read.body) : '';
  await record(page, `${w}-legal-read`, 'ana', w, `a legal read through the API console: GET ${plan.read}, the world's real 200 and body`, '#console-meta', { status200: read.status === 200, picked: target !== '' });

  const legal = plan.legal(target);
  const wrote = await consoleCall('PATCH', legal.path, legal.body);
  await record(page, `${w}-legal-write`, 'ana', w, `a legal write: PATCH ${legal.path} ${JSON.stringify(legal.body)}, answered 200 with the changed record`, '#console-meta', { status200: wrote.status === 200 });
  const afterLegal = await stateHash(svc.adminPort);
  await record(admin, `${w}-hash-after-write`, 'ana', w, 'the state hash moved with the legal write', 'body', { moved: afterLegal !== null && afterLegal !== seed }, afterLegal, 300);

  const illegal = plan.illegal(target);
  const refused = await consoleCall('PATCH', illegal.path, illegal.body);
  await record(page, `${w}-illegal-write`, 'ana', w, `an illegal write: PATCH ${illegal.path} ${JSON.stringify(illegal.body)}. Its legal half is not applied either: 422 ${illegal.code}`, '#console-meta', { status422: refused.status === 422, code: refused.body?.error?.code === illegal.code });
  const afterIllegal = await stateHash(svc.adminPort);
  await record(admin, `${w}-hash-unchanged`, 'ana', w, 'the state hash after the 422 is the hash before it', 'body', { unchanged: afterIllegal !== null && afterIllegal === afterLegal }, afterIllegal, 300);
  const reread = await consoleCall('GET', illegal.path, null);
  await record(page, `${w}-read-after-422`, 'ana', w, `GET ${illegal.path}: the record holds the legal write and nothing of the refused one`, '#console-meta', { status200: reread.status === 200, kept: reread.status === 200 && plan.kept(reread.body) });

  const unconfirmed = await pressReset('');
  const unconfirmedCalls = await record(page, `${w}-reset-refused`, 'ana', w, 'reset without the typed name: refused, and nothing changes', '#console-meta', { refused: unconfirmed.includes('reset.confirm') }, null, 360);
  const stillHash = await stateHash(svc.adminPort);
  steps[steps.length - 1]!.stateHash = stillHash;
  steps[steps.length - 1]!.checks['unchanged'] = stillHash === afterIllegal && unconfirmedCalls.some((c) => c.path.endsWith('/reset') && c.status === 400);
  steps[steps.length - 1]!.ok = Object.values(steps[steps.length - 1]!.checks).every(Boolean);

  const confirmed = await pressReset(w);
  const resetHash = (/state (\S+)$/.exec(confirmed) ?? [])[1] ?? null;
  const reseeded = await stateHash(svc.adminPort);
  await record(page, `${w}-reset`, 'ana', w, `reset with the typed name: the world is back at its seed hash`, '#console-meta', { answered: resetHash !== null, seedHash: resetHash === seed && reseeded === seed }, resetHash, 360);

  const vicIn = await signIn('vic');
  await page.ev(explore(w));
  await page.until(explored(w));
  const viewer = await pressReset(w);
  const vicCalls = await record(page, `${w}-viewer-refused`, 'vic', w, 'vic, a viewer in the same tenant, types the name and presses reset: 403', 'header', { signedIn: vicIn, forbidden: viewer.includes("Your role can't do this. Ask an admin for access.") }, null, 300);
  const afterViewer = await stateHash(svc.adminPort);
  steps[steps.length - 1]!.stateHash = afterViewer;
  steps[steps.length - 1]!.checks['status403'] = vicCalls.some((c) => c.path === `/api/services/${svc.id}/reset` && c.status === 403);
  steps[steps.length - 1]!.checks['unchanged'] = afterViewer === seed;
  steps[steps.length - 1]!.ok = Object.values(steps[steps.length - 1]!.checks).every(Boolean);

  const bobIn = await signIn('bob');
  await page.ev(explore(w));
  await page.until(explored(w));
  const other = await pressReset(w);
  // The page sees no such service for bob; the studio, asked directly for ana's service id, answers 404.
  await page.ev(`fetch('/api/services/'+${JSON.stringify(svc.id)}+'/reset',{method:'POST',headers:{authorization:'Bearer '+sessionStorage.getItem('studio-token'),'content-type':'application/json'},body:JSON.stringify({confirm:${JSON.stringify(w)}})}).then(r=>r.status)`);
  const bobCalls = await record(page, `${w}-other-tenant`, 'bob', w, `bob, an operator in another tenant: ${w} is not running for him, and a reset of ana's service id answers 404`, '#console-meta', { signedIn: bobIn, notRunning: other.includes('is not running') }, null, 360);
  const afterOther = await stateHash(svc.adminPort);
  steps[steps.length - 1]!.stateHash = afterOther;
  steps[steps.length - 1]!.checks['status404'] = bobCalls.some((c) => c.path === `/api/services/${svc.id}/reset` && c.status === 404 && (c.answer as any)?.error?.code === 'service.unknown');
  steps[steps.length - 1]!.checks['unchanged'] = afterOther === seed;
  steps[steps.length - 1]!.ok = Object.values(steps[steps.length - 1]!.checks).every(Boolean);

  await signIn('ana');
  await page.ev(rowBtn(w, 'stop'));
  const stopped = await page.until(`${row(w)}?.innerText.includes('serve')&&!${row(w)}?.innerText.includes('stop')`);
  await record(page, `${w}-stop`, 'ana', w, `ana stops ${w}`, 'table', { stopped }, null, 420);
}

const errors = [...page.errors, ...admin.errors];
writeFileSync(path.join(OUT, 'steps.json'), `${JSON.stringify({ studio: 'a scratch studio on loopback, signed in from a users file of three', people: PEOPLE, pageErrors: errors, steps }, null, 2)}\n`);
const broke = steps.filter((s) => !s.ok).length;
console.log(`${steps.length - broke} of ${steps.length} steps ok, ${errors.length} page errors; ${OUT}/steps.json`);
process.exit(broke > 0 || errors.length > 0 ? 1 : 0);
