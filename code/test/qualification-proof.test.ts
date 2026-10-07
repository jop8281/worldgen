import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inventoryIssues, parseCheck, parseProofs } from '../scripts/qualification-proof.mjs';

const inventory = [{ task: 'assign', difficulty: 'medium', decoyCount: 2 }];
const proof = () => ({ task: 'assign', difficulty: 'medium', proof: {
  reference: { score: 1, calls: 3 }, noop: { score: 0 }, near_miss: { score: 0.5 },
  decoys: [0, 0.5], best_prefix: 0.5, replay_identical: true,
  state: '0123456789abcdef0123456789abcdef',
} });
const encode = (v: unknown) => `${JSON.stringify(v)}\n`;
function changed(keys: string[], value: unknown, remove = false) {
  const row: Record<string, unknown> = proof();
  let at = row;
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
  const key = keys.at(-1)!;
  if (remove) delete at[key]; else at[key] = value;
  return encode(row);
}
describe('qualification proof parser', () => {
  test('accepts the complete literal public TaskProof contract', () => {
    assert.deepEqual(parseProofs(encode(proof()), inventory), { ok: true, issues: [], records: [proof()] });
  });
  test('accepts easy/no-decoy and one-write null-prefix proofs', () => {
    const row = proof();
    const text = encode({ ...row, difficulty: 'easy', proof: { ...row.proof, decoys: [], near_miss: null, best_prefix: null } });
    assert.equal(parseProofs(text, [{ task: 'assign', difficulty: 'easy', decoyCount: 0 }]).ok, true);
  });
  test('accepts CRLF/blank separators but never discards nonblank junk', () => {
    assert.equal(parseProofs(`\r\n${JSON.stringify(proof())}\r\n\r\n`, inventory).ok, true);
    assert.equal(parseProofs(encode(proof()) + 'diagnostic junk\n', inventory).ok, false);
  });
  const bad: [string, string[] , unknown, boolean?][] = [
    ['wrong task', ['task'], 'another'], ['missing task', ['task'], null, true],
    ['wrong difficulty', ['difficulty'], 'hard'], ['unknown difficulty', ['difficulty'], 'impossible'],
    ['missing proof', ['proof'], null, true], ['reference score', ['proof','reference','score'], 0.99],
    ['zero calls', ['proof','reference','calls'], 0], ['fractional calls', ['proof','reference','calls'], 1.5],
    ['missing calls', ['proof','reference','calls'], null, true], ['noop score', ['proof','noop','score'], 1],
    ['full decoy', ['proof','decoys'], [0,1]], ['negative decoy', ['proof','decoys'], [-1,0.5]],
    ['null decoy', ['proof','decoys'], [null,0.5]], ['string decoy', ['proof','decoys'], ['0',0.5]],
    ['missing decoy', ['proof','decoys'], [0.5]], ['no medium decoys', ['proof','decoys'], []],
    ['near miss mismatch', ['proof','near_miss','score'], 0.25], ['missing near miss', ['proof','near_miss'], null, true],
    ['full prefix', ['proof','best_prefix'], 1], ['negative prefix', ['proof','best_prefix'], -0.1],
    ['missing prefix', ['proof','best_prefix'], null, true], ['nonidentical replay', ['proof','replay_identical'], false],
    ['missing replay', ['proof','replay_identical'], null, true], ['string replay', ['proof','replay_identical'], 'true'],
    ['missing state', ['proof','state'], null, true], ['wrong hash width', ['proof','state'], 'a'.repeat(64)],
    ['nonhex state', ['proof','state'], 'z'.repeat(32)],
  ];
  for (const [name, keys, value, remove] of bad) test(`refuses ${name}`, () => assert.equal(parseProofs(changed(keys, value, remove), inventory).ok, false));
  for (const [name, text] of [
    ['empty',''],['malformed','{'],['null','null'],['array','[]'],
    ['partial record','{"proof":{"reference":{"score":1},"noop":{"score":0},"decoys":[0]}}'],
    ['truncated tail',encode(proof())+'{"task":'],['unrelated record',encode(proof())+'{"ok":true}\n'],
    ['duplicate task',encode(proof())+encode(proof())],
  ]) test(`refuses ${name}`, () => assert.equal(parseProofs(text, inventory).ok, false));
  test('requires the complete independent task inventory', () => {
    assert.equal(parseProofs(encode(proof()), [...inventory, { task: 'second', difficulty: 'easy', decoyCount: 0 }]).ok, false);
    assert.equal(parseProofs(encode(proof()), []).ok, false);
    assert.equal(parseProofs(encode(proof()), [...inventory,...inventory]).ok, false);
  });
  test('rejects malformed inventories', () => {
    for (const value of [null, {}, [], [null], [{ task:'x',difficulty:'medium' }], [{ task:'x',difficulty:'medium',decoyCount:-1 }]]) assert.ok(inventoryIssues(value).length);
  });
  test('accepts multiple independently declared tasks', () => {
    assert.equal(parseProofs(encode(proof())+encode({...proof(),task:'second'}), [...inventory,{...inventory[0],task:'second'}]).ok,true);
  });
});
describe('qualification check parser', () => {
  test('accepts completed lints with warnings but no errors', () => {
    assert.deepEqual(parseCheck('{"ok":true,"reached":"lints","issues":[{"severity":"warning"}]}'), {ok:true,errors:0,issues:[]});
  });
  for (const [name, text] of [
    ['missing ok','{"reached":"lints","issues":[]}'],['false ok','{"ok":false,"reached":"lints","issues":[]}'],
    ['error','{"ok":true,"reached":"lints","issues":[{"severity":"error"}]}'],
    ['invalid severity','{"ok":true,"reached":"lints","issues":[{"severity":"info"}]}'],
    ['null issue','{"ok":true,"reached":"lints","issues":[null]}'],['malformed','junk'],
    ['missing issues','{"ok":true,"reached":"lints"}'],['missing layer','{"ok":true,"issues":[]}'],
    ['incomplete layers','{"ok":true,"reached":"compile","issues":[]}'],
  ]) test(`refuses ${name}`, () => assert.equal(parseCheck(text).ok,false));
});
