import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
const runner = process.env.QUALIFICATION_BASELINE_RUNNER ?? path.resolve(import.meta.dirname, '../../scripts/runner.sh');
/** Actual Node execution; a tiny loader stands in for tsx. Fixture entrypoints are JS only. */
function run(script: string, args: string[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qualification node route '));
  try {
    for (const sub of ['bin','src/cli','node_modules/tsx']) mkdirSync(path.join(dir,sub),{recursive:true});
    const scripts: Record<string,string> = {};
    for (const name of ['worldplay','worldgen','eval','live','sandbox','costs','dataset']) {
      scripts[name] = `bun src/cli/${name}.ts`;
      writeFileSync(path.join(dir,`src/cli/${name}.ts`),'console.log(JSON.stringify({node:process.versions.node,bun:process.versions.bun??null,args:process.argv.slice(2)}));\n');
    }
    scripts.docs = 'bun src/cli/worldplay.ts docs';
    writeFileSync(path.join(dir,'package.json'),JSON.stringify({type:'module',scripts}));
    writeFileSync(path.join(dir,'node_modules/tsx/package.json'),'{"type":"module","exports":"./index.mjs"}');
    writeFileSync(path.join(dir,'node_modules/tsx/index.mjs'),'import {register} from "node:module"; register("./loader.mjs",import.meta.url);');
    writeFileSync(path.join(dir,'node_modules/tsx/loader.mjs'),`import {readFile} from 'node:fs/promises';
export async function load(url,context,next) {
 if(url.endsWith('.ts')) return {format:'module',source:await readFile(new URL(url),'utf8'),shortCircuit:true};
 return next(url,context);
}`);
    const sentinel=path.join(dir,'bin/bun');
    writeFileSync(sentinel,'#!/bin/sh\necho "unexpected Bun dispatch" >&2\nexit 97\n'); chmodSync(sentinel,0o755);
    const result=spawnSync('bash',['-c','set -euo pipefail; source "$1"; shift; run "$@"','runner-test',runner,script,...args],{
      cwd:dir,encoding:'utf8',timeout:10000,env:{PATH:`${dir}/bin${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,WORLDGEN_RUNTIME:'node'},
    });
    assert.equal(result.error,undefined,String(result.error)); assert.equal(result.signal,null); return result;
  } finally {rmSync(dir,{recursive:true,force:true});}
}
describe('qualification runtime identity',()=>{
  for(const name of ['worldplay','worldgen','eval','live','sandbox','costs','dataset']) test(`forced Node runs ${name} on Node despite Bun-named scripts`,()=>{
    const result=run(name,['--help','argument with spaces']); assert.equal(result.status,0,result.stderr);
    const actual=JSON.parse(result.stdout); assert.equal(actual.bun,null); assert.ok(Number(actual.node.split('.')[0])>=22,actual.node);
    assert.deepEqual(actual.args,['--help','argument with spaces']);
  });
  test('docs preserves the Node subcommand and arguments',()=>{
    const result=run('docs',['--out','path with spaces.md']); assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).args,['docs','--out','path with spaces.md']);
  });
});
