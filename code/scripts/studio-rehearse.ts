/**
 * Rehearses the Studio click path (research/studio-demo-runbook.md) in headless Chrome over CDP: one line per step with
 * its time, ok or BREAK, and any page error, plus a screenshot per step. No Playwright: Chrome and Bun only.
 *
 *   bun scripts/studio-rehearse.ts [out-dir] [--record] [--viewport]
 *
 * --record also writes walkthrough.html: one captioned viewport frame per step, the recorded screen walkthrough.
 * --viewport makes each step's PNG the browser viewport scrolled to that step's section, instead of the full page.
 *
 * It starts its own signed-in studio on a free loopback port, on a scratch copy of prod/worlds, from a scratch users file
 * with four people: ada (admin, tenant ops) walks the click path, ana (operator, tenant acme) sees a sensitive field
 * masked and retries a job with one Idempotency-Key, vic (viewer, acme) meets the role refusals, and bob (operator,
 * tenant globex) shows that he sees neither team's runs. Their tokens are random, live only in this process, and are
 * typed into the page's sign-in form as a person would. It serves and stops helpdesk, uploads a spec into the scratch
 * copy, opens an iterate form without sending it, and runs free noop episodes, which it leaves under eval/episodes.
 * No model is called.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (/^https?:\/\//.test(positional[0] ?? '')) {
  console.error('studio-rehearse starts its own signed-in studio now; give only an output directory, not a studio URL');
  process.exit(2);
}
const OUT = positional[0] ?? path.join(tmpdir(), 'studio-rehearsal');
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The people of the scratch studio. ada walks the click path; ana and bob are two teams that must not see each other. */
const USERS = [
  { name: 'ada', role: 'admin', tenant: 'ops' },
  { name: 'ana', role: 'operator', tenant: 'acme' },
  { name: 'bob', role: 'operator', tenant: 'globex' },
  { name: 'vic', role: 'viewer', tenant: 'acme' },
] as const;
type Name = (typeof USERS)[number]['name'];
const tokens = new Map<Name, string>(USERS.map((u) => [u.name, randomBytes(24).toString('hex')]));
const token = (name: Name): string => tokens.get(name)!;
const usersFile = path.join(OUT, 'users.json');
writeFileSync(usersFile, JSON.stringify({ users: USERS.map((u) => ({ ...u, token_sha256: createHash('sha256').update(token(u.name)).digest('hex') })) }), { mode: 0o600 });

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const a = probe.address(); probe.close(() => resolve(typeof a === 'object' && a !== null ? a.port : 0)); });
});
const studioPort = await freePort();
const STUDIO = `http://127.0.0.1:${studioPort}`;
// The studio refuses --users together with WORLDGEN_STUDIO_TOKEN, and the rehearsal never needs a model key.
const studioEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WORLDGEN_STUDIO_TOKEN' && k !== 'LLM_KEY'));
// A scratch copy of the worlds, so an upload, a served world's state and the job registry never touch prod/worlds.
const WORLDS = mkdtempSync(path.join(tmpdir(), 'studio-rehearse-worlds-'));
cpSync(path.join(CODE_DIR, '..', 'prod', 'worlds'), WORLDS, { recursive: true, filter: (src) => !path.basename(src).startsWith('.studio-') });
const studio = spawn(process.execPath, ['src/cli/studio.ts', '--port', String(studioPort), '--users', usersFile, '--worlds-dir', WORLDS, '--repo-root', path.join(CODE_DIR, '..')], { cwd: CODE_DIR, env: studioEnv, stdio: 'ignore', detached: true });

