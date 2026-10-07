import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkRequest, routesOf } from '../src/dataset/episode.ts';

describe('documented root routes', () => {
  it('allows a documented root route while retaining the public route allowlist', () => {
    const routes = routesOf({ openapi: '3.1.0', info: { title: 'Root API', version: '1', description: '' }, tags: [], components: { schemas: {} }, 'x-error-codes': {},
      paths: { '/': { get: { operationId: 'root', summary: 'Read root', tags: [], parameters: [], responses: { '200': { description: 'OK' } } } } } });
    assert.deepEqual(checkRequest({ method: 'GET', path: '/', query: {} }, routes), {
      ok: true, send: { method: 'GET', target: '/', bodyText: undefined },
    });
    assert.equal(checkRequest({ method: 'GET', path: '/', query: {} }, []).ok, false);
    assert.equal(checkRequest({ method: 'POST', path: '/', query: {} }, routes).ok, false);
    assert.equal(checkRequest({ method: 'GET', path: '//', query: {} }, routes).ok, false);
  });
});
