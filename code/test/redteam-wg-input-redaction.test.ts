/**
 * Red-team: adversarial redaction for worldgen/input.ts (factory unit wg-input-description, YOS-33).
 * Written blind from the public interface (inputSchema, redact, digestInput) and YOS-33's
 * acceptance, without reading the builder's branch. test/redteam-wg-input.test.ts covers the
 * plain cases; this file attacks the edges.
 *
 * All cases are live (YOS-33 landed).
 *
 * Guarantees (one sentence each, with source):
 * WG-R01 A Bearer token, an sk-... key, an api_key= value and a password= value never reach the digest, in any spelling a model would read as one. (YOS-33 acceptance 2)
 * WG-R02 A PEM private key block never reaches the digest, header to footer. (input.ts invariant "tokens never reach the model")
 * WG-R03 A base64 or base64url secret behind a credential label never reaches the digest, including its +/= characters. (same)
 * WG-R04 A secret split across lines by a newline, CRLF or a backslash continuation never reaches the digest. (same)
 * WG-R05 A secret on an over-long line, or straddling the 8000-char summary cut, never reaches the digest, not even as a prefix. (YOS-33 acceptance 1 and 2)
 * WG-R06 Unicode lookalikes and zero-width characters in the label or the token do not let it through. (same)
 * WG-R07 Redaction finishes in linear time on hostile input. (input.ts invariant; a hang is a run that never starts)
 * WG-R08 An empty or whitespace-only description, and an unimplemented kind, return { ok: false } without throwing. (YOS-33 acceptance 3)
 * WG-R09 Ordinary prose survives redaction, so the planner still reads the domain. (YOS-33 acceptance 1)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { digestInput, redact, type Input } from '../src/worldgen/input.ts';


/** The distinctive core of every planted secret. No English text contains an 8-char window of it. */
const CORE = 'Q7vK2pX9mW4tR8zLb3NcY6';
const B64_CORE = Buffer.from(`sk-ant-api03-${CORE}`).toString('base64');

/** Folds lookalikes the way a reader would: NFKC, then drop zero-width and format characters. */
const fold = (s: string): string => s.normalize('NFKC').replace(/[​-‍⁠﻿­]/g, '');

/** Every 8-char window of `secret` found in `value`, after folding. Empty means no leak. */
function leaks(value: unknown, secret: string): string[] {
  const text = fold(JSON.stringify(value));
  const s = fold(secret);
  const hits = new Set<string>();
  for (let i = 0; i + 8 <= s.length; i++) {
    const w = s.slice(i, i + 8);
    if (text.includes(w)) hits.add(w);
  }
  return [...hits];
}

async function digestOf(text: string): Promise<unknown> {
  const r = await digestInput({ kind: 'description', text });
  assert.equal(r.ok, true, `digestInput refused: ${r.ok ? '' : r.why}`);
  return r.ok ? r.digest : undefined;
}

const PROSE = 'A helpdesk with SLA tiers and on-call escalation.';

/** Each row is planted between two lines of prose and must not leak `secret` into the digest. */
type Row = { readonly name: string; readonly text: string; readonly secret: string };

const run = (rows: readonly Row[]) => {
  for (const row of rows) {
    it(row.name, async () => {
      const text = `${PROSE}\n${row.text}\nTickets close after 7 days.`;
      assert.deepEqual(leaks(await digestOf(text), row.secret), []);
      assert.deepEqual(leaks(redact('description', { text }), row.secret), []);
    });
  }
};

describe('redteam redaction: WG-R01 listed secret shapes and their spellings', () => {
  run([
    { name: 'Authorization: Bearer', text: `Authorization: Bearer ${CORE}`, secret: CORE },
    { name: 'lowercase bearer with extra spaces', text: `curl -H "authorization:   bearer    ${CORE}"`, secret: CORE },
    { name: 'sk- key alone', text: `Use sk-ant-api03-${CORE} for calls.`, secret: CORE },
    { name: 'sk- key in quotes and JSON', text: `{"key":"sk-proj-${CORE}"}`, secret: CORE },
    { name: 'api_key=', text: `api_key=${CORE}`, secret: CORE },
    { name: 'API_KEY: with space and quotes', text: `API_KEY: "${CORE}"`, secret: CORE },
    { name: 'apiKey = in code', text: `const apiKey = '${CORE}';`, secret: CORE },
    { name: 'api-key header', text: `x-api-key: ${CORE}`, secret: CORE },
    { name: 'api_key in a query string', text: `GET https://api.example.com/v1/tickets?page=2&api_key=${CORE}&sort=asc`, secret: CORE },
    { name: 'password=', text: `password=${CORE}`, secret: CORE },
    { name: 'PASSWORD: quoted', text: `PASSWORD: "${CORE}"`, secret: CORE },
    { name: 'passwd and pwd', text: `passwd=${CORE} pwd=${CORE}`, secret: CORE },
    { name: 'password with spaces inside quotes', text: `password = "correct horse ${CORE} staple"`, secret: CORE },
    { name: 'password in URL userinfo', text: `postgres://admin:${CORE}@db.internal:5432/helpdesk`, secret: CORE },
  ]);
});

