import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
const root = path.resolve(import.meta.dirname, '../..');
const qualifier = process.env.QUALIFICATION_BASELINE_SCRIPT ?? path.join(root,'scripts/qualify-main.sh');
const baseline = process.env.QUALIFICATION_BASELINE_SCRIPT !== undefined;
const files = ['scripts/qualify-main.sh','code/scripts/qualification-receipt.mjs','code/scripts/qualification-proof.mjs'];
const validProof = {task:'assign',difficulty:'medium',proof:{reference:{score:1,calls:3},noop:{score:0},near_miss:{score:0.5},decoys:[0,0.5],best_prefix:0.5,replay_identical:true,state:'0123456789abcdef0123456789abcdef'}};
type Receipt = {status:string; signal:string|null; scope:string; releaseQualification:string;cleanup:string;
 source:{sha:string};tooling:{commit:string;files:{path:string;sha256:string}[]};controller:{selectedRuntime:string};
 commands:{name:string;status:string;exitCode:number|null;command:string[]}[];
 worlds:{verifyOk:boolean}[]; evidence:{path:string;sha256:string}[];};
type Fixture = {dir:string;evidence:string;sha:string;receipt:Receipt;logs:Map<string,string>;validate:(sha?:string)=>ReturnType<typeof spawnSync>};
/** Real shell/Git; installation, world commands and the candidate YAML parser are stand-ins.
 * The fixture world.yaml is JSON (a YAML subset), not an engine world or live proof. */
