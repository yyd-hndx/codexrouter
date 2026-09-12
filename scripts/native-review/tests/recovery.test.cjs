'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {main}=require('../bridge.cjs');
const {save,read,evidence,lock}=require('../state.cjs');
const {cleanup}=require('../lifecycle.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-recovery-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(name,permission='reject') {
 const directory=path.join(root,name);fs.mkdirSync(directory);
 const config=path.join(directory,'config.json');
 save(config,{version:1,backends:{'deepseek-harness':{command:process.execPath,args:[path.join(__dirname,'mock-acp.cjs'),'deepseek-harness'],modelSelector:'mock',provider:'mock',model:'mock',effort:'max'}}});
 const initial=await main({action:'init',config,backend:'deepseek-harness',directory,owner:'test',permission,notify:'direct'});
 return {directory,cycle:initial.cycle,owner:'test'};
}
async function finish(f,prompt) {
 const sent=await main({action:'send',...f,prompt});
 return main({action:'wait',...f,'dispatch-id':sent.dispatchId,'timeout-seconds':5});
}
async function stop(f) {
 await main({action:'stop',...f});
 for(let i=0;i<100&&fs.existsSync(path.join(f.cycle,'worker.lock'));i++)await delay(50);
 assert.equal(fs.existsSync(path.join(f.cycle,'worker.lock')),false);
}
test('allow_once permissions are journaled and reconcile agrees with the live worker',async()=>{
 const f=await fixture('permission-allowed','allow_once');
 try {
  const r=await finish(f,'PERMISSION');assert.equal(r.state.status,'awaiting_review');
  const state=read(path.join(f.cycle,'state.json'));
  const records=fs.readFileSync(path.join(f.cycle,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(evidence(state,records).ready,true);
  assert.equal((await main({action:'reconcile',...f})).proof.ready,true);
  const request=records.find(e=>e.message.method==='session/request_permission');
  const response=records.find(e=>e.message.direction==='out'&&e.message.id===request.message.id);
  assert.equal(response.message.result.outcome.optionId,'once');
  for(const change of [
   a=>a.filter(e=>e.message.direction!=='out'||e.message.id!==request.message.id),
   a=>{a.find(e=>e.message.direction==='out'&&e.message.id===request.message.id).message.result.outcome.optionId='deny';return a},
   a=>{a.find(e=>e.message.method==='session/request_permission').message.params.sessionId='foreign';return a},
   a=>{a.find(e=>e.message.direction==='out'&&e.message.id===request.message.id).message.id='orphan';return a},
   a=>{const i=a.findIndex(e=>e.message.method==='session/request_permission');a.splice(i,0,structuredClone(a[i]));return a},
  ])assert.equal(evidence(state,change(structuredClone(records))).ready,false);
  assert.equal(evidence({...state,permission:'reject'},records).ready,false);
 }finally{await stop(f);}
});
for(const [prompt,reason] of [['PERMISSION','attention_required'],['COMPACT_FAIL','compaction_failed_requires_review'],['MALFORMED','attention_required']])test(prompt+' cannot certify success and does not crash the observer',async()=>{
 const f=await fixture(prompt);
 try {const r=await finish(f,prompt);assert.equal(r.state.status,'paused_attention');assert.equal(r.state.stopReason,reason);assert.equal((await main({action:'reconcile',...f})).proof.ready,false);}
 finally{await stop(f);}
});
test('Cleanup releases a real lock even when close, notifications or persistence fails',async()=>{
 for(const stage of ['close','notifications','persist']) {
  const file=path.join(root,stage+'.lock'),unlock=lock(file),visited=[];
  const tasks=Object.fromEntries(['close','notifications','persist'].map(name=>[name,async()=>{visited.push(name);if(name===stage)throw Error(name)}]));
  await assert.rejects(cleanup({...tasks,unlock}),/Worker cleanup incomplete/);
  assert.equal(fs.existsSync(file),false);assert.deepEqual(visited,['close','notifications','persist']);
 }
});
test('A late stop acknowledgement beyond 15 seconds is received without resubmission',async()=>{
 const cycle=path.join(root,'late');fs.mkdirSync(path.join(cycle,'commands'),{recursive:true});fs.mkdirSync(path.join(cycle,'replies'));
 save(path.join(cycle,'state.json'),{owner:'test'});const unlock=lock(path.join(cycle,'worker.lock'));
 let timer;
 try {
  const pending=main({action:'stop',cycle,owner:'test'});
  const files=fs.readdirSync(path.join(cycle,'commands'));assert.equal(files.length,1);
  timer=setTimeout(()=>save(path.join(cycle,'replies',files[0]),{ok:true,result:{status:'paused_stopped',runtimeExited:true}}),15300);
  assert.equal((await pending).runtimeExited,true);assert.equal(fs.readdirSync(path.join(cycle,'commands')).length,1);
  await assert.rejects(main({action:'stop',cycle,owner:'test','command-timeout-seconds':0}),/timeout/);
  assert.equal(fs.readdirSync(path.join(cycle,'commands')).length,1);
 }finally{clearTimeout(timer);unlock();}
});
test('Unverified previous runtime exit blocks creation after a cleanup failure',async()=>{
 const f=await fixture('unverified-exit');await stop(f);
 const stateFile=path.join(f.cycle,'state.json'),state=read(stateFile);
 save(stateFile,{...state,status:'paused_error',runtimeExited:false});
 await assert.rejects(main({action:'init',directory:f.directory,config:state.configFile,backend:'deepseek-harness',owner:'test'}),/runtime exit is unverified/);
 save(stateFile,state);
});
test('Transient Windows atomic replacement failure retries locally without losing old state',()=>{
 if(process.platform!=='win32')return;
 const file=path.join(root,'atomic.json');save(file,{version:1});
 const rename=fs.renameSync;let attempts=0;
 try {
  fs.renameSync=(...args)=>{if(++attempts<3)throw Object.assign(Error('busy'),{code:'EPERM'});return rename(...args);};
  save(file,{version:2});assert.equal(read(file).version,2);assert.equal(attempts,3);
 }finally{fs.renameSync=rename;}
 try {
  fs.renameSync=()=>{throw Object.assign(Error('denied'),{code:'EACCES'});};
  assert.throws(()=>save(file,{version:3}),/denied/);assert.equal(read(file).version,2);
 }finally{fs.renameSync=rename;}
 assert.equal(fs.readdirSync(root).some(name=>name.startsWith('atomic.json.')&&name.endsWith('.tmp')),false);
});