describe('redteam redaction: WG-R02 PEM blocks', () => {
  const body = [CORE + 'AAAAB3NzaC1yc2EAAAADAQAB', 'MIIEowIBAAKCAQEA' + CORE.split('').reverse().join(''), 'kZz9' + CORE + '0123'];
  run([
    { name: 'RSA private key block', text: ['-----BEGIN RSA PRIVATE KEY-----', ...body, '-----END RSA PRIVATE KEY-----'].join('\n'), secret: CORE },
    { name: 'PKCS8 block indented in markdown', text: ['    -----BEGIN PRIVATE KEY-----', ...body.map((l) => `    ${l}`), '    -----END PRIVATE KEY-----'].join('\n'), secret: CORE },
    { name: 'OpenSSH block with CRLF', text: ['-----BEGIN OPENSSH PRIVATE KEY-----', ...body, '-----END OPENSSH PRIVATE KEY-----'].join('\r\n'), secret: CORE },
    { name: 'PEM with no END line runs to end of input', text: ['-----BEGIN EC PRIVATE KEY-----', ...body].join('\n'), secret: CORE },
    { name: 'PEM block flattened onto one line', text: `key: -----BEGIN PRIVATE KEY----- ${body.join(' ')} -----END PRIVATE KEY-----`, secret: CORE },
  ]);
});

describe('redteam redaction: WG-R03 base64-wrapped secrets', () => {
  const b64url = B64_CORE.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const basic = Buffer.from(`admin:${CORE}`).toString('base64');
  run([
    { name: 'api_key= with base64 value', text: `api_key=${B64_CORE}`, secret: B64_CORE },
    { name: 'base64 value with + / = characters is masked whole', text: `api_key=ab+/${B64_CORE}+/==`, secret: B64_CORE },
    { name: 'Bearer with base64url value', text: `Authorization: Bearer ${b64url}`, secret: b64url },
    { name: 'Authorization: Basic', text: `Authorization: Basic ${basic}`, secret: basic },
    { name: 'password= with base64 value', text: `password=${B64_CORE}`, secret: B64_CORE },
  ]);
});

describe('redteam redaction: WG-R04 secrets split across lines', () => {
  const half = CORE.length / 2;
  run([
    { name: 'api_key= then value on the next line', text: `api_key=\n${CORE}`, secret: CORE },
    { name: 'Bearer then indented token on the next line', text: `Authorization: Bearer\n    ${CORE}`, secret: CORE },
    { name: 'password: then value after CRLF', text: `password:\r\n${CORE}`, secret: CORE },
    { name: 'sk- key broken by a backslash continuation', text: `export KEY=sk-ant-api03-${CORE.slice(0, half)}\\\n${CORE.slice(half)}`, secret: CORE },
    { name: 'sk- key wrapped at a fixed width', text: `sk-ant-api03-${CORE.slice(0, half)}\n${CORE.slice(half)}`, secret: CORE.slice(half) },
  ]);
});

