/**
 * Red-team: worldgen/input.ts (factory unit wg-input-description). Capabilities that still
 * throw `not implemented` skip, decided by probing at load time.
 *
 * Guarantees (one sentence each, with source):
 * WG-I01 inputSchema accepts the three kinds and rejects an empty description, a CSV with no paths and an unknown kind. (input.ts inputSchema; A-38)
 * WG-I02 INPUT_KINDS has exactly one entry per inputSchema kind, each with a CLI flag. (input.ts invariant "INPUT_KINDS has one entry per kind")
 * WG-I03 redact removes bearer tokens, API keys and passwords from a description. (input.ts invariant "Auth headers, cookies and tokens never reach the model, events")
 * WG-I04 redact removes credentials from an OpenAPI document: header and cookie examples, security scheme values, server URL userinfo. (same)
 * WG-I05 redact removes secret values from CSV columns named like credentials. (same)
 * WG-I06 A secret in a description never reaches the InputDigest that events and prompts receive. (input.ts invariant; architecture.md "Events and attempt dumps see only InputDigest")
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INPUT_KINDS, digestInput, inputSchema, redact } from '../src/worldgen/input.ts';
import { notBuilt } from './redteam-wg/fixtures.ts';

const SECRETS = ['sk-ant-api03-REDTEAMSECRET', 'ghp_REDTEAMTOKEN0123456789abcdef', 'hunter2-REDTEAM-pw'];
const leaks = (value: unknown): string[] => {
  const text = JSON.stringify(value);
  return SECRETS.filter((s) => text.includes(s));
};

const skipRedactDescription = await notBuilt('wg-input-description', 'input.redact(description)', () => redact('description', { text: 'x' }));
const skipRedactOpenapi = await notBuilt('wg-input-openapi', 'input.redact(openapi)', () => redact('openapi', { document: {}, only: [] }));
const skipRedactCsv = await notBuilt('wg-input-csv', 'input.redact(csv)', () => redact('csv', { tables: [], note: null }));
const skipDigest = await notBuilt('wg-input-description', 'input.digestInput(description)', async () => {
  const r = await digestInput({ kind: 'description', text: 'A tiny helpdesk' });
  if (r === undefined) throw new Error('not implemented');
});

describe('redteam input: schema', () => {
  it('WG-I01 inputSchema accepts each kind and rejects bad inputs', () => {
    const ok = (o: unknown) => inputSchema.safeParse(o).success;
    assert.equal(ok({ kind: 'description', text: 'A helpdesk' }), true);
    assert.deepEqual(inputSchema.parse({ kind: 'openapi', path: 'a.yaml' }), { kind: 'openapi', path: 'a.yaml', only: [] });
    assert.equal(ok({ kind: 'csv', paths: ['a.csv'] }), true);
    assert.equal(ok({ kind: 'description', text: '' }), false);
    assert.equal(ok({ kind: 'csv', paths: [] }), false);
    assert.equal(ok({ kind: 'graphql', path: 'x' }), false);
  });

  it('WG-I02 INPUT_KINDS has one entry per kind, each with a flag', () => {
    assert.deepEqual(Object.keys(INPUT_KINDS).sort(), ['csv', 'description', 'openapi']);
    assert.deepEqual([...inputSchema.options.map((o) => o.shape.kind.value)].sort(), ['csv', 'description', 'openapi']);
    for (const def of Object.values(INPUT_KINDS)) assert.equal(def.flag.length > 0, true);
  });
});

describe('redteam input: redaction', () => {
  it('WG-I03 redact strips tokens, keys and passwords from a description', { skip: skipRedactDescription }, () => {
    const text = [
      'A helpdesk API. Call it with Authorization: Bearer sk-ant-api03-REDTEAMSECRET.',
      'The GitHub token is ghp_REDTEAMTOKEN0123456789abcdef and the admin password=hunter2-REDTEAM-pw.',
      'Tickets have SLA tiers.',
    ].join('\n');
    const out = redact('description', { text });
    assert.deepEqual(leaks(out), []);
    assert.equal(out.text.includes('Tickets have SLA tiers.'), true);
  });

  it('WG-I04 redact strips credentials from an OpenAPI document', { skip: skipRedactOpenapi }, () => {
    const document = {
      openapi: '3.0.0',
      servers: [{ url: 'https://admin:hunter2-REDTEAM-pw@api.example.com' }],
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', 'x-example': 'sk-ant-api03-REDTEAMSECRET' } } },
      paths: {
        '/tickets': {
          get: {
            parameters: [
              { name: 'Authorization', in: 'header', example: 'Bearer ghp_REDTEAMTOKEN0123456789abcdef' },
              { name: 'session', in: 'cookie', example: 'sk-ant-api03-REDTEAMSECRET' },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const out = redact('openapi', { document, only: [] });
    assert.deepEqual(leaks(out), []);
    assert.equal(JSON.stringify(out).includes('/tickets'), true);
  });

  it('WG-I05 redact strips values of credential-like CSV columns', { skip: skipRedactCsv }, () => {
    const out = redact('csv', {
      tables: [{ name: 'users', header: ['id', 'email', 'api_key', 'password'], rows: [['1', 'a@example.com', 'sk-ant-api03-REDTEAMSECRET', 'hunter2-REDTEAM-pw']] }],
      note: null,
    });
    assert.deepEqual(leaks(out), []);
    assert.equal(JSON.stringify(out).includes('a@example.com'), true);
  });

  it('WG-I06 a secret in a description never reaches the digest', { skip: skipDigest }, async () => {
    const r = await digestInput({ kind: 'description', text: 'A helpdesk. Use Authorization: Bearer sk-ant-api03-REDTEAMSECRET to call it. password=hunter2-REDTEAM-pw' });
    assert.equal(r.ok, true);
    assert.deepEqual(leaks(r), []);
  });
});
