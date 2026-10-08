/**
 * The page script as a browser runs it: its first requests, from a stand-in DOM, for each answer of GET /api/me.
 * Spend needs the admin role (YOS-187), so only an admin's page asks for /api/costs.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { studioPage } from '../src/studio/page.ts';

/**
 * A stand-in for any DOM node: each property is a stable stand-in of its own, a call answers one stable stand-in, and
 * an assignment is kept. It is no thenable, and it reads as '' where the page wants a string or a number.
 */
function node(): any {
  const props = new Map<PropertyKey, unknown>();
  let answer: unknown;
  return new Proxy(function () {}, {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (!props.has(key)) props.set(key, node());
      return props.get(key);
    },
    set: (_target, key, value) => props.set(key, value).has(key),
    apply: () => (answer ??= node()),
  });
}

/** Runs the page script once with `me` as the /api/me answer, and returns every path it fetched and its elements. */
async function boot(me: { readonly status: number; readonly body: object }): Promise<{ fetched: string[]; byId: (id: string) => any }> {
  const script = /<script>([\s\S]*)<\/script>/.exec(studioPage())![1]!;
  const elements = new Map<string, any>();
  const byId = (id: string) => elements.get(id) ?? elements.set(id, node()).get(id);
  const document = { getElementById: byId, createElement: () => node(), createTextNode: () => node(), querySelector: () => node(), querySelectorAll: () => [] };
  const fetched: string[] = [];
  // Only /api/me answers; every other request stays pending, so no other answer can reach the page.
  const fetch = (url: string) => {
    fetched.push(url);
    return url === '/api/me' ? Promise.resolve({ status: me.status, ok: me.status === 200, json: () => Promise.resolve(me.body) }) : new Promise(() => {});
  };
  const timers = { setTimeout: () => 0, setInterval: () => 0, clearInterval: () => {}, clearTimeout: () => {} };
  const window = { ...timers, location: node() };
  const sessionStorage = { getItem: () => 'a-token', setItem: () => {}, removeItem: () => {} };
  const run = new Function('document', 'fetch', 'window', 'location', 'sessionStorage', 'setTimeout', 'setInterval', 'clearInterval', 'clearTimeout', script);
  run(document, fetch, window, window.location, sessionStorage, timers.setTimeout, timers.setInterval, timers.clearInterval, timers.clearTimeout);
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  return { fetched, byId };
}

describe('the page script', () => {
  const cases = [
    { who: 'an admin', me: { status: 200, body: { name: 'ada', role: 'admin', tenant: 'ops', signIn: true } }, costs: true },
    { who: 'the open-mode local admin', me: { status: 200, body: { name: 'local', role: 'admin', tenant: 'default', signIn: false } }, costs: true },
    { who: 'an operator', me: { status: 200, body: { name: 'ana', role: 'operator', tenant: 'acme', signIn: true } }, costs: false },
    { who: 'a viewer', me: { status: 200, body: { name: 'vic', role: 'viewer', tenant: 'acme', signIn: true } }, costs: false },
    { who: 'a page that is not signed in', me: { status: 401, body: { error: { code: 'auth.required', message: 'GET /api/me needs sign-in' } } }, costs: false },
  ] as const;
  for (const c of cases) {
    it(`${c.costs ? 'asks' : 'never asks'} for /api/costs and /api/eval as ${c.who}, and ${c.costs ? 'shows' : 'hides'} Spend and Eval (A-370)`, async () => {
      const page = await boot(c.me);
      assert.equal(page.fetched.includes('/api/me'), true);
      assert.deepEqual([page.fetched.includes('/api/costs'), page.fetched.includes('/api/eval')], [c.costs, c.costs]);
      assert.deepEqual([page.byId('sec-spend').hidden === true, page.byId('sec-eval').hidden === true], [!c.costs, !c.costs]);
    });
  }
});