describe('redteam redaction: WG-R05 over-long lines and the summary cut', () => {
  run([
    { name: 'secret after 20k chars on one line', text: `${'x'.repeat(20_000)} api_key=${CORE}`, secret: CORE },
    { name: 'secret on a 1 MB line of words', text: `${'lorem ipsum '.repeat(90_000)}password=${CORE}`, secret: CORE },
  ]);

  it('a secret straddling the 8000-char cut leaks no prefix', async () => {
    // `kept` chars of CORE fall before the cut; the leak check needs at least 8 of them.
    for (const kept of [8, 12, 16, 21]) {
      const text = `${'a'.repeat(8_000 - ' api_key='.length - kept)} api_key=${CORE} and more text after it`;
      assert.deepEqual(leaks(await digestOf(text), CORE), [], `kept ${kept}`);
    }
  });

  it('a Bearer token straddling the cut leaks no prefix', async () => {
    const text = `${'b'.repeat(8_000 - ' Bearer '.length - 12)} Bearer ${CORE}`;
    const digest = (await digestOf(text)) as { summary: string };
    assert.equal(digest.summary.length <= 8_000, true);
    assert.deepEqual(leaks(digest, CORE), []);
  });
});

describe('redteam redaction: WG-R06 unicode lookalikes and invisible characters', () => {
  run([
    { name: 'Cyrillic lookalikes in Bearer', text: `Authorization: Веаrer ${CORE}`, secret: CORE },
    { name: 'fullwidth api_key label', text: `ａｐｉ_ｋｅｙ=${CORE}`, secret: CORE },
    { name: 'zero-width space inside the password label', text: `pass​word=${CORE}`, secret: CORE },
    { name: 'zero-width joiner inside the sk- prefix', text: `s‍k-ant-api03-${CORE}`, secret: CORE },
    { name: 'soft hyphen inside the token', text: `api_key=${CORE.slice(0, 11)}­${CORE.slice(11)}`, secret: CORE },
    { name: 'fullwidth token after a plain label', text: `api_key=${[...CORE].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join('')}`, secret: CORE },
    { name: 'non-breaking space between Bearer and token', text: `Authorization: Bearer ${CORE}`, secret: CORE },
  ]);
});

describe('redteam redaction: WG-R07 linear time', () => {
  const hostile: Row[] = [
    { name: '200k repeated api_key= with no value', text: 'api_key='.repeat(25_000), secret: CORE },
    { name: '200k spaces after Bearer', text: `Bearer${' '.repeat(200_000)}x`, secret: CORE },
    { name: 'unterminated PEM header repeated', text: '-----BEGIN '.repeat(20_000), secret: CORE },
    { name: '200k base64 chars after password=', text: `password=${'A'.repeat(200_000)}!`, secret: CORE },
  ];
  for (const row of hostile) {
    it(`${row.name} finishes in under 1s`, () => {
      const started = performance.now();
      redact('description', { text: row.text });
      assert.equal(performance.now() - started < 1_000, true);
    });
  }
});

describe('redteam redaction: WG-R08 refusals never throw', () => {
  const refuses = async (input: Input): Promise<void> => {
    let r: Awaited<ReturnType<typeof digestInput>> | undefined;
    await assert.doesNotReject(async () => {
      r = await digestInput(input);
    });
    assert.equal(r?.ok, false);
    assert.equal(typeof (r as { why?: unknown }).why === 'string' && (r as { why: string }).why.length > 0, true);
  };

  it('empty description', () => refuses({ kind: 'description', text: '' }));
  it('whitespace-only description', () => refuses({ kind: 'description', text: ' \n\t\r\n ' }));
  it('description that is only a secret redacts to nothing', async () => {
    const r = await digestInput({ kind: 'description', text: `api_key=${CORE}` });
    assert.deepEqual(leaks(r, CORE), []);
  });
  it('unimplemented kind (openapi)', () => refuses({ kind: 'openapi', path: '/nonexistent.yaml', only: [] }));
  it('unimplemented kind (csv)', () => refuses({ kind: 'csv', paths: ['/nonexistent.csv'] }));
});

describe('redteam redaction: WG-R09 prose survives', () => {
  it('domain words, including the word password, are kept', async () => {
    const text = [
      'Customers reset their password through a two-step flow.',
      'Each API key belongs to one workspace; a bearer of a revoked key gets 401.',
      'Tickets have SLA tiers: gold 4h, silver 1d.',
    ].join('\n');
    const digest = (await digestOf(text)) as { summary: string };
    for (const phrase of ['reset their password', 'Each API key belongs to one workspace', 'gold 4h, silver 1d']) {
      assert.equal(digest.summary.includes(phrase), true, phrase);
    }
  });

  it('masks with [redacted]', async () => {
    const digest = (await digestOf(`api_key=${CORE}`)) as { summary: string };
    assert.equal(digest.summary.includes('[redacted]'), true);
  });
});
