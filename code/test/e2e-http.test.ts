import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { describe, it, type TestContext } from 'node:test';
import { json } from '../scripts/e2e-http.ts';

async function server(t: TestContext, listener: RequestListener): Promise<string> {
  const http = createServer(listener);
  t.after(() => new Promise<void>((resolve, reject) => {
    http.close((error) => error ? reject(error) : resolve());
    http.closeAllConnections();
  }));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  assert.ok(address !== null && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

describe('acceptance HTTP deadline', () => {
  it('R1 aborts a body that stalls after headers and closes its connection', { timeout: 5_000 }, async (t) => {
    let sentHeaders = false;
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const url = await server(t, (_req, res) => {
      res.on('close', closed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.write('{"pending":');
      sentHeaders = true;
    });
    await assert.rejects(json(url, 'GET', '/stalled', undefined, 500), {
      name: 'Error', message: 'HTTP GET /stalled timed out after 500 ms',
    });
    assert.equal(sentHeaders, true);
    await disconnected;
  });

  it('R2 aborts when the server never sends headers', { timeout: 5_000 }, async (t) => {
    let requested = false;
    const url = await server(t, () => { requested = true; });
    await assert.rejects(json(url, 'POST', '/no-headers', { private: 'not-in-error' }, 500), {
      name: 'Error', message: 'HTTP POST /no-headers timed out after 500 ms',
    });
    assert.equal(requested, true);
  });

  it('R2 preserves JSON status/body, empty responses and parse errors', async (t) => {
    const url = await server(t, (req, res) => {
      if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
      if (req.url === '/invalid') { res.end('{bad'); return; }
      assert.equal(req.method, 'POST');
      assert.equal(req.headers['content-type'], 'application/json');
      let body = '';
      req.on('data', (chunk) => { body += String(chunk); });
      req.on('end', () => {
        assert.equal(body, '{"name":"Acme"}');
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end('{"id":"cus_1"}');
      });
    });
    assert.deepEqual(await json(url, 'POST', '/create', { name: 'Acme' }), { status: 201, body: { id: 'cus_1' } });
    assert.deepEqual(await json(url, 'GET', '/empty'), { status: 204, body: null });
    await assert.rejects(json(url, 'GET', '/invalid'), SyntaxError);
  });

  it('R4 rejects invalid deadlines before making a request', async () => {
    for (const timeout of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      await assert.rejects(json('http://127.0.0.1:1', 'GET', '/', undefined, timeout), {
        name: 'RangeError', message: 'HTTP timeout must be a positive integer at most 2147483647 ms',
      });
    }
  });
});
