/** Validate the public TaskProof contract, never execute or mint an engine verdict. */
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const difficulties = new Set(['easy', 'medium', 'hard']);
const belowOne = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1;
const own = (v, key) => object(v) && Object.hasOwn(v, key);

/** The inventory comes from the frozen world, not from the output being validated. */
export function inventoryIssues(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) return ['task inventory missing or empty'];
  const seen = new Set();
  const issues = [];
  for (const entry of inventory) {
    if (!object(entry) || typeof entry.task !== 'string' || !entry.task.trim() || !difficulties.has(entry.difficulty)
      || !Number.isSafeInteger(entry.decoyCount) || entry.decoyCount < 0) {
      issues.push('invalid task inventory entry');
      continue;
    }
    if (seen.has(entry.task)) issues.push(`duplicate inventory task: ${entry.task}`);
    seen.add(entry.task);
  }
  return issues;
}

/** Nonblank non-JSON lines are failures, not noise to discard. */
export function parseProofs(text, inventory) {
  const issues = inventoryIssues(inventory);
  const records = [];
  const expected = new Map((Array.isArray(inventory) ? inventory : []).filter(object).map((e) => [e.task, e]));
  const seen = new Set();
  if (typeof text !== 'string') return { ok: false, issues: [...issues, 'proof text missing'], records };
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { issues.push(`proof line ${index + 1}: invalid JSON`); continue; }
    records.push(value);
    const at = `proof line ${index + 1}`;
    if (!object(value) || typeof value.task !== 'string' || !value.task.trim()) {
      issues.push(`${at}: task identity missing`);
      continue;
    }
    if (seen.has(value.task)) issues.push(`${at}: duplicate task ${value.task}`);
    seen.add(value.task);
    if (!expected.has(value.task)) issues.push(`${at}: unexpected task ${value.task}`);
    else if (expected.get(value.task).difficulty !== value.difficulty) issues.push(`${at}: task difficulty mismatch`);
    if (!difficulties.has(value.difficulty)) issues.push(`${at}: invalid difficulty`);
    const proof = value.proof;
    if (!object(proof)) { issues.push(`${at}: proof missing`); continue; }
    if (proof.reference?.score !== 1 || !Number.isSafeInteger(proof.reference?.calls) || proof.reference.calls < 1) issues.push(`${at}: invalid reference`);
    if (proof.noop?.score !== 0) issues.push(`${at}: invalid noop`);
    const decoys = proof.decoys;
    if (!Array.isArray(decoys) || !decoys.every(belowOne)) issues.push(`${at}: invalid decoys`);
    else {
      if (expected.has(value.task) && decoys.length !== expected.get(value.task).decoyCount) issues.push(`${at}: decoy inventory mismatch`);
      if (value.difficulty !== 'easy' && decoys.length === 0) issues.push(`${at}: required decoy missing`);
      const best = decoys.reduce((a, b) => Math.max(a, b), 0);
      if (decoys.length === 0 ? proof.near_miss !== null : !object(proof.near_miss) || proof.near_miss.score !== best) issues.push(`${at}: near_miss disagrees with decoys`);
    }
    if (!own(proof, 'best_prefix') || !(proof.best_prefix === null || belowOne(proof.best_prefix))) issues.push(`${at}: invalid best_prefix`);
    if (proof.replay_identical !== true) issues.push(`${at}: replay is not identical`);
    // engine/store.ts stateHash is hash128, not a cryptographic SHA-256 digest.
    if (typeof proof.state !== 'string' || !/^[0-9a-f]{32}$/.test(proof.state)) issues.push(`${at}: invalid engine state hash`);
  }
  for (const task of expected.keys()) if (!seen.has(task)) issues.push(`missing proof for task: ${task}`);
  if (records.length === 0) issues.push('proof output empty');
  return { ok: issues.length === 0, issues, records };
}

export function parseCheck(text) {
  try {
    const check = JSON.parse(text);
    if (!object(check) || typeof check.ok !== 'boolean' || check.reached !== 'lints' || !Array.isArray(check.issues)
      || !check.issues.every((i) => object(i) && ['error', 'warning'].includes(i.severity))) {
      return { ok: false, errors: -1, issues: ['invalid check document'] };
    }
    const errors = check.issues.filter((i) => i.severity === 'error').length;
    return { ok: check.ok === true && errors === 0, errors, issues: check.ok && errors === 0 ? [] : ['check reported failure'] };
  } catch { return { ok: false, errors: -1, issues: ['invalid check JSON'] }; }
}
