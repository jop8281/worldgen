/** Artifact-smoke receipts. Built-ins only until inventory extraction after installation.
 * The evidence writer is trusted: hashes detect changes, they do not authenticate a signer.
 * Neither successful parsing nor a receipt re-executes the engine or certifies a release.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inventoryIssues, parseCheck, parseProofs } from './qualification-proof.mjs';

const VERSION = 2;
const toolingPaths = ['scripts/qualify-main.sh', 'scripts/runner.sh', 'code/scripts/qualification-receipt.mjs', 'code/scripts/qualification-proof.mjs'];
const required = ['clone', 'fetch', 'checkout', 'install', 'inventory', 'typecheck', 'solve-demo', 'demo'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const jsonLines = file => readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const save = (file, value) => {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
};
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const validName = name => typeof name === 'string' && /^[a-z0-9-]+$/.test(name);
const commandFiles = name => ['record.json', 'stdout', 'stderr'].map(file => `commands/${name}/${file}`);
const commandDir = (root, name) => {
  if (!validName(name)) throw new Error('Invalid evidence command name');
  return path.join(root, 'commands', name);
};

/** Refuse path escapes, linked parents and special files, including a symlinked evidence root. */
function regular(root, relative) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('invalid evidence root');
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('unsafe evidence path');
  const parts = relative.split('/');
  let file = root;
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.' || part === '..') throw new Error('unsafe evidence path');
    file = path.join(file, part);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('linked or nonregular evidence');
  }
  return file;
}
const digest = (root, file) => hash(readFileSync(regular(root, file)));
const hashFiles = (root, files) => files.map(file => ({ path: file, sha256: existsSync(path.join(root, file)) ? digest(root, file) : null }));

function evidenceFiles(root) {
  const result = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (relative === 'receipt.json') continue;
        if (relative.endsWith('.tmp')) throw new Error(`incomplete evidence write: ${relative}`);
        result.push({ path: relative, sha256: digest(root, relative) });
      }
    }
  };
  walk(root);
  return result;
}
const tasksOf = data => {
  if (!object(data?.tasks)) throw new Error('task inventory missing');
  return Object.entries(data.tasks).map(([task, value]) => ({ task, difficulty: value?.difficulty, decoyCount: Array.isArray(value?.decoys) ? value.decoys.length : 0 }));
};

function kindOf(dir) {
  let kind = 'hand-built';
  const runs = path.join(dir, 'runs');
  if (existsSync(runs)) for (const run of readdirSync(runs).sort()) {
    const file = path.join(runs, run, 'events.jsonl');
    if (!existsSync(file)) continue;
    try {
      const start = jsonLines(file).find(e => e?.t === 'run_started');
      if (start) { kind = ['description', 'csv', 'openapi', 'iterate'].includes(start.input) ? start.input : 'unknown'; break; }
    } catch { kind = 'unknown'; }
  }
  if (kind === 'hand-built' && existsSync(path.join(dir, 'description.txt'))) kind = 'description';
  return kind; // Historical origin inventory, not proof of fresh generation.
}

function summarizeWorld(evidence, index, verifyName) {
  const source = read(regular(evidence, 'source.json'));
  const inventory = read(regular(evidence, 'inventory.json'));
  const world = source.worlds[index - 1];
  if (!world || ![`world-${index}-verify-1`, `world-${index}-verify-2`].includes(verifyName)) throw new Error('invalid world command selection');
  const checkName = `world-${index}-check`;
  const checkRecord = read(regular(evidence, `commands/${checkName}/record.json`));
  const verifyRecord = read(regular(evidence, `commands/${verifyName}/record.json`));
  const checked = parseCheck(readFileSync(regular(evidence, `commands/${checkName}/stdout`), 'utf8'));
  const proof = parseProofs(readFileSync(regular(evidence, `commands/${verifyName}/stdout`), 'utf8'), inventory[index - 1]?.tasks);
  const decoys = proof.records.flatMap(r => Array.isArray(r?.proof?.decoys) ? r.proof.decoys.filter(s => typeof s === 'number' && Number.isFinite(s)) : []);
  return { world: world.name, kind: world.kind, tasks: proof.records.length, errors: checked.errors,
    checkExit: checkRecord.exitCode, checkOk: checkRecord.exitCode === 0 && checked.ok,
    verifyExit: verifyRecord.exitCode, verifyCommand: verifyName,
    verifyOk: verifyRecord.exitCode === 0 && proof.ok, maxDecoy: decoys.length ? decoys.reduce((a, b) => Math.max(a, b)) : null,
    issues: [...checked.issues, ...proof.issues] };
}