function qualify(scenario:string,demo:'present'|'missing'|'not-executable'='present',worlds:'description'|'hand-built'|'none'='description',inspect?:(f:Fixture)=>void) {
 const dir=mkdtempSync(path.join(os.tmpdir(),'qualifier fixture '));const evidence=path.join(dir,'retained evidence');
 const row=structuredClone(validProof);let proof=JSON.stringify(row)+'\n';
 if(scenario==='replay-false'){row.proof.replay_identical=false;proof=JSON.stringify(row)+'\n';}
 if(scenario==='wrong-task'){row.task='another';proof=JSON.stringify(row)+'\n';}
 if(scenario==='partial-proof')proof='{"proof":{"reference":{"score":1},"noop":{"score":0},"decoys":[0]}}\n';
 if(scenario==='truncated-proof')proof+='{"task":';
 if(scenario==='duplicate-proof')proof+=proof;
 if(scenario==='verify-empty')proof='';
 const env={PATH:process.env.PATH,TMPDIR:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',QUALIFY_TEST_JS:process.execPath,QUALIFY_TEST_SCENARIO:scenario,QUALIFY_TEST_PROOF:proof,QUALIFY_TEST_COUNTER:path.join(dir,'verify-counter')};
 try {
  for(const sub of ['scripts','code/scripts','code/node_modules/yaml','prod/worlds'])mkdirSync(path.join(dir,sub),{recursive:true});
  for(const file of files)copyFileSync(file==='scripts/qualify-main.sh'?qualifier:path.join(root,file),path.join(dir,file));
  writeFileSync(path.join(dir,'code/package.json'),'{}\n');
  writeFileSync(path.join(dir,'code/node_modules/yaml/index.js'),'exports.parse = JSON.parse;\n');
  if(worlds!=='none'){
   mkdirSync(path.join(dir,'prod/worlds/fixture'));
   const tasks={assign:{difficulty:'medium',decoys:['a','b']},...(scenario==='missing-task'?{second:{difficulty:'easy',decoys:[]}}:{})};
   writeFileSync(path.join(dir,'prod/worlds/fixture/world.yaml'),JSON.stringify({tasks})+'\n');
   if(worlds==='description')writeFileSync(path.join(dir,'prod/worlds/fixture/description.txt'),'A qualification fixture.\n');
  }else writeFileSync(path.join(dir,'prod/README.md'),'no worlds\n');
  writeFileSync(path.join(dir,'scripts/runner.sh'),`
RUNTIME=fixture
install_deps() {
 printf 'simulated install\\n'
 if [ "$QUALIFY_TEST_SCENARIO" = cancelled ]; then kill -TERM "$$"; fi
 if [ "$QUALIFY_TEST_SCENARIO" = install-fail ]; then return 6; fi
}
run() {
 if [ "$1" = typecheck ]; then
  if [ "$QUALIFY_TEST_SCENARIO" = typecheck-fail ]; then return 5; fi
  return 0
 fi
 if [ "$2" = check ]; then
  if [ "$QUALIFY_TEST_SCENARIO" = check-issues ]; then printf '{"ok":false,"reached":"lints","issues":[{"severity":"error"}]}\\n'; return 1; fi
  if [ "$QUALIFY_TEST_SCENARIO" = check-false ]; then printf '{"ok":false,"reached":"lints","issues":[]}\\n'; return 0; fi
  if [ "$QUALIFY_TEST_SCENARIO" = check-malformed ]; then printf 'broken json\\n'; return 0; fi
  if [ "$QUALIFY_TEST_SCENARIO" = artifact-change ]; then printf 'changed\\n' >>"$3/world.yaml"; fi
  printf '{"ok":true,"reached":"lints","issues":[]}\\n'
  if [ "$QUALIFY_TEST_SCENARIO" = check-exit ]; then printf 'check exited after writing JSON\\n' >&2; return 7; fi
  return 0
 fi
 if [ "$QUALIFY_TEST_SCENARIO" = verify-exit ]; then return 9; fi
 if [ "$QUALIFY_TEST_SCENARIO" = verify-retry ] && [ ! -f "$QUALIFY_TEST_COUNTER" ]; then
  printf 1 >"$QUALIFY_TEST_COUNTER"; printf 'first failure retained\\n' >&2; return 8
 fi
 printf '%s' "$QUALIFY_TEST_PROOF"
}
js() {
 local code="$1"; shift
 case "$code" in *'const net = require("net")'*) printf '42123\\n' ;;
 *) "$QUALIFY_TEST_JS" -e "$code" "$@" ;;
 esac
}
`);
  for(const name of demo==='missing'?['solve-demo.sh']:['solve-demo.sh','demo.sh']){
   const file=path.join(dir,'scripts',name);writeFileSync(file,'#!/usr/bin/env bash\nexit 0\n');chmodSync(file,name==='demo.sh'&&demo==='not-executable'?0o644:0o755);
  }
  const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:dir,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['init','-q']);git(['add','.']);git(['-c','user.name=Qualification fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture']);
  const sha=git(['rev-parse','HEAD']);
  const flags=['--repo',dir,'--ref','HEAD',...(baseline?[]:['--evidence-dir',evidence])];
  const result=spawnSync('bash',[path.join(dir,'scripts/qualify-main.sh'),...flags],{cwd:dir,env,encoding:'utf8',timeout:30000});
  assert.equal(result.error,undefined,String(result.error));assert.equal(result.signal,null);
  const receiptFile=path.join(evidence,'receipt.json');
  const receipt:Receipt|null=existsSync(receiptFile)?JSON.parse(readFileSync(receiptFile,'utf8')):null;
  const logs=new Map<string,string>();
  if(receipt)for(const file of receipt.evidence){const bytes=readFileSync(path.join(evidence,file.path));assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);logs.set(file.path,bytes.toString('utf8'));}
  const validate=(expected=sha)=>spawnSync('bash',[path.join(dir,'scripts/qualify-main.sh'),'--validate',evidence,'--sha',expected],{env,encoding:'utf8',timeout:10000});
  const valid=receipt?validate():null;
  if(inspect){assert.ok(receipt);inspect({dir,evidence,sha,receipt,logs,validate});}
  const checkout=receipt?.commands.find(c=>c.name==='checkout')?.command[2];
  return {...result,receipt,sha,logs,valid,checkoutGone:checkout!==undefined&&!existsSync(checkout)};
 }finally{rmSync(dir,{recursive:true,force:true});}
}
function failed(result:ReturnType<typeof qualify>){assert.equal(result.status,1,`${result.stdout}\n${result.stderr}`);assert.match(result.stdout,/verdict: ARTIFACT SMOKE FAILED\s*$/);assert.equal(result.receipt?.status,'failed');assert.equal(result.valid?.status,1);}
describe('qualification actual-shell acceptance',()=>{
 test('qualifier records the exact source and executing runtime',()=>{
  const result=qualify('pass');assert.equal(result.status,0,result.stderr);
  const line=result.stderr.split('\n').find(v=>v.startsWith('{"type":"qualification_runtime"'));assert.ok(line,'missing qualification runtime receipt');
  const receipt=JSON.parse(line);assert.match(receipt.head,/^[0-9a-f]{40}$/);assert.equal(receipt.selected,'fixture');assert.equal(receipt.executable,process.execPath);assert.equal(receipt.version,process.version);assert.equal(receipt.bun,process.versions.bun??null);assert.equal(receipt.node,process.versions.node??null);
 });
 test('qualifier accepts successful check, proofs and both demos',()=>{
  const r=qualify('pass');assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);assert.match(r.stdout,/verdict: ARTIFACT SMOKE PASSED\s*$/);assert.equal(r.receipt?.source.sha,r.sha);assert.equal(r.valid?.status,0,String(r.valid?.stdout));assert.equal(r.checkoutGone,true);
 });
 test('qualifier refuses a nonzero check even when its JSON contains no issues',()=>{const r=qualify('check-exit');failed(r);assert.match(r.stdout,/fail \(exit 7\)/);assert.match(r.stderr,/check exited after writing JSON/);});
 test('qualifier still refuses check issues and terminal verify failures',()=>{for(const s of ['check-issues','verify-exit'])failed(qualify(s));});
 test('qualifier refuses a missing or non-executable required demo',()=>{for(const d of ['missing','not-executable']as const){const r=qualify('pass',d);failed(r);assert.match(r.stderr,/missing or not executable scripts\/demo.sh/);}});
 test('qualifier states smoke scope and that full release is not run',()=>{const r=qualify('pass');assert.equal(r.receipt?.scope,'artifact-smoke');assert.equal(r.receipt?.releaseQualification,'not_run');assert.equal(r.receipt?.cleanup,'not_certified');assert.match(r.stdout,/release qualification: NOT RUN/);});
 test('qualifier refuses a ref with no worlds instead of passing vacuously',()=>{const r=qualify('pass','present','none');failed(r);assert.match(r.stdout,/no worlds in prod\/worlds/);});
 test('qualifier refuses a ref with no description-generated world',()=>{const r=qualify('pass','present','hand-built');failed(r);assert.match(r.stdout,/description-generated world missing/);});
 test('qualifier rejects incomplete or false proof output',()=>{for(const s of ['partial-proof','replay-false','wrong-task','truncated-proof','duplicate-proof','verify-empty','missing-task'])failed(qualify(s));});
 test('qualifier rejects false or malformed check output',()=>{for(const s of ['check-false','check-malformed'])failed(qualify(s));});
 test('qualifier retains failed and recovered attempts without turning green',()=>{const r=qualify('verify-retry');failed(r);assert.match(r.logs.get('commands/world-1-verify-1/stderr')!,/first failure retained/);assert.equal(JSON.parse(r.logs.get('commands/world-1-verify-1/record.json')!).exitCode,8);assert.equal(JSON.parse(r.logs.get('commands/world-1-verify-2/record.json')!).exitCode,0);assert.equal(r.receipt?.worlds[0]?.verifyOk,true);});
 test('qualifier detects source changes and retains installation/typecheck failure',()=>{failed(qualify('artifact-change'));const r=qualify('install-fail');failed(r);assert.match(r.stdout,/typecheck: not run/);assert.match(r.logs.get('commands/install/stdout')!,/simulated install/);failed(qualify('typecheck-fail'));});
 test('qualifier records catchable cancellation without claiming cleanup',()=>{const r=qualify('cancelled');assert.equal(r.status,143,r.stderr);assert.equal(r.receipt?.status,'cancelled');assert.equal(r.receipt?.signal,'SIGTERM');assert.equal(r.receipt?.cleanup,'not_certified');assert.equal(r.receipt?.commands.find(c=>c.name==='install')?.status,'running');assert.equal(r.valid?.status,1);});
});
describe('retained receipt validation',()=>{
 test('rejects wrong SHA, missing/duplicate gates, tampering, rehashed false proofs and path escapes',()=>{
  const result=qualify('pass','present','description',({evidence,receipt,logs,validate})=>{
   const file=path.join(evidence,'receipt.json');const original=JSON.stringify(receipt);const originals=new Map(logs);
   const reset=()=>{for(const [name,text]of originals)writeFileSync(path.join(evidence,name),text);writeFileSync(file,original);};
   const reject=(pattern?:RegExp)=>{const r=validate();assert.equal(r.error,undefined);assert.equal(r.status,1,String(r.stdout));if(pattern)assert.match(String(r.stdout),pattern);};
   const altered=(edit:(v:Receipt)=>void)=>{reset();const v:Receipt=JSON.parse(original);edit(v);writeFileSync(file,JSON.stringify(v));};
   assert.equal(receipt.tooling.files.length,4);assert.equal(receipt.tooling.commit,receipt.source.sha);assert.equal(validate('0'.repeat(40)).status,1);
   altered(v=>{v.commands=v.commands.filter(c=>c.name!=='world-1-check');});reject(/required command missing/);
   altered(v=>{v.commands.push(v.commands[0]!);});reject(/duplicate command/);
   altered(v=>{v.controller.selectedRuntime='unproven';});reject(/metadata record mismatch/);
   reset();writeFileSync(path.join(evidence,'commands/install/stdout'),'tampered\n');reject(/evidence mismatch/);
   altered(v=>{v.evidence=v.evidence.filter(f=>f.path!=='commands/install/stdout');});reject(/required evidence missing/);
   for(const target of ['../outside','/absolute']){altered(v=>{v.evidence[0]!.path=target;});reject(/evidence mismatch/);}
   altered(v=>{v.evidence.push(v.evidence[0]!);});reject(/duplicate evidence/);
   const rehash=(name:string)=>{const v:Receipt=JSON.parse(original);v.evidence.find(f=>f.path===name)!.sha256=createHash('sha256').update(readFileSync(path.join(evidence,name))).digest('hex');writeFileSync(file,JSON.stringify(v));};
   reset();const raw='commands/world-1-verify-1/stdout';writeFileSync(path.join(evidence,raw),JSON.stringify({...validProof,proof:{...validProof.proof,replay_identical:false}})+'\n');rehash(raw);reject(/raw world evidence mismatch/);
   reset();const inv=JSON.parse(readFileSync(path.join(evidence,'inventory.json'),'utf8'));inv[0].tasks[0].decoyCount=1;writeFileSync(path.join(evidence,'inventory.json'),JSON.stringify(inv));rehash('inventory.json');reject(/parsed source task inventory mismatch|raw world evidence mismatch/);
   reset();const v:Receipt=JSON.parse(original);const c=v.commands.find(x=>x.name==='typecheck')!;c.command=['echo','not a typecheck'];const cmd='commands/typecheck/record.json';writeFileSync(path.join(evidence,cmd),JSON.stringify(c));v.evidence.find(f=>f.path===cmd)!.sha256=createHash('sha256').update(readFileSync(path.join(evidence,cmd))).digest('hex');writeFileSync(file,JSON.stringify(v));reject(/command invocation mismatch/);
   reset();writeFileSync(file,'null');reject(/invalid receipt/);
   reset();const out=path.join(evidence,'commands/install/stdout');rmSync(out);symlinkSync(path.join(evidence,'commands/install/stderr'),out);reject(/evidence mismatch|linked/);rmSync(out);reset();assert.equal(validate().status,0);
  });assert.equal(result.status,0,result.stderr);
 });
 test('refuses an existing evidence directory rather than overwriting attempts',()=>{
  qualify('pass','present','description',({dir,evidence})=>{const r=spawnSync('bash',[path.join(dir,'scripts/qualify-main.sh'),'--evidence-dir',evidence],{cwd:dir,env:{...process.env,QUALIFY_TEST_JS:process.execPath},encoding:'utf8',timeout:10000});assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/evidence directory must be new/);});
 });
});
