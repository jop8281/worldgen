/**
 * Probes the Studio page's keyboard path, accessible names, worlds filter and resume-after-refresh (YOS-187), and its error
 * states, 400px layout and focus rings (YOS-209), in headless Chrome over CDP. It starts its own studio child (an admin and a
 * viewer from a users file, a temp copy of helpdesk) and its own Chrome, prints PASS or BREAK per step, writes a screenshot
 * per step, and kills only the two processes it started. A 500 and a dropped connection are forced in the browser with CDP
 * Fetch, so the studio itself is never changed. No Playwright: Chrome and Bun only.
 *
 *   bun scripts/studio-a11y-probe.ts [out-dir]
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const OUT = process.argv[2] ?? path.join(tmpdir(), 'studio-a11y-probe');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env['CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(OUT, 'chrome-profile');
const TOKEN = randomBytes(12).toString('hex');
const VIEWER_TOKEN = randomBytes(12).toString('hex');
const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The page's PROBLEM lines (src/studio/page.ts) that the forced failures must show. */
const SIGNED_OUT = 'You are signed out. Sign in again with your studio token.';
/** A viewer's refused serve is an action, so its line says do (J113). */
const FORBIDDEN = "Your role can't do this. Ask an admin for access.";
const SENSITIVE = 'Hidden because this world has sensitive fields. Ask an admin to open it.';
const SERVER = 'The studio failed on its side. Try again, and check the studio log if it keeps failing.';
const NETWORK = 'The studio did not answer. Check that it is still running, then try again.';
const RESET_CONFIRM = 'Type the world name exactly to confirm the reset.';