export function validationIssues(receipt, expectedSha) {
  if (!object(receipt)) return ['invalid receipt'];
  const issues = [];
  if (typeof expectedSha !== 'string' || !/^[0-9a-f]{40}$/.test(expectedSha) || receipt.source?.sha !== expectedSha) issues.push('candidate SHA mismatch');
  if (receipt.version !== VERSION || receipt.scope !== 'artifact-smoke' || receipt.releaseQualification !== 'not_run'
    || receipt.cleanup !== 'not_certified') issues.push('invalid qualification scope');
  if (receipt.status !== 'passed' || receipt.shellExit !== 0 || receipt.signal !== null) issues.push('artifact smoke did not pass');
  if (!Array.isArray(receipt.failures) || receipt.failures.length) issues.push('recorded failures');
  const commands = Array.isArray(receipt.commands) ? receipt.commands : [];
  const names = commands.map(c => c?.name);
  if (names.some(n => !validName(n)) || new Set(names).size !== names.length) issues.push('invalid or duplicate command');
  for (const name of required) if (names.filter(n => n === name).length !== 1) issues.push(`required command missing: ${name}`);
  if (commands.some(c => !object(c) || c.status !== 'passed' || c.exitCode !== 0 || !Array.isArray(c.command)
    || !c.command.length || !c.command.every(a => typeof a === 'string') || typeof c.finishedAt !== 'string')) issues.push('failed or incomplete command');
  const worlds = Array.isArray(receipt.worlds) ? receipt.worlds : [];
  const declared = Array.isArray(receipt.source?.worlds) ? receipt.source.worlds : [];
  if (!worlds.length || !worlds.some(w => w?.kind === 'description') || worlds.length !== declared.length) issues.push('world requirements not met');
  if (worlds.some(w => !object(w) || w.checkExit !== 0 || w.errors !== 0 || w.checkOk !== true || w.verifyOk !== true || !Number.isInteger(w.tasks) || w.tasks < 1)) issues.push('world check or proof failed');
  const sourceNames = declared.map(w => w?.name);
  if (sourceNames.some(n => typeof n !== 'string' || !n || n.includes('/') || n === '.' || n === '..') || new Set(sourceNames).size !== sourceNames.length) issues.push('invalid source world inventory');
  for (const [index, world] of declared.entries()) {
    if (worlds.filter(w => w?.world === world?.name).length !== 1) issues.push('missing or duplicate world');
    for (const name of [`world-${index + 1}-check`, `world-${index + 1}-verify-1`]) if (names.filter(n => n === name).length !== 1) issues.push(`required command missing: ${name}`);
  }
  if (!Array.isArray(receipt.evidence) || !receipt.evidence.length) issues.push('evidence missing');
  return issues;
}

