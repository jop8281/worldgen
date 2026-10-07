/**
 * Rehearses the Studio click path (research/studio-demo-runbook.md) in headless Chrome over CDP: one line per step with
 * its time, PASS or BREAK, and any page error, plus a screenshot per step. No Playwright: Chrome and Bun only.
 *
 *   bun scripts/studio-rehearse.ts [http://127.0.0.1:8787] [out-dir] [--record]
 *
 * --record also writes walkthrough.html: one captioned viewport frame per step, the recorded screen walkthrough.
 *
 * It serves and stops helpdesk through the page, so run it on a studio nobody else is driving.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const STUDIO = process.argv[2] ?? 'http://127.0.0.1:8787';
const OUT = process.argv[3] !== undefined && !process.argv[3].startsWith('--') ? process.argv[3] : path.join(tmpdir(), 'studio-rehearsal');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env['CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${path.join(OUT, 'chrome-profile')}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let target: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = ((await (await fetch('http://127.0.0.1:9333/json')).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page'); } catch {}
}
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
const shot = async (name: string) => writeFileSync(`${OUT}/${name}.png`, Buffer.from((await cdp('Page.captureScreenshot', { captureBeyondViewport: true })).result.data, 'base64'));
await cdp('Runtime.enable'); await cdp('Page.enable');
const RECORD = process.argv.includes('--record');
const frames: { name: string; caption: string; ms: number; ok: boolean; jpeg: string }[] = [];
const log: string[] = [];
/** One step: act, wait until `waitFor` holds, then a full-page PNG; with --record, also a captioned viewport frame of `focus`. */
const step = async (name: string, caption: string, act: string, waitFor: string, focus = 'body') => {
  const t0 = Date.now(); const e0 = errors.length;
  await ev(act);
  const w = await until(waitFor);
  const ms = Date.now() - t0;
  await shot(name);
  if (RECORD) {
    await ev(`document.querySelector(${JSON.stringify(focus)})?.scrollIntoView({block:'start'}), true`);
    const jpeg = (await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 60 })).result.data as string;
    frames.push({ name, caption, ms, ok: w >= 0, jpeg });
  }
  const line = `${w < 0 ? 'BREAK' : 'ok   '} ${String(ms).padStart(6)}ms ${name}${errors.length > e0 ? ' | page errors: ' + errors.slice(e0).join(' / ').slice(0, 200) : ''}`;
  log.push(line); console.log(line);
};
const click = (sel: string) => `document.querySelector(${JSON.stringify(sel)})?.click(), true`;
const rowBtn = (world: string, text: string) => `(()=>{const r=[...document.querySelectorAll('tr')].find(t=>t.cells[0]?.textContent.trim()===${JSON.stringify(world)});const b=r&&[...r.querySelectorAll('button')].find(b=>b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(text)}));b?.click();return !!b})()`;
const row = (world: string) => `[...document.querySelectorAll('tr')].find(t=>t.cells[0]?.textContent.trim()===${JSON.stringify(world)})`;
const explore = (world: string) => `(()=>{const s=document.querySelector('#explorer-world');s.value=${JSON.stringify(world)};s.dispatchEvent(new Event('change'));document.querySelector('#explorer-load').click();return true})()`;
const consoleSend = (method: string, p: string, body = '') => `(()=>{document.querySelector('#console-method').value=${JSON.stringify(method)};document.querySelector('#console-path').value=${JSON.stringify(p)};document.querySelector('#console-body').value=${JSON.stringify(body)};document.querySelector('#console-send').click();return true})()`;
const section = (n: number) => `section:nth-of-type(${n})`;