const CHROME = process.env['CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(OUT, 'chrome-profile');
// Port 0 lets Chrome pick a free port and write it to DevToolsActivePort; a fixed port can reach another session's Chrome.
rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
// Every exit, a crash or Ctrl-C included, stops Chrome and the studio and removes the users file. The studio leads its
// own process group, so one signal to the group also reaches each world it serves or checks.
process.on('exit', () => {
  chrome.kill();
  try { process.kill(-studio.pid!, 'SIGTERM'); } catch {}
  rmSync(usersFile, { force: true });
  rmSync(WORLDS, { recursive: true, force: true });
});
process.on('SIGINT', () => process.exit(130));
const finish = (code: number): never => process.exit(code);

let healthy = false;
for (let i = 0; i < 100 && !healthy; i++) {
  await sleep(200);
  try { healthy = (await fetch(`${STUDIO}/api/health`)).ok; } catch {}
}
if (!healthy) { console.error(`the scratch studio on ${STUDIO} never answered /api/health (exit ${studio.exitCode})`); finish(1); }
console.log(`signed-in scratch studio on ${STUDIO}, pid ${studio.pid}: ${USERS.map((u) => `${u.name} (${u.role}, ${u.tenant})`).join(', ')}`);

let target: { webSocketDebuggerUrl: string } | undefined;
let port = '';
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try {
    port = readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]!;
    target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page');
  } catch {}
}
if (!target) { console.error(`no devtools page from Chrome (port '${port}', exit ${chrome.exitCode})`); finish(1); }
console.log(`chrome devtools on 127.0.0.1:${port}, pid ${chrome.pid}`);
const ws = new WebSocket(target!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
const errors: string[] = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id !== undefined) pending.get(m.id)?.(m);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a: any) => a.value ?? a.description).join(' '));
});
const cdp = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr: string) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const until = async (expr: string, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return Date.now() - t; await sleep(150); } return -1; };
const RECORD = process.argv.includes('--record');
const VIEWPORT = process.argv.includes('--viewport');
const scrollTo = (focus: string) => ev(`document.querySelector(${JSON.stringify(focus)})?.scrollIntoView({block:'start'}), true`);
const shot = async (name: string, focus: string) => {
  if (VIEWPORT) await scrollTo(focus);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from((await cdp('Page.captureScreenshot', { captureBeyondViewport: !VIEWPORT })).result.data, 'base64'));
};
await cdp('Runtime.enable'); await cdp('Page.enable');
// The light scheme, whatever the machine's appearance, so a capture is the same on every Mac.
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
const frames: { name: string; caption: string; ms: number; ok: boolean; jpeg: string }[] = [];
const log: string[] = [];
/**
 * One step: act, wait up to `wait` ms until `waitFor` holds, run `after` (such as scrolling a pane to the line the frame
 * is about), then a PNG (full page, or `focus` with --viewport); with --record, also a captioned viewport frame of `focus`.
 */