/** Recompute summaries from retained raw outputs, not from the receipt's asserted booleans. */
export function validateDirectory(evidence, expectedSha) {
  let receipt;
  try { receipt = read(regular(evidence, 'receipt.json')); } catch (error) { return [`invalid receipt: ${error.message}`]; }
  const issues = validationIssues(receipt, expectedSha);
  const files = Array.isArray(receipt?.evidence) ? receipt.evidence : [];
  const names = files.map(f => f?.path);
  const commands = Array.isArray(receipt?.commands) ? receipt.commands : [];
  const expectedFiles = ['metadata.json', 'source.json', 'inventory.json', 'rows.jsonl', ...toolingPaths.map(p => `tooling/${p}`),
    ...commands.filter(c => validName(c?.name)).flatMap(c => commandFiles(c.name))];
  for (const name of expectedFiles) if (names.filter(p => p === name).length !== 1) issues.push(`required evidence missing or duplicated: ${name}`);
  if (new Set(names).size !== names.length) issues.push('duplicate evidence path');
  for (const file of files) {
    try {
      if (!/^[0-9a-f]{64}$/.test(file?.sha256) || digest(evidence, file.path) !== file.sha256) throw new Error('hash mismatch');
    } catch { issues.push(`evidence mismatch: ${String(file?.path)}`); }
  }
  try { if (!same(evidenceFiles(evidence), files)) issues.push('evidence inventory mismatch'); } catch (error) { issues.push(error.message); }
  if (issues.length) return issues;
  try {
    const metadata = read(regular(evidence, 'metadata.json'));
    for (const key of ['version', 'scope', 'requestedRef', 'startedAt', 'tooling', 'controller']) if (!same(metadata[key], receipt[key])) issues.push(`metadata record mismatch: ${key}`);
    if (!same(read(regular(evidence, 'source.json')), receipt.source)) issues.push('source record mismatch');
    if (!same(jsonLines(regular(evidence, 'rows.jsonl')), receipt.worlds)) issues.push('world record mismatch');
    if (!Array.isArray(metadata.tooling?.files) || !same(metadata.tooling.files.map(f => f.path), toolingPaths)) issues.push('tooling inventory mismatch');
    else for (const file of metadata.tooling.files) if (digest(evidence, `tooling/${file.path}`) !== file.sha256) issues.push('tooling hash mismatch');
    for (const command of commands) if (!same(read(regular(evidence, `commands/${command.name}/record.json`)), command)) issues.push('command record mismatch');
    const clone = commands.find(c => c.name === 'checkout')?.command[2];
    const expectedCommands = new Map([
      ['checkout', ['git', '-C', clone, '-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']],
      ['install', ['install_deps']], ['inventory', ['receipt', 'inventory', clone]],
      ['typecheck', ['run', 'typecheck']], ['solve-demo', ['demo', 'solve-demo.sh']],
      ['demo', ['demo', 'demo.sh', `${clone}/prod/worlds/helpdesk`]],
    ]);
    const cloneCommand = commands.find(c => c.name === 'clone')?.command;
    if (!Array.isArray(cloneCommand) || cloneCommand.length !== 6
      || !same(cloneCommand.slice(0, 4), ['git', 'clone', '-q', '--no-local']) || cloneCommand[5] !== clone) issues.push('clone command mismatch');
    const fetchCommand = commands.find(c => c.name === 'fetch')?.command;
    if (!Array.isArray(fetchCommand) || fetchCommand.length !== 7 || !same(fetchCommand.slice(0, 5), ['git', '-C', clone, 'fetch', '-q'])) issues.push('fetch command mismatch');
    receipt.source.worlds.forEach((world, index) => {
      expectedCommands.set(`world-${index + 1}-check`, ['run', 'worldplay', 'check', `${clone}/prod/worlds/${world.name}`, '--json']);
      for (const attempt of [1, 2]) expectedCommands.set(`world-${index + 1}-verify-${attempt}`, ['run', 'worldplay', 'verify', `${clone}/prod/worlds/${world.name}`, '--json']);
    });
    for (const command of commands) {
      if (expectedCommands.has(command.name) && !same(expectedCommands.get(command.name), command.command)) issues.push(`command invocation mismatch: ${command.name}`);
      if (!expectedCommands.has(command.name) && !['clone', 'fetch'].includes(command.name)) issues.push(`unexpected command: ${command.name}`);
    }
    const inventory = read(regular(evidence, 'inventory.json'));
    if (!Array.isArray(inventory) || inventory.length !== receipt.source.worlds.length) issues.push('task inventory incomplete');
    else for (const [index, world] of receipt.source.worlds.entries()) {
      const item = inventory[index];
      if (item?.world !== world.name || item?.worldSha256 !== world.sha256 || digest(evidence, world.snapshot) !== world.sha256) issues.push('task inventory source mismatch');
      issues.push(...inventoryIssues(item?.tasks));
      const parsed = read(regular(evidence, `inputs/world-${index + 1}/parsed-world.json`));
      if (parsed.worldSha256 !== world.sha256 || !same(tasksOf(parsed.data), item.tasks)) issues.push('parsed source task inventory mismatch');
      const recomputed = summarizeWorld(evidence, index + 1, receipt.worlds[index]?.verifyCommand);
      if (!same(recomputed, receipt.worlds[index]) || !recomputed.checkOk || !recomputed.verifyOk) issues.push(`raw world evidence mismatch: ${world.name}`);
    }
  } catch (error) { issues.push(`invalid retained record: ${error.message}`); }
  return issues;
}