let studio: ChildProcess | undefined;
let chrome: ChildProcess | undefined;
let pass = 0;
let broke = 0;

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), 'a11y-probe-'));
  mkdirSync(path.join(work, 'worlds'));
  cpSync(path.join(REPO, 'prod', 'worlds', 'helpdesk'), path.join(work, 'worlds', 'helpdesk'), { recursive: true });
  // An admin for the page's own steps, and a viewer for the role refusals.
  const users = path.join(work, 'users.json');
  writeFileSync(users, JSON.stringify({ users: [
    { name: 'ada', role: 'admin', tenant: 'probe', token_sha256: sha256(TOKEN) },
    { name: 'vic', role: 'viewer', tenant: 'probe', token_sha256: sha256(VIEWER_TOKEN) },
  ] }));
  const { WORLDGEN_STUDIO_TOKEN: _unused, ...env } = process.env;
  studio = spawn('bun', ['src/cli/studio.ts', '--port', '0', '--worlds-dir', path.join(work, 'worlds'), '--repo-root', REPO, '--users', users], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let url = '';
  let buf = '';
  studio.stdout!.on('data', (d) => { buf += String(d); const m = /studio on (http:\/\/\S+)/.exec(buf); if (m) url = m[1]!; });
  for (let i = 0; i < 100 && url === ''; i++) await sleep(100);
  if (url === '') throw new Error('studio printed no URL');
  console.log(`studio ${url}`);

  rmSync(path.join(PROFILE, 'DevToolsActivePort'), { force: true });
  chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${PROFILE}`, '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let target: { webSocketDebuggerUrl: string } | undefined;
  let devPort = '';
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      devPort = readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]!;
      target = ((await (await fetch(`http://127.0.0.1:${devPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('no devtools page from Chrome');
  // Another session's Chrome may hold a debug port on this shared machine: drive only one whose listener is this Chrome.
  const owners = spawnSync('lsof', ['-nP', `-iTCP:${devPort}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  if (owners.status === 0 && !owners.stdout.split('\n').includes(String(chrome.pid))) throw new Error(`debug port ${devPort} is held by pid ${owners.stdout.trim()}, not this probe's Chrome ${chrome.pid}`);
  console.log(`chrome ${chrome.pid} on debug port ${devPort}`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  const events = new Map<string, (params: any) => void>();
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id !== undefined) pending.get(m.id)?.(m); else if (m.method !== undefined) events.get(m.method)?.(m.params); });
  const cdp = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr: string) => (await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const until = async (expr: string, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(100); } return false; };
  await cdp('Runtime.enable'); await cdp('Page.enable');
  const shot = async (name: string) => writeFileSync(`${OUT}/${name}.png`, Buffer.from((await cdp('Page.captureScreenshot')).result.data, 'base64'));
  const key = async (k: string, code: string, vk: number, text?: string) => {
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(text === undefined ? {} : { text }) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
  };
  const step = async (name: string, run: () => Promise<string | undefined>) => {
    const t0 = Date.now();
    let why: string | undefined;
    try { why = await run(); } catch (e) { why = String(e); }
    await shot(name);
    if (why === undefined) { pass++; console.log(`PASS ${name} ${Date.now() - t0}`); } else { broke++; console.log(`BREAK ${name} ${why}`); }
  };
  const unnamed = `[...document.querySelectorAll('input,select,textarea')].filter(e=>e.type!=='hidden'&&!(e.labels&&e.labels.length>0)&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')).map(e=>e.id||e.tagName)`;
  const labelCheck = async (): Promise<string | undefined> => {
    const bad = await ev(`JSON.stringify(${unnamed})`);
    return bad === '[]' ? undefined : `unnamed controls ${bad}`;
  };
  const marker = `document.querySelector('#explorer-body')?.innerText.includes('ticket_event')`;

  await step('a-keyboard-signin', async () => {
    await cdp('Page.navigate', { url });
    if (!(await until(`!document.querySelector('#signin-form').hidden`))) return 'sign-in form never shown';
    await ev(`document.activeElement&&document.activeElement.blur(),true`);
    let n = 0;
    for (; n < 40; n++) { if ((await ev(`document.activeElement&&document.activeElement.id`)) === 'signin-token') break; await key('Tab', 'Tab', 9); }
    if (n >= 40) return 'Tab never reached #signin-token in 40 presses';
    await cdp('Input.insertText', { text: TOKEN });
    await key('Tab', 'Tab', 9);
    const focused = await ev(`document.activeElement.tagName+':'+document.activeElement.textContent.trim()`);
    if (focused !== 'BUTTON:Sign in') return `focus after token was ${focused}`;
    await key('Enter', 'Enter', 13, '\r');
    if (!(await until(`document.querySelector('#who').textContent.includes('(admin)')&&!document.querySelector('#signout').hidden&&document.querySelectorAll('#worlds-table tr').length>1`))) return `not signed in: ${await ev(`document.querySelector('#who').textContent`)}`;
    return undefined;
  });
  await step('b-landmarks-and-names', async () => {
    const lm = await ev(`['header','main','nav'].map(t=>document.querySelectorAll(t).length).join()`);
    if (lm !== '1,1,1') return `landmarks header,main,nav counts ${lm}`;
    return labelCheck();
  });
  await step('c-filter', async () => {
    await ev(`(()=>{const f=document.querySelector('#worlds-filter');f.focus();return true})()`);
    await cdp('Input.insertText', { text: 'help' });
    const visible = `[...document.querySelectorAll('#worlds-table tr')].slice(1).filter(r=>!r.hidden).map(r=>r.cells[0].textContent.trim())`;
    if (!(await until(`JSON.stringify(${visible})==='["helpdesk"]'`, 3000))) return `visible rows ${await ev(`JSON.stringify(${visible})`)}`;
    const meta = await ev(`document.querySelector('#worlds-meta').textContent`);
    await ev(`(()=>{const f=document.querySelector('#worlds-filter');f.value='';f.dispatchEvent(new Event('input'));return true})()`);
    return meta === '1 of 1' ? undefined : `meta while filtered was '${meta}'`;
  });
  await step('d-explorer-hash', async () => {
    await ev(`(()=>{const s=document.querySelector('#explorer-world');s.value='helpdesk';s.dispatchEvent(new Event('change'));document.querySelector('#explorer-load').click();return true})()`);
    if (!(await until(marker))) return 'explorer never showed helpdesk';
    const h = await ev(`location.hash`);
    return h === '#world=helpdesk&view=explorer' ? undefined : `hash ${h}`;
  });
  await step('e-reload-resumes', async () => {
    await cdp('Page.reload');
    if (!(await until(marker, 20000))) return 'explorer did not resume after reload';
    const h = await ev(`location.hash`);
    return h === '#world=helpdesk&view=explorer' ? undefined : `hash ${h}`;
  });
  await step('f-names-after-reload', labelCheck);
  const text = (sel: string) => `(document.querySelector('${sel}')?.textContent??'').trim()`;
  await step('g-narrow-400', async () => {
    await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 900, deviceScaleFactor: 1, mobile: false });
    if (!(await until(`!!document.querySelector('#explorer-body table')&&!!document.querySelector('#worlds-table table')&&(!!document.querySelector('#eval-table table')||${text('#eval-table')}!=='')`))) return 'panels never loaded';
    await sleep(300);
    const r = JSON.parse(await ev(`JSON.stringify({sw:document.documentElement.scrollWidth,cw:document.documentElement.clientWidth,tables:document.querySelectorAll('table').length,
      unwrapped:[...document.querySelectorAll('table')].filter(t=>!t.parentElement.classList.contains('scroll')).length,
      scrolling:[...document.querySelectorAll('.scroll')].filter(d=>d.scrollWidth>d.clientWidth).length,
      wide:[...document.querySelectorAll('body *')].filter(e=>e.getClientRects().length>0&&!e.closest('.scroll')&&e.getBoundingClientRect().right>document.documentElement.clientWidth+1).slice(0,5).map(e=>e.tagName+'#'+e.id)})`));
    console.log(`  400px: page ${r.sw}/${r.cw}, ${r.tables} tables, ${r.scrolling} scroll inside their container`);
    if (r.sw > r.cw) return `the page scrolls sideways: scrollWidth ${r.sw} > clientWidth ${r.cw}; wide ${JSON.stringify(r.wide)}`;
    if (r.unwrapped > 0) return `${r.unwrapped} table(s) outside a scroll container`;
    return r.scrolling > 0 ? undefined : 'no table needed its own scroller at 400px, so the check proved nothing';
  });
  await cdp('Emulation.clearDeviceMetricsOverride');
  await step('h-keyboard-reach-and-rings', async () => {
    await ev(`window.scrollTo(0,0),document.activeElement&&document.activeElement.blur(),true`);
    const total = await ev(`(()=>{const all=[...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(e=>!e.disabled&&e.tabIndex>=0&&e.getClientRects().length>0&&getComputedStyle(e).visibility!=='hidden');document.querySelectorAll('[data-probe]').forEach(e=>e.removeAttribute('data-probe'));all.forEach((e,i)=>e.setAttribute('data-probe',String(i)));return all.length})()`);
    const seen = new Set<string>();
    const ringed = new Set<string>();
    const unringed = new Set<string>();
    for (let n = 0; n < 4 * total + 20 && seen.size < total; n++) {
      await key('Tab', 'Tab', 9);
      const f = JSON.parse(await ev(`(()=>{const a=document.activeElement;const s=getComputedStyle(a);return JSON.stringify({i:a.getAttribute('data-probe'),where:(a.closest('section')||a.closest('header')||a.closest('nav')||{id:'body'}).id||a.closest('header,nav')?.tagName||'body',ring:a.matches(':focus-visible')&&s.outlineStyle!=='none'&&s.outlineWidth!=='0px'})})()`));
      if (f.i !== null) seen.add(f.i);
      (f.ring ? ringed : unringed).add(f.where);
    }
    const missed = (JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('[data-probe]')].map(e=>e.getAttribute('data-probe')))`)) as string[]).filter((i) => !seen.has(i));
    const sections = ['sec-worlds', 'sec-explorer', 'sec-generation', 'sec-eval', 'sec-playground', 'sec-spend'];
    console.log(`  Tab reached ${seen.size} of ${total} controls; rings in ${[...ringed].join(', ')}`);
    if (missed.length > 0) return `Tab never reached ${missed.length} control(s): ${await ev(`JSON.stringify(${JSON.stringify(missed)}.map(i=>{const e=document.querySelector('[data-probe="'+i+'"]');return e.tagName+'#'+e.id+':'+e.textContent.trim().slice(0,20)}))`)}`;
    const noRing = sections.filter((id) => !ringed.has(id));
    return noRing.length === 0 ? undefined : `no visible focus ring in ${noRing.join(', ')}`;
  });
  await step('i-enter-and-space-activate', async () => {
    await ev(`(()=>{document.querySelector('#worlds-meta').textContent='x';document.querySelector('#worlds-refresh').focus();return true})()`);
    await key('Enter', 'Enter', 13, '\r');
    if (!(await until(`/world\\(s\\)/.test(${text('#worlds-meta')})`, 5000))) return `Enter on worlds refresh: meta ${await ev(text('#worlds-meta'))}`;
    await ev(`(()=>{document.querySelector('#explorer-meta').textContent='x';document.querySelector('#explorer-load').focus();return true})()`);
    await key(' ', 'Space', 32, ' ');
    if (!(await until(`${text('#explorer-meta')}.startsWith('definition')`, 5000))) return `Space on explore: meta ${await ev(text('#explorer-meta'))}`;
    return undefined;
  });
  await step('j-forced-500-and-network', async () => {
    events.set('Fetch.requestPaused', (p: { requestId: string; request: { url: string } }) => {
      if (p.request.url.endsWith('/api/runs')) {
        void cdp('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 500, responseHeaders: [{ name: 'content-type', value: 'application/json' }],
          body: Buffer.from('{"error":{"code":"probe.stub","message":"stubbed failure"}}').toString('base64') });
      } else void cdp('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
    });
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*/api/runs', requestStage: 'Request' }, { urlPattern: '*/api/episodes', requestStage: 'Request' }] });
    await cdp('Page.reload');
    const ok = await until(`${text('#runs-table')}===${JSON.stringify(`${SERVER} The studio said: stubbed failure`)}&&${text('#episodes-table')}===${JSON.stringify(NETWORK)}`, 10000);
    await cdp('Fetch.disable');
    events.delete('Fetch.requestPaused');
    await ev(`document.querySelector('#runs-table').scrollIntoView({block:'center'}),true`);
    return ok ? undefined : `runs '${await ev(text('#runs-table'))}', episodes '${await ev(text('#episodes-table'))}'`;
  });
  await step('k-reset-refused', async () => {
    const helpdeskButton = (label: string) => `(()=>{const r=[...document.querySelectorAll('#worlds-table tr')].find(r=>r.cells[0].textContent==='helpdesk');const b=r&&[...r.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(label)});b?.click();return !!b})()`;
    await ev(helpdeskButton('serve'));
    if (!(await until(`[...document.querySelectorAll('#worlds-table tr')].some(r=>r.cells[0].textContent==='helpdesk'&&r.textContent.includes('stop'))`, 15000))) return 'helpdesk never served';
    await ev(`(()=>{document.querySelector('#explorer-world').value='helpdesk';document.querySelector('#reset-confirm').value='';document.querySelector('#reset-send').click();return true})()`);
    const said = await until(`${text('#console-result')}===${JSON.stringify(RESET_CONFIRM)}`, 10000);
    await ev(`document.querySelector('#console-meta').scrollIntoView({block:'start'}),true`);
    const line = await ev(text('#console-result'));
    await ev(helpdeskButton('stop'));
    if (!(await until(`[...document.querySelectorAll('#worlds-table tr')].some(r=>r.cells[0].textContent==='helpdesk'&&r.textContent.includes('serve'))`, 15000))) return 'helpdesk never stopped';
    return said ? undefined : `reset with an empty box said '${line}'`;
  });
  await step('l-signed-out-401', async () => {
    await ev(`sessionStorage.setItem('studio-token','not-a-studio-token'),true`);
    await cdp('Page.reload');
    if (!(await until(`${text('#auth-error')}===${JSON.stringify(SIGNED_OUT)}&&!document.querySelector('#signin-form').hidden`, 10000))) return `auth line '${await ev(text('#auth-error'))}'`;
    await ev(`window.scrollTo(0,0),true`);
    return (await until(`${text('#worlds-table')}===${JSON.stringify(SIGNED_OUT)}`, 5000)) ? undefined : `worlds panel '${await ev(text('#worlds-table'))}'`;
  });
  await step('m-viewer-403', async () => {
    await ev(`sessionStorage.setItem('studio-token',${JSON.stringify(VIEWER_TOKEN)}),true`);
    await cdp('Page.reload');
    if (!(await until(`${text('#who')}.includes('(viewer)')&&document.querySelectorAll('#worlds-table tr').length>1`, 10000))) return `not signed in as the viewer: ${await ev(text('#who'))}`;
    const click = (label: string) => ev(`(()=>{const b=[...document.querySelectorAll('#worlds-table tr')].find(r=>r.cells[0].textContent==='helpdesk').querySelectorAll('button');[...b].find(x=>x.textContent===${JSON.stringify(label)}).click();return true})()`);
    await click('report');
    if (!(await until(`${text('#world-report')}===${JSON.stringify(SENSITIVE)}`, 5000))) return `report as viewer '${await ev(text('#world-report'))}'`;
    await click('serve');
    const refused = await until(`${text('#worlds-note')}===${JSON.stringify(FORBIDDEN)}`, 5000);
    await ev(`document.querySelector('#sec-worlds').scrollIntoView({block:'start'}),true`);
    return refused ? undefined : `serve as viewer '${await ev(text('#worlds-note'))}'`;
  });
  ws.close();
}

try {
  await main();
} catch (e) {
  broke++;
  console.log(`BREAK setup ${e}`);
} finally {
  chrome?.kill();
  studio?.kill();
}
console.log(`probe: ${pass} PASS, ${broke} BREAK`);
process.exit(broke === 0 ? 0 : 1);
