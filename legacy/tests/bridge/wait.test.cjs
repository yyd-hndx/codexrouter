const test=require('node:test');const assert=require('node:assert/strict');
const {waitForResult}=require('../../outputs/opencode-wait.cjs');
const {hash,marker}=require('../../outputs/opencode-state.cjs');
function fixture(compactions=0) {
 const prompt='task\n\n'+marker('dispatch');
 let cycle={model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId:'owner',sessionId:'session',directory:'E:/project',codeDirectory:'E:/project',scope:'test',status:'waiting_for_grok',round:1,submittedMessageId:'original',dispatch:{id:'dispatch',promptHash:hash(prompt)}};
 const user=(id,parts)=>({info:{id,role:'user',sessionID:'session'},parts});
 const answer=(id,parentID,extra={})=>({info:{id,role:'assistant',sessionID:'session',parentID,finish:'stop',time:{completed:100},...extra},parts:[{type:'text',text:'完整结果'.repeat(2000)}]});
 let messages=[user('original',[{type:'text',text:prompt}])];let parent='original';
 for(let i=0;i<compactions;i++) {
  messages.push(user('compact'+i,[{type:'compaction',auto:true}]),answer('summary'+i,'compact'+i,{summary:true,mode:'compaction',agent:'compaction'}),user('continue'+i,[{type:'text',text:'continue',synthetic:true,metadata:{compaction_continue:true}}]));parent='continue'+i;
 }
 messages.push(answer('final',parent));
 const input={threadId:'owner',sessionId:'session',directory:'E:/project',dispatchId:'dispatch',timeoutSeconds:0.025};
 const calls=[];
 const deps={read:()=>structuredClone(cycle),wait:()=>new Promise(r=>setTimeout(r,1)),api:async route=>{calls.push(route);return route.endsWith('/message')?structuredClone(messages):route==='/session/session'?{directory:'E:/project'}:route==='/session/status'?{}:[];}};
 return {input,deps,calls,get cycle(){return cycle},get messages(){return messages},set messages(v){messages=v}};
}
test('Direct wait returns full result across repeated compactions, with original binding and no state mutations',async()=>{
 for(const n of [0,1,3]) {
  const f=fixture(n),before=JSON.stringify(f.cycle),result=await waitForResult(f.input,f.deps);
  assert.equal(result.completed,true);assert.equal(result.response,'完整结果'.repeat(2000));
  assert.equal(result.requestBinding.originalRequestId,'original');assert.equal(result.requestBinding.compactions.length,n);
  assert.equal(JSON.stringify(f.cycle),before);assert.ok(f.calls.every(r=>!r.includes('prompt')));
 }
});
test('A completed compaction summary alone times out without being returned as task completion',async()=>{
 const f=fixture(1);f.messages=f.messages.slice(0,3);
 const result=await waitForResult(f.input,f.deps);
 assert.equal(result.pending,true);assert.equal(result.timedOut,true);assert.equal(result.progress,'compacting');assert.equal(result.response,undefined);
});
test('Wait after a bounded timeout receives later completion without a new send',async()=>{
 const f=fixture(),completed=f.messages;f.messages=f.messages.slice(0,1);
 assert.equal((await waitForResult(f.input,f.deps)).timedOut,true);
 f.messages=completed;assert.equal((await waitForResult(f.input,f.deps)).completed,true);
});
test('Wrong owner, directory, dispatch and mid-read ownership changes are rejected',async()=>{
 for(const change of [{threadId:'other'},{directory:'E:/other'},{dispatchId:'other'},{sessionId:'other'}]) {
  const f=fixture();await assert.rejects(waitForResult({...f.input,...change},f.deps));assert.equal(f.calls.length,0);
 }
 const f=fixture(),api=f.deps.api;f.deps.api=async(...args)=>{f.cycle.codexThreadId='new-owner';return api(...args)};
 await assert.rejects(waitForResult(f.input,f.deps),/owner mismatch/);
});
test('Unrelated newer input is not accepted or exposed as the requested result',async()=>{
 const f=fixture();f.messages[0].parts[0].text='foreign prompt';
 const result=await waitForResult(f.input,f.deps);
 assert.equal(result.completed,false);assert.equal(result.notice.reason,'binding_mismatch');assert.equal(result.response,undefined);
});
test('Stopped cycles and API failures are returned without queueing or resending',async()=>{
 const f=fixture();f.cycle.status='paused_user';assert.equal((await waitForResult(f.input,f.deps)).reason,'cycle_not_active');assert.equal(f.calls.length,0);
 f.cycle.status='waiting_for_grok';f.deps.api=async()=>{throw Error('offline')};
 const result=await waitForResult(f.input,f.deps);assert.equal(result.needsAttention,true);assert.equal(result.reason,'snapshot_unavailable');
});