export function main(args) {
  const [action, directory, ...rest] = args;
  if (!directory) throw new Error('Evidence directory required');
  const evidence = path.resolve(directory);
  if (action === 'init') {
    const [root, requestedRef, selectedRuntime] = rest;
    let commit = null;
    try { commit = git(root, 'rev-parse', '--verify', 'HEAD'); } catch { /* Exported tools still have content hashes. */ }
    mkdirSync(path.join(evidence, 'commands'));
    const files = hashFiles(root, toolingPaths);
    for (const file of files) {
      const target = path.join(evidence, 'tooling', file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(regular(root, file.path)), { mode: 0o600 });
    }
    save(path.join(evidence, 'metadata.json'), { version: VERSION, scope: 'artifact-smoke', requestedRef,
      startedAt: new Date().toISOString(), tooling: { commit, files },
      controller: { selectedRuntime, execPath: process.execPath, node: process.versions.node, bun: process.versions.bun ?? null } });
  } else if (action === 'source') {
    const [clone] = rest;
    const sha = git(clone, 'rev-parse', '--verify', 'HEAD');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Candidate must resolve to a full commit SHA');
    const worldsDir = path.join(clone, 'prod/worlds');
    const names = existsSync(worldsDir) ? readdirSync(worldsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : [];
    const worlds = names.map((name, index) => {
      const bytes = readFileSync(regular(clone, `prod/worlds/${name}/world.yaml`));
      const snapshot = `inputs/world-${index + 1}/world.yaml`;
      mkdirSync(path.dirname(path.join(evidence, snapshot)), { recursive: true });
      writeFileSync(path.join(evidence, snapshot), bytes, { mode: 0o600 });
      return { name, kind: kindOf(path.join(worldsDir, name)), sha256: hash(bytes), snapshot };
    });
    const files = ['code/package.json', 'code/bun.lock', ...names.map(n => `prod/worlds/${n}/world.yaml`)];
    save(path.join(evidence, 'source.json'), { sha, worlds, files: hashFiles(clone, files) });
    const controller = read(regular(evidence, 'metadata.json')).controller;
    console.error(JSON.stringify({ type: 'qualification_runtime', head: sha, selected: controller.selectedRuntime, executable: process.execPath, version: process.version, bun: process.versions.bun ?? null, node: process.versions.node ?? null }));
  } else if (action === 'inventory') {
    const [clone] = rest;
    const source = read(regular(evidence, 'source.json'));
    const { parse } = createRequire(path.join(clone, 'code/package.json'))('yaml');
    const inventory = source.worlds.map((world, index) => {
      const data = parse(readFileSync(regular(evidence, world.snapshot), 'utf8'), { uniqueKeys: true });
      const tasks = tasksOf(data);
      save(path.join(evidence, `inputs/world-${index + 1}/parsed-world.json`), { worldSha256: world.sha256, data });
      const issues = inventoryIssues(tasks);
      if (issues.length) throw new Error(`${world.name}: ${issues.join('; ')}`);
      return { world: world.name, worldSha256: world.sha256, tasks };
    });
    save(path.join(evidence, 'inventory.json'), inventory);
  } else if (action === 'begin') {
    const [name, ...command] = rest;
    const dir = commandDir(evidence, name);
    mkdirSync(dir); // Refuse overwriting an existing attempt.
    writeFileSync(path.join(dir, 'stdout'), '', { mode: 0o600 });
    writeFileSync(path.join(dir, 'stderr'), '', { mode: 0o600 });
    save(path.join(dir, 'record.json'), { name, command, status: 'running', exitCode: null, startedAt: new Date().toISOString() });
  } else if (action === 'end') {
    const [name, exit] = rest;
    if (!validName(name)) throw new Error('Invalid evidence command name');
    const file = regular(evidence, `commands/${name}/record.json`);
    const code = Number(exit);
    if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error('Invalid command exit status');
    const record = read(file);
    if (record.status !== 'running') throw new Error('Command already finished');
    save(file, { ...record, status: code === 0 ? 'passed' : 'failed', exitCode: code, finishedAt: new Date().toISOString() });
  } else if (action === 'world') {
    console.log(JSON.stringify(summarizeWorld(evidence, Number(rest[0]), rest[1])));
  } else if (action === 'finish') {
    const [shellExit, signal, root, clone] = rest;
    const metadata = read(regular(evidence, 'metadata.json'));
    const failures = [];
    let source = null, worlds = [], commands = [], logs = [];
    try { source = read(regular(evidence, 'source.json')); } catch { failures.push('source evidence missing'); }
    try { worlds = jsonLines(regular(evidence, 'rows.jsonl')); } catch { failures.push('world evidence missing or malformed'); }
    for (const name of readdirSync(path.join(evidence, 'commands')).sort()) {
      try { commands.push(read(regular(evidence, `commands/${name}/record.json`))); } catch { failures.push(`${name}: command evidence malformed`); }
    }
    for (const name of required) if (!commands.some(c => c.name === name)) failures.push(`${name}: not run`);
    for (const command of commands) if (command.status !== 'passed') failures.push(`${command.name}: ${command.status} (exit ${command.exitCode})`);
    if (!source?.worlds.length) failures.push('no worlds in prod/worlds');
    if (!worlds.some(w => w.kind === 'description')) failures.push('description-generated world missing');
    if (source) try {
      if (git(clone, 'rev-parse', '--verify', 'HEAD') !== source.sha || git(clone, 'status', '--porcelain', '--untracked-files=no') !== '') failures.push('candidate changed during qualification');
      if (!same(hashFiles(clone, source.files.map(f => f.path)), source.files)) failures.push('candidate artifacts changed');
    } catch { failures.push('candidate identity could not be rechecked'); }
    try { if (!same(hashFiles(root, toolingPaths), metadata.tooling.files)) failures.push('qualification tooling changed'); } catch { failures.push('qualification tooling unavailable'); }
    if (Number(shellExit) !== 0) failures.push(`controller exited ${shellExit}`);
    try { logs = evidenceFiles(evidence); } catch (error) { failures.push(error.message); }
    const receipt = { ...metadata, source, finishedAt: new Date().toISOString(), shellExit: Number(shellExit), signal: signal || null,
      status: signal ? 'cancelled' : failures.length ? 'failed' : 'passed', releaseQualification: 'not_run', cleanup: 'not_certified',
      retryPolicy: 'one diagnostic retry; any failed attempt keeps the smoke red', failures, commands, worlds, evidence: logs };
    save(path.join(evidence, 'receipt.json'), receipt);
    for (const issue of validateDirectory(evidence, source?.sha)) if (!failures.includes(issue)) failures.push(issue);
    if (failures.length && receipt.status === 'passed') receipt.status = 'failed';
    save(path.join(evidence, 'receipt.json'), receipt);
    console.log('| world | input kind | tasks | check | verify | max decoy |\n|---|---|---|---|---|---|');
    for (const w of worlds) console.log(`| ${w.world} | ${w.kind} | ${w.tasks} | ${w.checkExit ? `fail (exit ${w.checkExit})` : w.checkOk ? 'pass' : 'fail'} | ${w.verifyOk ? 'pass' : 'fail'} | ${w.maxDecoy ?? '-'} |`);
    for (const w of worlds) for (const issue of w.issues ?? []) console.log(`FAIL: ${w.world}: ${issue}`);
    for (const failure of failures) console.log(`FAIL: ${failure}`);
    console.log(`\nsha: ${source?.sha ?? 'unresolved'}\nevidence: ${evidence}\nrelease qualification: NOT RUN\nverdict: ARTIFACT SMOKE ${receipt.status === 'passed' ? 'PASSED' : 'FAILED'}`);
    return receipt.status === 'passed' ? 0 : 1;
  } else if (action === 'validate') {
    const issues = validateDirectory(evidence, rest[0]);
    console.log(JSON.stringify({ ok: !issues.length, scope: 'artifact-smoke', issues }));
    return issues.length ? 1 : 0;
  } else throw new Error('Unknown receipt action');
  return 0;
}