const step = async (name: string, caption: string, act: string, waitFor: string, focus = 'body', wait = 20000, after?: string) => {
  const t0 = Date.now(); const e0 = errors.length;
  await ev(act);
  const w = await until(waitFor, wait);
  const ms = Date.now() - t0;
  if (after !== undefined) await ev(after);
  await shot(name, focus);
  if (RECORD) {
    await scrollTo(focus);
    const jpeg = (await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 60 })).result.data as string;
    frames.push({ name, caption, ms, ok: w >= 0, jpeg });
  }
  const line = `${w < 0 ? 'BREAK' : 'ok   '} ${String(ms).padStart(6)}ms ${name}${errors.length > e0 ? ' | page errors: ' + errors.slice(e0).join(' / ').slice(0, 200) : ''}`;
  log.push(line); console.log(line);
};
/** Fetch options carrying the signed-in token, as the page's own requests do. */
const AUTH = `{headers:{authorization:'Bearer '+sessionStorage.getItem('studio-token')}}`;
const click = (sel: string) => `document.querySelector(${JSON.stringify(sel)})?.click(), true`;
const rowBtn = (world: string, text: string) => `(()=>{const r=[...document.querySelectorAll('tr')].find(t=>t.cells[0]?.textContent.trim()===${JSON.stringify(world)});const b=r&&[...r.querySelectorAll('button')].find(b=>b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text)}));b?.click();return !!b})()`;
const row = (world: string) => `[...document.querySelectorAll('tr')].find(t=>t.cells[0]?.textContent.trim()===${JSON.stringify(world)})`;
const explore = (world: string) => `(()=>{const s=document.querySelector('#explorer-world');s.value=${JSON.stringify(world)};s.dispatchEvent(new Event('change'));document.querySelector('#explorer-load').click();return true})()`;
const consoleSend = (method: string, p: string, body = '') => `(()=>{document.querySelector('#console-method').value=${JSON.stringify(method)};document.querySelector('#console-path').value=${JSON.stringify(p)};document.querySelector('#console-body').value=${JSON.stringify(body)};document.querySelector('#console-send').click();return true})()`;
const section = (n: number) => `section:nth-of-type(${n})`;
/** Picks `world` in the Agent Playground, waits until its tasks have loaded (loading clears the proof table), then asks for the engine proof. */
const proof = (world: string) => `(async()=>{const s=document.querySelector('#play-world');s.value=${JSON.stringify(world)};s.dispatchEvent(new Event('change'));const first=(await (await fetch('/api/worlds/'+${JSON.stringify(world)}+'/tasks',${AUTH})).json()).tasks[0].id;for(let i=0;i<100&&document.querySelector('#play-task').value!==first;i++)await new Promise(r=>setTimeout(r,100));document.querySelector('#play-proof').click();return true})()`;
const signedOut = `!!document.querySelector('#signin-form')&&!document.querySelector('#signin-form').hidden`;
/** Navigates after marking the old document, so a wait that adds `fresh` cannot pass on the page being replaced. */
const navigate = (to: string) => `(window.__old=true, ${to}, true)`;
const fresh = `!window.__old`;
const typeToken = (name: Name) => `(()=>{document.querySelector('#signin-token').value=${JSON.stringify(token(name))};document.querySelector('#signin-form').requestSubmit();return true})()`;
const signedInAs = (name: Name) => `document.querySelector('#who')?.textContent===${JSON.stringify(`${name} (${USERS.find((u) => u.name === name)!.role})`)}`;
/** Signs out through the page, then signs `name` in through its token form; false when either half, or the worlds table, never shows. */
const switchTo = async (name: Name): Promise<boolean> => {
  await ev(click('#signout'));
  if (await until(signedOut) < 0) return false;
  await ev(typeToken(name));
  return await until(`${signedInAs(name)}&&document.querySelectorAll('#worlds-table tr').length>5`) >= 0;
};
const NOOP_BODY = JSON.stringify({ world: 'helpdesk', task: 'assign_newest_acme_ticket', agent: 'noop', budgetUsd: 0.01, maxTurns: 3 });
/** Two POSTs with one Idempotency-Key, then a wait until the one episode they started has finished. */
const retry = (key: string) => `(async()=>{const h={authorization:'Bearer '+sessionStorage.getItem('studio-token'),'content-type':'application/json','idempotency-key':${JSON.stringify(key)}};const body=${JSON.stringify(NOOP_BODY)};const a=await fetch('/api/episodes',{method:'POST',headers:h,body});const ab=await a.json();const b=await fetch('/api/episodes',{method:'POST',headers:h,body});const bb=await b.json();for(let i=0;i<240;i++){const s=await (await fetch('/api/episodes/'+encodeURIComponent(ab.runId),${AUTH})).json();if(s.running===false)break;await new Promise(r=>setTimeout(r,250))}window.__retry=(a.status===200&&b.status===200&&ab.runId&&ab.runId===bb.runId&&ab.replayed===false&&bb.replayed===true)?'same '+ab.runId:JSON.stringify([a.status,ab,b.status,bb]).slice(0,300);return true})()`;