await step('01-dashboard', 'Worlds: every world with its kind, tasks, wid, model, cost and attempts', `location.href=${JSON.stringify(STUDIO)}, true`, `document.querySelectorAll('tr').length>5`);
await step('02-serve-helpdesk', 'Serve helpdesk: it runs on its own world port; the admin port stays private', rowBtn('helpdesk', 'serve'), `${row('helpdesk')}?.innerText.includes('stop')`, 'table');
await step('03-explorer-helpdesk', 'Explorer: entities and references, routes and actions, jobs, and tasks as an agent is told them', explore('helpdesk'), `document.body.innerText.includes('ticket_event')&&document.body.innerText.includes('escalate_breached')`, section(2));
await step('04-console-get', 'API console: a real GET on the world port, answered 200 with three open tickets', consoleSend('GET', '/tickets?status=open&limit=3'), `/HTTP 200 /.test(document.body.innerText)&&document.body.innerText.includes('tkt_')`, '#console-form');
await step('05-console-illegal-write', 'A wrong write: an illegal status move is refused whole, 422 state.transition', consoleSend('PATCH', '/tickets/tkt_0001', '{"status":"new","priority":"low"}'), `/HTTP 422 /.test(document.body.innerText)&&document.body.innerText.includes('state.transition')`, '#console-form');
await step('06-explorer-generated', 'A generated world: gen-library-loans, built by WorldGen from two CSV files', explore('gen-library-loans'), `document.body.innerText.includes('/loans/{id}/pay_fine')`, section(2));
await step('07-report', 'Its REPORT.md: what was built, assumed and left out, the task proofs and the decoys', rowBtn('gen-library-loans', 'report'), `document.body.innerText.includes('Decoys:')&&!document.body.innerText.includes('report.private_source')`, '#world-report');
await step('08-export', 'Export: the world as a zip of world.yaml, plan.yaml, REPORT.md and capsule.json', `fetch('/api/worlds/gen-library-loans/export').then(r=>{window.__export=r.status+' '+r.headers.get('content-type')}), true`, `window.__export==='200 application/zip'`, 'table');
await step('09-eval', 'Eval: the rehearsal suites with their pass rates', `document.querySelector(${JSON.stringify(section(4))})?.scrollIntoView(), true`, `/\\d+\\/\\d+ \\(\\d+%\\)/.test(document.querySelector(${JSON.stringify(section(4))})?.innerText??'')`, section(4));
await step('10-spend', 'Spend: today and all-time LLM and sandbox cost, by day, and the caps', click('#spend-refresh'), `/llm/.test(document.querySelector(${JSON.stringify(section(5))})?.innerText??'')`, section(5));
await step('11-stop-helpdesk', 'Clean up: stop the served world', `(()=>{const b=[...${row('helpdesk')}.querySelectorAll('button')].find(b=>/^stop/i.test(b.textContent.trim()));b?.click();return !!b})()`, `${row('helpdesk')}?.innerText.includes('serve')`, 'table');
await step('12-reload', 'Reload: the same state, nothing left running', `location.reload(), true`, `document.querySelectorAll('tr').length>5&&!${row('helpdesk')}?.innerText.includes('stop')`);
writeFileSync(`${OUT}/log.txt`, log.join('\n') + '\n\nall page errors:\n' + errors.join('\n'));
if (RECORD) {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const slides = frames.map((f, i) => `<figure id="s${i}"><img src="data:image/jpeg;base64,${f.jpeg}" alt="${esc(f.caption)}"><figcaption><b>${i + 1}. ${esc(f.name)}</b> ${esc(f.caption)} <span>${f.ok ? 'ok' : 'BREAK'}, ${f.ms} ms</span></figcaption></figure>`).join('\n');
  writeFileSync(`${OUT}/walkthrough.html`, `<title>Studio walkthrough</title><style>body{font:14px system-ui;margin:16px;background:#fafafa}figure{margin:0 0 28px}img{max-width:100%;border:1px solid #ccc}figcaption{margin-top:6px}span{color:#666}</style>\n<h1>WorldGen Studio walkthrough</h1><p>${esc(STUDIO)}, ${new Date().toISOString()}, ${errors.length} page errors</p>\n${slides}\n`);
  console.log(`walkthrough: ${OUT}/walkthrough.html`);
}
console.log(`page errors total: ${errors.length}, screenshots in ${OUT}`);
const broke = log.some((l) => l.startsWith('BREAK'));
ws.close(); chrome.kill();
process.exit(broke || errors.length > 0 ? 1 : 0);
