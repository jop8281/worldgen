/**
 * Probes the Studio page's keyboard path, accessible names, worlds filter and resume-after-refresh in headless Chrome over CDP
 * (YOS-187). It starts its own studio child (token sign-in, a temp copy of helpdesk) and its own Chrome, prints PASS or BREAK
 * per step, writes a screenshot per step, and kills only the two processes it started. No Playwright: Chrome and Bun only.
 *
 *   bun scripts/studio-a11y-probe.ts [out-dir]
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const OUT = process.argv[2] ?? path.join(tmpdir(), 'studio-a11y-probe');
mkdirSync(OUT, { recursive: true });
const CHROME = process.env['CHROME'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROFILE = path.join(OUT, 'chrome-profile');
const TOKEN = randomBytes(12).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let studio: ChildProcess | undefined;
let chrome: ChildProcess | undefined;
let pass = 0;
let broke = 0;

async function main(): Promise<void> {
  const work = mkdtempSync(path.join(tmpdir(), 'a11y-probe-'));
  mkdirSync(path.join(work, 'worlds'));
  cpSync(path.join(REPO, 'prod', 'worlds', 'helpdesk'), path.join(work, 'worlds', 'helpdesk'), { recursive: true });
  studio = spawn('bun', ['src/cli/studio.ts', '--port', '0', '--worlds-dir', path.join(work, 'worlds'), '--repo-root', REPO], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, WORLDGEN_STUDIO_TOKEN: TOKEN },
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
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      const port = readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split('\n')[0]!;
      target = ((await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('no devtools page from Chrome');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id !== undefined) pending.get(m.id)?.(m); });
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
    if (!(await until(`document.querySelector('#who').textContent.includes('admin')&&!document.querySelector('#signout').hidden&&document.querySelectorAll('#worlds-table tr').length>1`))) return `not signed in: ${await ev(`document.querySelector('#who').textContent`)}`;
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
