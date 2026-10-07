import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INPUT_KINDS, digestInput, parseInputArgs, redact } from '../src/worldgen/input.ts';

describe('description kind', () => {
  it('R1 load returns the text', async () => {
    assert.deepEqual(await INPUT_KINDS.description.load({ kind: 'description', text: 'a helpdesk' }), { text: 'a helpdesk' });
  });

  it('R2 digest trims and cuts the summary to 8000 chars', async () => {
    const r = await digestInput({ kind: 'description', text: `  ${'x'.repeat(9000)}  ` });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.digest.kind, 'description');
    assert.equal(r.digest.summary, 'x'.repeat(8000));
    assert.deepEqual(r.digest.fixtures, {});
    assert.deepEqual(r.digest.observations, []);
    assert.equal(r.digest.apiShape, null);
  });

  it('R2 digest keeps a short text as is', async () => {
    const r = await digestInput({ kind: 'description', text: '  A helpdesk with SLAs\n' });
    assert.equal(r.ok && r.digest.summary, 'A helpdesk with SLAs');
  });
});

describe('redact', () => {
  const cases: [string, string, string][] = [
    ['bearer', 'call with Authorization: Bearer abc.DEF-123_xyz== now', 'call with Authorization: [redacted] now'],
    ['sk key', 'key sk-ant-abcDEF123456 end', 'key [redacted] end'],
    ['api_key=', 'x api_key=Zm9vYmFy&y=1', 'x api_key=[redacted]&y=1'],
    ['password= runs to the end of the line', 'password=hunter2 ok', 'password=[redacted]'],
    ['quoted password', 'password="hunter2" ok', 'password=[redacted] ok'],
    ['single-quoted api_key', "api_key: 'abc123' ok", 'api_key: [redacted] ok'],
    ['json form', '{"api_key": "abc123", "password":"hunter2"}', '{"api_key": [redacted], "password":[redacted]}'],
    ['env var', 'OPENAI_API_KEY=abc123xyz ok', 'OPENAI_API_KEY=[redacted] ok'],
    ['DB_PASSWORD', 'DB_PASSWORD=hunter2 ok', 'DB_PASSWORD=[redacted]'],
    ['access_token', 'access_token=abc123 ok', 'access_token=[redacted] ok'],
    ['SECRET_KEY', 'SECRET_KEY=hunter2xyz ok', 'SECRET_KEY=[redacted]'],
    ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY=sk_live_51Habc123 ok', 'STRIPE_SECRET_KEY=[redacted]'],
    ['secret_key_base', 'secret_key_base: abc123 ok', 'secret_key_base: [redacted]'],
    ['signing_key', 'signing_key=abc123 ok', 'signing_key=[redacted] ok'],
    ['session_key', 'session_key: abc123 ok', 'session_key: [redacted] ok'],
    ['client_secret', 'client_secret: xyz ok', 'client_secret: [redacted]'],
    ['json refresh_token', '{"refresh_token":"abc"}', '{"refresh_token":[redacted]}'],
    ['basic auth', 'Authorization: Basic dXNlcjpwYXNz now', 'Authorization: [redacted] now'],
    ['cookie', 'Cookie: sid=abc; theme=dark', 'Cookie: [redacted]'],
    ['github token', 'tok ghp_abcdefghijklmnopqrstuvwxyz0123 end', 'tok [redacted] end'],
    ['uri userinfo', 'dsn postgres://u:pw123@host/db end', 'dsn postgres://[redacted]@host/db end'],
    ['pem block', 'k -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY----- end', 'k [redacted] end'],
    ['rsa pem block', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '[redacted]'],
    ['bearer prose', 'The API authenticates with bearer tokens and returns 401.', 'The API authenticates with bearer tokens and returns 401.'],
    ['token colon-space word is masked', 'Each ticket stores a token: visible to agents', 'Each ticket stores a token: [redacted] to agents'],
    ['letters-only password colon', 'password: hunter ok', 'password: [redacted]'],
    ['letters-only secret colon', 'the secret: swordfish ok', 'the secret: [redacted]'],
    ['letters-only api key colon', 'api_key: abcdefgh ok', 'api_key: [redacted] ok'],
    ['letters-only api key sentence', 'API key: Opensesame ok', 'API key: [redacted] ok'],
    ['letters-only bearer in header', 'Authorization: Bearer hunter', 'Authorization: [redacted]'],
    ['lowercase bearer credential', 'authorization: bearer abc123def', 'authorization: [redacted]'],
    ['aws key id', 'id AKIAIOSFODNN7EXAMPLE end', 'id [redacted] end'],
    ['unterminated quote password', 'password="hunter2 unterminated', 'password=[redacted]'],
    ['escaped quote password', 'password="pa\\"ss2word" ok', 'password=[redacted] ok'],
    ['unterminated single quote', "api_key='abc def", 'api_key=[redacted]'],
    ['bare stripe live key', 'stripe key sk_live_51HabcDEF1234567890 in prose', 'stripe key [redacted] in prose'],
    ['bare stripe restricted key', 'rk_live_51HabcDEF1234567890', '[redacted]'],
    ['bare stripe test key', 'sk_test_51HabcDEF1234567890 x', '[redacted] x'],
    ['webhook secret', 'whsec_abcDEF1234567890xyz', '[redacted]'],
    ['google api key', 'k AIzaSyA1234567890abcdefghijklmnopqrstuv end', 'k [redacted] end'],
    ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789 x', '[redacted] x'],
    ['gitlab token', 'glpat-abcdefghij0123456789 x', '[redacted] x'],
    ['pass colon', 'pass: hunter2 ok', 'pass: [redacted]'],
    ['credentials colon', 'credentials: admin ok', 'credentials: [redacted] ok'],
    ['clean', 'A helpdesk with tickets', 'A helpdesk with tickets'],
  ];
  for (const [name, text, want] of cases) {
    it(`R3 ${name}`, () => {
      assert.equal(redact('description', { text }).text, want);
    });
  }

  it('R4 a token never reaches the digest', async () => {
    const r = await digestInput({ kind: 'description', text: 'Use Bearer s3cr3tT0ken9 and sk-live-ABCDEF123456 and password=hunter2 for a bank' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const json = JSON.stringify(r.digest);
    for (const secret of ['s3cr3tT0ken9', 'sk-live-ABCDEF123456', 'hunter2']) assert.equal(json.includes(secret), false);
    assert.equal(r.digest.summary.includes('[redacted]'), true);
  });

  it('R4 a secret at the 8000 boundary is masked before the cut', async () => {
    const r = await digestInput({ kind: 'description', text: `${'a '.repeat(3998)}sk-ABCDEFGHIJKLMNOP` });
    assert.equal(r.ok && r.digest.summary.includes('sk-'), false);
  });
});

describe('digestInput failures', () => {
  it('R5 empty and blank descriptions', async () => {
    for (const text of ['', '   \n']) {
      const r = await digestInput({ kind: 'description', text });
      assert.deepEqual(r, { ok: false, why: 'The description is empty.' });
    }
  });

  it('R6 a missing openapi or csv file is a failed digest, not a throw', async () => {
    const o = await digestInput({ kind: 'openapi', path: 'x.yaml', only: [] });
    const c = await digestInput({ kind: 'csv', paths: ['x.csv'] });
    assert.equal(o.ok, false);
    assert.equal(c.ok, false);
  });
});

describe('parseInputArgs', () => {
  it('R7 positional string is a description', () => {
    assert.deepEqual(parseInputArgs(['A helpdesk with SLA tiers']), { kind: 'description', text: 'A helpdesk with SLA tiers' });
    assert.deepEqual(parseInputArgs(['An issue tracker like Linear', '--fidelity', 'ref.yaml']), { kind: 'description', text: 'An issue tracker like Linear', fidelity: 'ref.yaml' });
    assert.throws(() => parseInputArgs(['--openapi', 'spec.yaml', '--fidelity', 'ref.yaml']), /--fidelity needs a description/);
    assert.throws(() => parseInputArgs(['A tracker', '--fidelity']), /--fidelity needs a reference file/);
  });

  it('R7 several words join and CLI options are skipped', () => {
    assert.deepEqual(parseInputArgs(['add', 'refunds', '--world', '../w', '--budget-usd', '3']), { kind: 'description', text: 'add refunds' });
  });

  it('R7 known value-less and value flags are skipped, unknown flags throw', () => {
    assert.deepEqual(parseInputArgs(['helpdesk', '--pause-after-plan']), { kind: 'description', text: 'helpdesk' });
    assert.deepEqual(parseInputArgs(['helpdesk', '--max-repairs', '4', '--interactive']), { kind: 'description', text: 'helpdesk' });
    assert.deepEqual(parseInputArgs(['helpdesk', '--model=x']), { kind: 'description', text: 'helpdesk' });
    assert.deepEqual(parseInputArgs(['helpdesk', '--transport', 'sdk', '--max-usd', '9']), { kind: 'description', text: 'helpdesk' });
    assert.deepEqual(parseInputArgs(['--transport=cli', 'helpdesk', '--allow-destructive']), { kind: 'description', text: 'helpdesk' });
    assert.throws(() => parseInputArgs(['helpdesk', '--bogus']), /Unknown option --bogus/);
  });

  it('R8 openapi with and without --only', () => {
    assert.deepEqual(parseInputArgs(['--openapi', 's.yaml', '--only', '/v1/a,/v1/b']), { kind: 'openapi', path: 's.yaml', only: ['/v1/a', '/v1/b'] });
    assert.deepEqual(parseInputArgs(['--openapi', 's.yaml']), { kind: 'openapi', path: 's.yaml', only: [] });
  });

  it('R9 csv takes several files', () => {
    assert.deepEqual(parseInputArgs(['--csv', 'a.csv', 'b.csv', '--out', 'o']), { kind: 'csv', paths: ['a.csv', 'b.csv'] });
  });

  it('R10 invalid argv throws', () => {
    assert.throws(() => parseInputArgs([]), /no input/i);
    assert.throws(() => parseInputArgs(['--openapi']), /--openapi/);
    assert.throws(() => parseInputArgs(['--csv']), /--csv/);
    assert.throws(() => parseInputArgs(['text', '--csv', 'a.csv']), /one input/i);
    assert.throws(() => parseInputArgs(['--openapi', 'a.yaml', '--csv', 'a.csv']), /one input/i);
    assert.throws(() => parseInputArgs(['--only', 'x', 'text']), /--only/);
  });
});

describe('redact is bounded on pathological input', () => {
  const run = (text: string) => {
    const t0 = performance.now();
    const out = redact('description', { text }).text;
    return { out, ms: performance.now() - t0 };
  };

  it('a 100KB snake_case run finishes fast and is length capped', () => {
    for (const text of ['token_'.repeat(20000), 'a_'.repeat(50000), 'access_token_secret_password_'.repeat(4000), 'a-'.repeat(50000), 'a'.repeat(100000) + '://']) {
      const { out, ms } = run(text);
      assert.ok(ms < 200, `took ${ms}ms`);
      assert.ok(out.length <= 9000);
    }
  });

  it('a token cut by the 200000 char raw cap leaves no prefix in the digest', () => {
    const { out } = run('password=' + 'A'.repeat(199_970) + ' ghp_Q7vK2pX9mW4tR8zLb3Nc');
    assert.ok(!out.includes('ghp_'));
    assert.ok(!out.includes('Q7vK2pX9'));
  });

  it('a secret straddling the 8000 char cut is still masked', () => {
    const { out } = run('x '.repeat(3995) + 'password=hunter2hunter2 tail');
    assert.ok(!out.includes('hunter2'));
  });

  it('a long secret straddling the cut leaves no 8+ char substring in the digest', () => {
    const secret = 'Zq9Xk4Lm2Vb7Nc5RtY8wPd3H';
    for (const pad of [7990, 7995, 8000, 7900]) {
      const text = `${'x '.repeat(pad / 2)}\nOPENAI_API_KEY=${secret} tail`;
      const { out } = run(text);
      for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!out.includes(secret.slice(i, i + 8)), `pad ${pad} leaked ${secret.slice(i, i + 8)}`);
    }
  });

  it('an over-long line is kept (not erased) and a secret inside it is still masked', () => {
    const prose = 'A retail store where customers can return items. '.repeat(260);
    assert.equal(run(prose).out, prose.trim().slice(0, 8000));
    const out = run(`${prose}password=hunter2hunter2 tail`).out;
    assert.equal(out.length, 8000);
    const mid = run(`${'x '.repeat(3000)}password=hunter2hunter2 ${'y '.repeat(4000)}`).out;
    assert.ok(!mid.includes('hunter2'));
    assert.ok(mid.includes('[redacted]'));
  });

  it('a secret longer than any window is masked whole on a long line', () => {
    const key = `sk-${'Ab3dE6gH9k'.repeat(900)}`;
    const out = run(`${'word '.repeat(600)}${key} tail`).out;
    assert.ok(!out.includes('Ab3dE6gH9k'));
    assert.ok(out.endsWith('[redacted] tail'));
    const pw = run(`${'word '.repeat(600)}password="${'Zq9Xk4Lm2V '.repeat(900)}" tail`).out;
    assert.ok(!pw.includes('Zq9Xk4Lm2V'));
    const cookie = run(`${'word '.repeat(600)}Cookie: ${'sidvalue; '.repeat(1500)}`).out;
    assert.ok(!cookie.includes('sidvalue'));
  });

  it('adversarial 200KB lines finish fast', () => {
    for (const text of ['password="'.repeat(20000), "api_key='".repeat(20000), 'Bearer '.repeat(30000), 'Bearer a'.repeat(30000), 'a:b@'.repeat(50000), 'sk-'.repeat(60000), 'eyJ-'.repeat(49000) + '.aaaaaaaaaa', 'eyJ'.repeat(66000) + '.aaaaaaaaaa.']) {
      const { ms } = run(text);
      assert.ok(ms < 1000, `took ${ms}ms`);
    }
  });

  it('a PEM block is masked across lines', () => {
    const pem = `intro\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabcdefgh\nijklmnop\n-----END RSA PRIVATE KEY-----\noutro`;
    assert.equal(run(pem).out, 'intro\n[redacted]\noutro');
  });

  it('many unterminated PEM headers finish fast', () => {
    const { out, ms } = run('-----BEGIN PRIVATE KEY-----\n'.repeat(4000));
    assert.ok(ms < 200, `took ${ms}ms`);
    assert.equal(out.replaceAll('\n', ''), '[redacted]');
  });

  it('a JWT is masked, including one after a dot, and its parts do not survive', () => {
    assert.equal(run('t=eyJhbGciOiJIUzI1.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4 end').out, 't=[redacted] end');
    assert.equal(run('x.eyJhbGciOiJIUzI1.eyJzdWIiOiIx.abc end').out, 'x.[redacted] end');
    assert.equal(run('see eyJhbGciOiJIUzI1.short.abc here').out, 'see eyJhbGciOiJIUzI1.short.abc here');
  });

  it('a PGP private key block is masked', () => {
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBFSECRETBODYxyz\n-----END PGP PRIVATE KEY BLOCK-----';
    assert.equal(run(`a\n${pgp}\nb`).out, 'a\n[redacted]\nb');
  });

  it('an Authorization value is masked whatever its scheme', () => {
    assert.equal(run('Authorization: Q7vK2pX9mW4tR8zLb3Nc').out, 'Authorization: [redacted]');
    assert.equal(run('Proxy-Authorization: Foo Q7vK2pX9mW4t').out, 'Proxy-Authorization: [redacted]');
    assert.equal(run('curl -H "X-Auth: Q7vK2pX9mW4tR8zLb3Nc" u').out, 'curl -H "X-Auth: [redacted]" u');
  });

  it('token-only URI userinfo and passphrase, pw and bearer labels are masked', () => {
    assert.equal(run('git https://Q7vK2pX9mW4tR8z@h/x').out, 'git https://[redacted]@h/x');
    assert.equal(run('passphrase=Q7vK2pX9mW4t').out, 'passphrase=[redacted]');
    assert.equal(run('pw=Q7vK2pX9mW4t').out, 'pw=[redacted]');
    assert.equal(run('bearer=Q7vK2pX9mW4t').out, 'bearer=[redacted]');
  });
});

describe('redact closes the adversarial leaks', () => {
  const X = 'Q7vK2pX9mW4tR8zL';
  const leaks: [string, string][] = [
    ['unquoted passphrase with spaces', `password: correct horse ${X} staple`],
    ['password value containing ;', `password=abc;${X}`],
    ['password value containing ,', `password=p@ss,${X}`],
    ['password value containing &', `password=Tr0ub4dor&${X}`],
    ['password value containing }', `{password=ab}${X}`],
    ['secret value containing a space', `client secret: abc ${X}`],
    ['Azure storage connection string', `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${X}==;EndpointSuffix=core.windows.net`],
    ['generic key=', `key=${X}`],
    ['Ocp-Apim-Subscription-Key header', `Ocp-Apim-Subscription-Key: ${X}`],
    ['YAML folded block password', `db:\n  password: >\n    ${X}\n  host: db.internal`],
    ['YAML literal block private_key', `private_key: |\n  ${X}\n  ${X}`],
    ['YAML block with chomping and indentation indicators', `secret: |2-\n  ${X}\n\n  ${X}`],
    ['Azure SAS sig= in URL', `https://acme.blob.core.windows.net/c?sv=2022&sp=r&sig=${X}%3D`],
    ['AWS presigned X-Amz-Signature', `https://s3.amazonaws.com/b/k?X-Amz-Credential=AKIDEXAMPLE&X-Amz-Signature=${X}`],
    ['env export of an unlisted name', `export STRIPE_RESTRICTED=${X}`],
    ['unlisted header', `X-Custom-Thing: ${X}`],
    ['YAML block with a comment after the indicator', `password: | # db creds\n  ${X}`],
    ['YAML block with a tag', `password: !!str |\n  ${X}`],
    ['YAML block with an anchor', `password: &a >-\n  ${X}`],
    ['YAML block under a *_key label', `tls_key: |\n  ${X}`],
    ['YAML plain scalar continued on deeper lines', `password:\n  first\n  ${X}\nname: x`],
    ['YAML escaped quote inside a single-quoted value', `password: 'it''s ${X}'`],
    ['base64 value starting with /', `x-signature: /${X}==`],
    ['label with a space: Pass phrase', `Pass phrase: correct horse ${X}`],
    ['label with a space: secret key', `secret key = abc ${X}`],
  ];
  for (const [name, line] of leaks) {
    it(`no 8+ char piece of the secret reaches the digest: ${name}`, async () => {
      const r = await digestInput({ kind: 'description', text: `A helpdesk.\n${line}\nTickets close after 7 days.` });
      assert.equal(r.ok, true);
      if (!r.ok) return;
      const json = JSON.stringify(r.digest);
      for (let i = 0; i + 8 <= X.length; i++) assert.equal(json.includes(X.slice(i, i + 8)), false, `leaked ${X.slice(i, i + 8)}`);
      assert.equal(r.digest.summary.startsWith('A helpdesk.\n'), true);
      assert.equal(r.digest.summary.endsWith('\nTickets close after 7 days.'), true);
    });
  }

  const exact: [string, string, string][] = [
    ['unquoted password runs to the end of the line', `password: correct horse ${X} staple`, 'password: [redacted]'],
    ['quoted password stops at the closing quote', `password="a b;c" then prose`, 'password=[redacted] then prose'],
    ['secret label masks to the end of the line', `secret=ab}${X}`, 'secret=[redacted]'],
    ['token label still masks one value', 'token=abc rest', 'token=[redacted] rest'],
    ['connection string keeps the other parts', `AccountName=acme;AccountKey=${X}==;EndpointSuffix=core.windows.net`, 'AccountName=acme;AccountKey=[redacted];EndpointSuffix=core.windows.net'],
    ['bare key=', `key=${X} next`, 'key=[redacted] next'],
    ['subscription key header', `Ocp-Apim-Subscription-Key: ${X}`, 'Ocp-Apim-Subscription-Key: [redacted]'],
    ['sig= in a query', `c?sv=2022&sig=${X}%3D&x=1`, 'c?sv=2022&sig=[redacted]&x=1'],
    ['X-Amz-Signature in a query', `k?X-Amz-Date=20260105&X-Amz-Signature=${X}`, 'k?X-Amz-Date=20260105&X-Amz-Signature=[redacted]'],
    ['fallback masks a long letters-and-digits value', `export STRIPE_RESTRICTED=${X}`, 'export STRIPE_RESTRICTED=[redacted]'],
    ['YAML folded block', `db:\n  password: >\n    ${X}\n    more\n  host: db.internal`, 'db:\n  password: [redacted]\n  host: db.internal'],
    ['YAML literal block at column 0', `private_key: |+\n  ${X}\n\n  ${X}\nname: acme`, 'private_key: [redacted]\nname: acme'],
    ['a non-credential block scalar is kept', 'description: |\n  Tickets close after 7 days.\nname: acme', 'description: |\n  Tickets close after 7 days.\nname: acme'],
    ['a short value after a colon is kept', 'Ticket ids look like: T-100 and tier: pro2', 'Ticket ids look like: T-100 and tier: pro2'],
    ['a URL with letters and digits is kept', 'GET https://api.acme.io/v1/tickets/tkt0001abcdefgh', 'GET https://api.acme.io/v1/tickets/tkt0001abcdefgh'],
    ['a letters-only long value is kept', 'status: AwaitingCustomerResponse', 'status: AwaitingCustomerResponse'],
    ['a digits-only long value is kept', 'phone: 4155550100123456', 'phone: 4155550100123456'],
    ['the word key in prose is kept', 'The primary key: id. A hotkey is fine.', 'The primary key: id. A hotkey is fine.'],
    ['a block under a list item ends at its sibling key', `creds:\n  - password: |\n      ${X}\n    user: bob`, 'creds:\n  - password: [redacted]\n    user: bob'],
    ['a YAML escaped quote stays inside the masked value', "password: 'it''s secret' ok", 'password: [redacted] ok'],
    ['pass inside another word is not a label', 'Agents can bypass: tickets skip the queue', 'Agents can bypass: tickets skip the queue'],
    ['a dated version is kept', 'Stripe-Version: 2024-06-20.acacia', 'Stripe-Version: 2024-06-20.acacia'],
    ['a UUID is kept', 'id: 123e4567-e89b-12d3-a456-426614174000', 'id: 123e4567-e89b-12d3-a456-426614174000'],
  ];
  for (const [name, text, want] of exact) {
    it(name, () => {
      assert.equal(redact('description', { text }).text, want);
    });
  }

  it('new patterns stay linear on 200KB hostile input', () => {
    for (const text of [
      'key='.repeat(50000),
      'a1=b2='.repeat(33000),
      ': '.repeat(100000),
      'x:'.repeat(100000) + 'a1'.repeat(10),
      `${'a1'.repeat(99990)}=`,
      'sig=&'.repeat(40000),
      'password: |\n'.repeat(16000),
      `password: >\n${'  a1b2c3d4e5f6g7h8\n'.repeat(10000)}`,
      'password=;'.repeat(20000),
      `${'token'.repeat(40000)}x`,
      `${'a'.repeat(199990)}: |`,
      '  - password:\n'.repeat(14000),
      "password: '".concat("''".repeat(99000)),
      `password: !a !b !c ${'!x '.repeat(60000)}|`,
    ]) {
      const t0 = performance.now();
      redact('description', { text });
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `took ${ms}ms`);
    }
  });
});
