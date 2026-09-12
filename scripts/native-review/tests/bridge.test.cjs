'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {main,notify}=require('../bridge.cjs');const {read,save,hash,grokResult,deepseekResult,observe,assertSend,assertOwner}=require('../state.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-review-test-'));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){const v=fn();if(v)return v;await pause(100);}throw Error('Timed out waiting for state');}
function run(){return {text:'',promptHash:hash('hello'),tools:new Map(),promptIds:new Set(['req']),nativeEnd:{prompt_id:'req',stop_reason:'end_turn'},responseId:'resp'};}
test('Grok completion rejects foreign bindings, pending tools and non-normal endings',()=>{
 const state={sessionId:'s',model:'grok'},result={stopReason:'end_turn',_meta:{sessionId:'s',modelId:'grok',requestId:'req'}};
 assert.equal(grokResult(run(),result,state).ready,true);
 for(const mutate of [r=>r.promptIds.add('foreign'),r=>r.tools.set('tool','pending'),r=>r.permissionBlocked=true,r=>r.nativeEnd=null,r=>r.responseId=null,r=>r.protocolError=true]){const r=run();mutate(r);assert.equal(grokResult(r,result,state).ready,false);}
 assert.equal(grokResult(run(),{...result,stopReason:'cancelled'},state).ready,false);
 assert.equal(grokResult(run(),result,{...state,model:'other'}).ready,false);
});
test('DeepSeek end_turn alone cannot disguise aborted, blocked or foreign native turns',()=>{
 const state={model:'flash',provider:'uq'},result={stopReason:'end_turn'};
 const good=()=>({...run(),nativeRequestId:'req',requestTurn:1,responseTurn:1,nativeEnd:{turn:1,reason:{kind:'completed'}},source:{model:'flash',provider:'uq'}});
 assert.equal(deepseekResult(good(),result,state).ready,true);
 for(const kind of ['aborted','blocked','error']){const a=good();a.nativeEnd.reason.kind=kind;assert.equal(deepseekResult(a,result,state).ready,false);}
 for(const mutate of [a=>a.foreignInput=true,a=>a.requestTurn=2,a=>a.interrupted=true,a=>a.source.model='fallback',a=>a.nativeRequestId=null,a=>a.tools.set('tool','running')]){const a=good();mutate(a);assert.equal(deepseekResult(a,result,state).ready,false);}
});
test('Native observer binds exact prompt and ignores foreign sessions',()=>{
 const a=run(),state={sessionId:'s',backend:'deepseek-harness'};
 const message=(sessionId,text)=>({method:'review.event',params:{sessionId,event:{type:'user/message',data:{id:'req',source:{kind:'user'},content:[{type:'text',text}]}}}});
 observe(a,message('other','wrong'),state);assert.equal(a.foreignInput,undefined);
 observe(a,message('s','hello'),state);assert.equal(a.nativeRequestId,'req');
 observe(a,message('s','changed'),state);assert.equal(a.foreignInput,true);
});
test('Owner, review and notification uncertainty prevent repeat dispatch',()=>{
 const s={owner:'a',status:'ready',round:0,maxRounds:3};
 assert.throws(()=>assertOwner(s,'b'));assertSend(s);
 for(const status of ['running','dispatching','paused_reconcile','awaiting_review','complete'])assert.throws(()=>assertSend({...s,status}));
 for(const status of ['pending','uncertain'])assert.throws(()=>assertSend({...s,delivery:{status}}));
 assert.throws(()=>assertSend({...s,round:3}));
});
test('Queue acknowledgement is durable but is not automatic submission; ambiguous events do not replay',async()=>{
 for(const mode of ['ok','unknown']){
  const file=path.join(root,'notification-'+mode+'.json'),log=path.join(root,'queue-'+mode+'.jsonl');
  const state={id:mode,dispatch:{id:'d'},status:'awaiting_review',notify:'events',owner:'test'};
  const config={codexCommand:process.execPath,codexArgs:[path.join(__dirname,'mock-queue.cjs'),log,mode]};
  save(file,state);await notify(config,state,file);await notify(config,state,file);
  assert.equal(read(file).delivery.status,mode==='ok'?'queued':'uncertain');
  if(mode==='ok')assert.equal(read(file).delivery.autoSubmitted,false);
  assert.equal(fs.readFileSync(log,'utf8').trim().split('\n').length,1);
 }
});
test('Explicit direct delivery returns a completed response without adding to the user queue',async()=>{
 const directory=path.join(root,'direct');fs.mkdirSync(directory);const config=path.join(directory,'config.json');
 const queueLog=path.join(directory,'queue.jsonl');
 save(config,{version:1,codexCommand:process.execPath,codexArgs:[path.join(__dirname,'mock-queue.cjs'),queueLog,'ok'],backends:{'deepseek-harness':{command:process.execPath,args:[path.join(__dirname,'mock-acp.cjs'),'deepseek-harness'],modelSelector:'mock',provider:'mock',model:'mock',effort:'max'}}});
 const initial=await main({action:'init',config,backend:'deepseek-harness',directory,owner:'test',notify:'direct'});
 assert.equal(initial.notify,'direct');const base={cycle:initial.cycle,owner:'test'};
 try {
  const dispatch=await main({action:'send',...base,prompt:'Exact prompt'});
  const received=await main({action:'wait',...base,'dispatch-id':dispatch.dispatchId,'timeout-seconds':5});
  assert.equal(received.pending,false);assert.equal(received.state.status,'awaiting_review');assert.equal(received.response,'Done');
  assert.equal(fs.existsSync(queueLog),false);
  assert.equal(fs.readFileSync(path.join(directory,'received.jsonl'),'utf8').trim().split('\n').length,1);
  await main({action:'stop',...base});
  const stopped=await main({action:'wait',...base,'dispatch-id':dispatch.dispatchId,'timeout-seconds':1});
  assert.equal(stopped.state.status,'paused_stopped');assert.equal(stopped.state.runtimeExited,true);
 }finally{if(fs.existsSync(path.join(initial.cycle,'worker.lock')))await main({action:'stop',...base});}
});
test('Wait binds owner and dispatch, wakes on atomic state updates, and does not mutate or retry on timeout',async()=>{
 const cycle=path.join(root,'wait-check');fs.mkdirSync(cycle);const file=path.join(cycle,'state.json');
 const state={owner:'test',status:'running',dispatch:{id:'one'}};save(file,state);
 await assert.rejects(main({action:'wait',cycle,owner:'other'}),/owner mismatch/);
 await assert.rejects(main({action:'wait',cycle,owner:'test','dispatch-id':'other'}),/matching dispatch/);
 await assert.rejects(main({action:'wait',cycle,owner:'test','timeout-seconds':61}),/timeout/);
 const before=fs.readFileSync(file,'utf8');
 const timeout=await main({action:'wait',cycle,owner:'test','timeout-seconds':0.02});
 assert.equal(timeout.pending,true);assert.equal(timeout.timedOut,true);assert.equal(fs.readFileSync(file,'utf8'),before);
 const observing=main({action:'wait',cycle,owner:'test','timeout-seconds':2});
 const responseFile=path.join(cycle,'response.txt');fs.writeFileSync(responseFile,'The result');
 save(file,{...state,status:'awaiting_review',lastResponseFile:responseFile});
 const received=await observing;assert.equal(received.pending,false);assert.equal(received.response,'The result');
 save(file,state);const changed=main({action:'wait',cycle,owner:'test','timeout-seconds':2});
 save(file,{...state,dispatch:{id:'two'}});await assert.rejects(changed,/Dispatch changed/);
});
for(const backend of ['grok-build','deepseek-harness'])test(backend+' full lifecycle: exact text, same-session repair, no duplicate and clean completion',async()=>{
 const directory=path.join(root,backend);fs.mkdirSync(directory);const config=path.join(directory,'config.json');
 save(config,{version:1,backends:{[backend]:{command:process.execPath,args:[path.join(__dirname,'mock-acp.cjs'),backend],modelSelector:'mock',provider:'mock',model:'mock',effort:backend==='grok-build'?'xhigh':'max'}}});
 const initial=await main({action:'init',config,backend,directory,owner:'test',notify:'manual'});assert.equal(initial.status,'ready');
 const cycle=initial.cycle,stateFile=path.join(cycle,'state.json'),base={cycle,owner:'test'};
 try {
  const prompt='hello\n`literal` $() 中文';
  await main({action:'send',...base,prompt});
  await assert.rejects(main({action:'send',...base,prompt}));
  await assert.rejects(main({action:'stop',...base,owner:'foreign'}));
  let state=await until(()=>read(stateFile).status==='awaiting_review'&&read(stateFile));
  assert.equal(fs.readFileSync(path.join(directory,'probe.txt'),'utf8'),prompt);
  assert.equal(state.round,1);assert.equal((await main({action:'reconcile',...base})).proof.ready,true);
  const report=path.join(directory,'report.md');fs.writeFileSync(report,'Independently checked mock artifact.');
  await assert.rejects(main({action:'review',...base,'response-id':'wrong',report,outcome:'complete'}));
  await main({action:'review',...base,'response-id':state.responseId,report,outcome:'changes_requested'});
  await main({action:'send',...base,prompt:'SECOND'});
  state=await until(()=>read(stateFile).status==='awaiting_review'&&read(stateFile));
  assert.equal(state.sessionId,initial.sessionId);assert.equal(state.round,2);
  assert.equal(fs.readFileSync(path.join(directory,'received.jsonl'),'utf8').trim().split('\n').length,2);
  await main({action:'review',...base,'response-id':state.responseId,report,outcome:'complete'});
  await until(()=>!fs.existsSync(path.join(cycle,'worker.lock')));
  assert.equal(read(stateFile).status,'complete');assert.equal(read(stateFile).runtimeExited,true);
 } finally {if(fs.existsSync(path.join(cycle,'worker.lock')))await main({action:'stop',...base});}
});
test('Hard runtime bound stops an unresponsive turn and preserves paused state',async()=>{
 const directory=path.join(root,'timeout');fs.mkdirSync(directory);const config=path.join(directory,'config.json');
 save(config,{version:1,backends:{'grok-build':{command:process.execPath,args:[path.join(__dirname,'mock-acp.cjs'),'grok-build'],modelSelector:'mock',model:'mock',effort:'xhigh'}}});
 const s=await main({action:'init',config,backend:'grok-build',directory,owner:'test',notify:'manual','max-runtime':'1'});
 try {
  await main({action:'send',cycle:s.cycle,owner:'test',prompt:'HANG'});
  const state=await until(()=>{const a=read(path.join(s.cycle,'state.json'));return a.status==='paused_timeout'&&a;});
  assert.equal(state.runtimeExited,true);
  const result=await main({action:'reconcile',cycle:s.cycle,owner:'test'});assert.equal(result.proof.ready,false);assert.equal(result.state.status,'paused_timeout');
 }finally{if(fs.existsSync(path.join(s.cycle,'worker.lock')))await main({action:'stop',cycle:s.cycle,owner:'test'});}
});

