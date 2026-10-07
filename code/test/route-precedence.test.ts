import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runtime } from '../src/engine/api.ts';
import { worldSchema } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

function world() {
  const bare = bareWorld();
  return worldSchema.parse({
    ...bare,
    entities: { pet: { description: 'A pet.', idPrefix: 'pet', fields: { name: { type: 'string', required: true } } } },
    routes: {
      by_status: { op: 'list', entity: 'pet', method: 'GET', path: '/pet/findByStatus', filters: [], pageSize: 25 },
      delete_pet: { op: 'delete', entity: 'pet', method: 'DELETE', path: '/pet/{id}' },
      get_pet: { op: 'get', entity: 'pet', method: 'GET', path: '/pet/{id}' },
    },
    actions: {}, jobs: {}, seed: {}, tasks: {}, tests: {}, fixtures: {},
  });
}

const call = (method: 'GET' | 'DELETE' | 'PUT', path: string) =>
  runtime(checkedForTest(world()), createVmHost()).call({ method, path, query: {}, body: undefined });

describe('a literal segment beats a parameter segment for every method', () => {
  it('answers 405 to DELETE on a literal path only GET declares, not a param match', () => {
    const res = call('DELETE', '/pet/findByStatus');
    assert.equal(res.status, 405);
    assert.deepEqual(res.body, { error: { code: 'method.not_allowed', message: 'DELETE /pet/findByStatus is not allowed. Allowed: GET' } });
  });

  it('still serves the literal path for its own method', () => {
    assert.equal(call('GET', '/pet/findByStatus').status, 200);
  });

  it('still matches the param route for any other id, and 404s a missing row', () => {
    assert.equal(call('DELETE', '/pet/pet_0001').status, 404);
    assert.equal(call('PUT', '/pet/findByStatus').status, 405);
  });
});