await ev(`location.href=${JSON.stringify(STUDIO)}, true`);
await until(signedOut);
const text = (sel: string) => `(document.querySelector(${JSON.stringify(sel)})?.textContent??'')`;
const typeInto = (sel: string, value: string, event = 'input') => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event(${JSON.stringify(event)}));return true})()`;
const SENSITIVE = 'Hidden because this world has sensitive fields. Ask an admin to open it.';
const FORBIDDEN = "Your role can't see this. Ask an admin for access.";
// The talk (research/studio-demo-runbook.md), in its order. ada, the admin, walks it first.
await step('01-sign-in', 'Sign in: the studio asks for a token, then names who is signed in and offers Sign out', typeToken('ada'), `${signedInAs('ada')}&&document.querySelectorAll('#worlds-table tr').length>5`, 'header');
await step('02-dashboard', 'Worlds: every world with its kind, tasks, wid, model, cost and attempts, and serve, report, plan, export and iterate', navigate(`location.href=${JSON.stringify(STUDIO)}`), `${fresh}&&${signedInAs('ada')}&&document.querySelectorAll('#worlds-table tr').length>5`, '#sec-worlds');
await step('03-filter', 'Filter: typing gen-stripe keeps the two Stripe worlds and the count reads 2 of all', typeInto('#worlds-filter', 'gen-stripe'), `/^2 of \\d+$/.test(${text('#worlds-meta')})`, '#sec-worlds');
await step('04-serve-helpdesk', 'Serve helpdesk: it runs on its own world port; the admin port stays private', `(${typeInto('#worlds-filter', '')}, ${rowBtn('helpdesk', 'serve')})`, `${row('helpdesk')}?.innerText.includes('stop')`, '#sec-worlds');
await step('05-explorer', 'Explorer: entities and references, the ticket workflow with its moves, seed rows by state, routes, jobs and tasks', explore('helpdesk'), `${text('#explorer-body')}.includes('ticket.status')&&${text('#explorer-body')}.includes('by state')&&${text('#explorer-body')}.includes('escalate_breached')`, '#sec-explorer');
await step('06-openapi', 'OpenAPI: the served world answers its own GET /openapi.json', click('#console-openapi'), `${text('#console-result')}.includes('HTTP 200')&&${text('#console-result')}.includes('openapi')`, '#console-meta');
await step('07-console-get', 'API console: a real GET on the world port, answered 200 with three open tickets', consoleSend('GET', '/tickets?status=open&limit=3'), `${text('#console-result')}.includes('HTTP 200')&&${text('#console-result')}.includes('tkt_')`, '#console-meta');
const before = String(await ev(`(()=>{try{return JSON.parse(document.querySelector('#console-result pre').textContent).data.find(t=>t.id==='tkt_0001')?.priority??'?'}catch(e){return '?'}})()`) ?? '?');
const illegalPriority = before === 'urgent' ? 'low' : 'urgent';
await step('08-console-422', `A wrong write: an illegal status move with a legal priority change is refused whole, 422 state.transition`, consoleSend('PATCH', '/tickets/tkt_0001', `{"status":"new","priority":"${illegalPriority}"}`), `${text('#console-result')}.includes('HTTP 422')&&${text('#console-result')}.includes('state.transition')`, '#console-meta');
await step('09-read-after-422', `The same ticket read back: its priority is still ${before}, so the legal half was not applied either`, consoleSend('GET', '/tickets/tkt_0001'), `${text('#console-result')}.includes('HTTP 200')&&${text('#console-result')}.includes('"priority": "${before}"')`, '#console-meta');
await step('10-reset-refused', 'Reset with the name box empty: refused, and nothing changes', `(${typeInto('#reset-confirm', '')}, ${click('#reset-send')})`, `${text('#console-result')}.includes('a reset throws away every change')`, '#console-meta');
await step('11-reset', 'Reset with the typed name: the world is back at its seed', `(${typeInto('#reset-confirm', 'helpdesk')}, ${click('#reset-send')})`, `${text('#console-result')}.includes('reset to its seed')`, '#console-meta');
await step('12-builder-kind', 'World Builder: kind openapi lists the specs under eval/inputs and offers an upload', typeInto('#gen-kind', 'openapi', 'change'), `!document.querySelector('#gen-openapi-row').hidden&&document.querySelectorAll('#gen-spec option').length>0`, '#sec-generation');
// The file chooser is the OS's; CDP hands the input the file a person would pick.
const doc = await cdp('DOM.getDocument');
const fileInput = await cdp('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#gen-spec-file' });
await cdp('DOM.setFileInputFiles', { nodeId: fileInput.result.nodeId, files: [path.join(CODE_DIR, '..', 'eval', 'inputs', 'petstore.openapi.yaml')] });
await step('13-builder-upload', 'Upload a spec: it is checked, kept for this tenant, picked, and its paths offered for --only; generate is not pressed', click('#gen-spec-upload'), `${text('#gen-spec-note')}.startsWith('uploaded petstore.openapi.yaml')&&document.querySelector('#gen-spec').value.startsWith('upload:')&&document.querySelectorAll('input[name=gen-only-path]').length>0`, '#sec-generation');
await step('14-plan', 'A generated world\'s plan: its assumptions, open questions, what is out of scope, and plan.md', rowBtn('gen-library-loans', 'plan'), `${text('#world-plan')}.includes('assumptions')&&${text('#world-plan')}.includes('plan.md')`, '#world-plan');
await step('15-iterate-form', 'Iterate: a change request for a world runs on a copy; the form is shown and cancelled here, since sending it starts a paid run', `(${rowBtn('gen-library-loans', 'plan')}, ${rowBtn('gen-stripe-customers', 'iterate')}, ${typeInto('#iterate-change', 'Give each customer a status of active or archived')})`, `!document.querySelector('#iterate-form').hidden&&${text('#iterate-world')}==='gen-stripe-customers'`, '#iterate-form');
await step('16-iterate-result', 'A finished iterate: gen-stripe-customers\' REPORT.md lists what its change request changed (run_20261007T165640Z_1022e845)', `(${click('#iterate-cancel')}, ${rowBtn('gen-stripe-customers', 'report')})`, `document.querySelector('#iterate-form').hidden&&${text('#world-report')}.includes('## Changes')&&${text('#world-report')}.includes('field_added')`, '#world-report', 20000,
  `(()=>{const pre=document.querySelector('#world-report');const n=pre.firstChild;const i=pre.textContent.indexOf('## Changes');if(!n||i<0)return false;const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);pre.scrollTop+=r.getBoundingClientRect().top-pre.getBoundingClientRect().top-8;return true})()`);
await step('17-proof', 'Engine proof: per helpdesk task, the reference solution scores 1, doing nothing 0, near misses and decoys below 1, and the replay is identical', proof('helpdesk'), `${text('#play-proof-table')}.includes('every task verified')`, '#sec-playground', 120000);
await step('18-noop-episode', 'Agent Playground: a free noop agent on the first helpdesk task, graded by the engine from the end state', `(document.querySelector('#play-agent').value='noop', document.querySelector('#play-run').click(), true)`, `!!document.querySelector('#episode-view table')`, '#episodes-meta', 120000);
const adaRun = String(await ev(`(document.querySelector('#episode-view h3')?.textContent??'').replace(/^episode /,'').replace(/ \\(running\\)$/,'')`) ?? '');
await step('19-spend', 'Spend: today and all-time LLM and sandbox cost, by day, and the caps; only an admin sees it', click('#spend-refresh'), `/llm/.test(${text('#spend-body')})`, '#sec-spend');
await step('20-stop-helpdesk', 'ada stops her served helpdesk', `(()=>{const b=[...${row('helpdesk')}.querySelectorAll('button')].find(b=>/^stop/i.test(b.textContent.trim()));b?.click();return !!b})()`, `${row('helpdesk')}?.innerText.includes('serve')`, '#sec-worlds');
// ana, an operator: no Spend or Eval, and a sensitive field masked in a world's answer.
const anaIn = await switchTo('ana');
await step('21-operator-serve', 'ana (operator, acme) signs in: Spend and Eval are not on her page; she serves helpdesk for her team', anaIn ? rowBtn('helpdesk', 'serve') : 'false', `${signedInAs('ana')}&&document.querySelector('#sec-spend').hidden&&document.querySelector('#sec-eval').hidden&&${row('helpdesk')}?.innerText.includes('stop')`, '#sec-worlds');
await step('22-operator-masked', 'Her console GET /customers: each customer\'s email reads [sensitive], since email is a sensitive field and she is no admin', `(${explore('helpdesk')}, setTimeout(()=>{${consoleSend('GET', '/customers?limit=2')}},1500), true)`, `${text('#console-result')}.includes('HTTP 200')&&${text('#console-result')}.includes('[sensitive]')`, '#console-meta');
await step('23-operator-stop', 'ana stops her served helpdesk', `(()=>{const b=[...${row('helpdesk')}.querySelectorAll('button')].find(b=>/^stop/i.test(b.textContent.trim()));b?.click();return !!b})()`, `${row('helpdesk')}?.innerText.includes('serve')`, '#sec-worlds');
// vic, a viewer: the page shows what his role cannot do, in words.
const vicIn = await switchTo('vic');
await step('24-viewer-report', 'vic (viewer, acme) opens helpdesk\'s report: hidden, because the world has sensitive fields', vicIn ? rowBtn('helpdesk', 'report') : 'false', `${signedInAs('vic')}&&${text('#world-report')}===${JSON.stringify(SENSITIVE)}`, '#sec-worlds');
await step('25-viewer-serve', 'He presses serve: his role cannot serve a world, and the page says so', rowBtn('helpdesk', 'serve'), `${text('#worlds-note')}===${JSON.stringify(FORBIDDEN)}&&document.querySelector('#sec-spend').hidden`, '#sec-worlds');

// Beyond the talk: one job per Idempotency-Key, and a team that sees no other team's runs.
const anaAgain = await switchTo('ana');
await step('26-idempotent-retry', 'ana (acme) retries one job request: two POSTs with one Idempotency-Key start one noop episode, and the second answer replays the first', anaAgain ? retry(`rehearse-${randomBytes(4).toString('hex')}`) : 'false', `typeof window.__retry==='string'&&window.__retry.startsWith('same ')`, '#episodes-meta', 90000);
const retried = String(await ev('window.__retry') ?? 'missing');
const anaRun = retried.startsWith('same ') ? retried.slice(5) : '';
const bobIn = await switchTo('bob');
await step('27-other-tenant', 'bob (globex) signs in: his Episodes list holds neither ana\'s acme run nor ada\'s ops run', 'true',
  `${bobIn}&&${signedInAs('bob')}&&/^0 episode run/.test(document.querySelector('#episodes-meta')?.textContent??'')&&!document.body.innerText.includes(${JSON.stringify(anaRun || 'missing-ana-run')})&&!document.body.innerText.includes(${JSON.stringify(adaRun || 'missing-ada-run')})&&${JSON.stringify(anaRun !== '' && adaRun !== '')}`, '#episodes-meta');

const proved = `ada's ops run ${adaRun || 'missing'}; ana's acme retry: ${retried}; bob's episodes: ${await ev(`document.querySelector('#episodes-meta')?.textContent`) ?? 'missing'}`;
log.push(proved); console.log(proved);
writeFileSync(`${OUT}/log.txt`, log.join('\n') + '\n\nall page errors:\n' + errors.join('\n'));
if (RECORD) {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const slides = frames.map((f, i) => `<figure id="s${i}"><img src="data:image/jpeg;base64,${f.jpeg}" alt="${esc(f.caption)}"><figcaption><b>${i + 1}. ${esc(f.name)}</b> ${esc(f.caption)} <span>${f.ok ? 'ok' : 'BREAK'}, ${f.ms} ms</span></figcaption></figure>`).join('\n');
  writeFileSync(`${OUT}/walkthrough.html`, `<title>Studio walkthrough</title><style>body{font:14px system-ui;margin:16px;background:#fafafa}figure{margin:0 0 28px}img{max-width:100%;border:1px solid #ccc}figcaption{margin-top:6px}span{color:#666}</style>\n<h1>WorldGen Studio walkthrough</h1><p>${esc(STUDIO)}, ${new Date().toISOString()}, ${errors.length} page errors</p>\n${slides}\n`);
  console.log(`walkthrough: ${OUT}/walkthrough.html`);
}
console.log(`page errors total: ${errors.length}, screenshots in ${OUT}`);
const broke = log.some((l) => l.startsWith('BREAK'));
ws.close();
finish(broke || errors.length > 0 ? 1 : 0);