for(const prompt of ['COMPACT_SLOW','STALL_RESUME'])test(prompt+' completes through wait, preserving binding and clearing stale stall alerts',async()=>{
 const directory=path.join(root,prompt);fs.mkdirSync(directory);const config=path.join(directory,'config.json');
 save(config,{version:1,backends:{'deepseek-harness':{command:process.execPath,args:[path.join(__dirname,'mock-acp.cjs'),'deepseek-harness'],modelSelector:'mock',provider:'mock',model:'mock',effort:'max'}}});
 const initial=await main({action:'init',config,backend:'deepseek-harness',directory,owner:'test',notify:'direct','stall-seconds':'1','compaction-stall-seconds':'3','max-runtime':'6'});
 const base={cycle:initial.cycle,owner:'test'};
 try{
  const sent=await main({action:'send',...base,prompt});
  let result=await main({action:'wait',...base,'dispatch-id':sent.dispatchId,'timeout-seconds':4});
  if(prompt==='STALL_RESUME') {
   assert.equal(result.state.problemCode,'stalled');
   await until(()=>read(path.join(initial.cycle,'state.json')).status==='awaiting_review');
   result=await main({action:'wait',...base,'dispatch-id':sent.dispatchId,'timeout-seconds':1});
  }
  assert.equal(result.state.status,'awaiting_review');assert.equal(result.state.problem,null);assert.equal(result.response,'Done');
  assert.equal((await main({action:'reconcile',...base})).proof.ready,true);
 }finally{await main({action:'stop',...base});}
});
