import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import observer from '../deepseek-events.mjs';
const require=createRequire(import.meta.url);const {observe,deepseekResult,progress,hash}=require('../state.cjs');
const state={backend:'deepseek-harness',sessionId:'session',provider:'deepseek-official',model:'deepseek-flash',stallSeconds:300,compactionStallSeconds:600};
function fixture() {
 const handlers=new Map();observer({on:(name,fn)=>handlers.set(name,fn)});
 const active={promptHash:hash('original'),text:'',tools:new Map(),promptIds:new Set()};let seq=0;const frames=[];
 function emit(type,data) {
  const write=process.stdout.write;process.stdout.write=chunk=>{frames.push(JSON.parse(String(chunk)));return true};
  try{handlers.get('session/event')({id:'session'},{type,data,seq:++seq,time:Date.now()})}finally{process.stdout.write=write}
  for(const frame of frames.splice(0))observe(active,frame,state);
 }
 emit('turn/start',{turn:1});emit('user/message',{id:'original-id',source:{kind:'user'},content:[{type:'text',text:'original'}]});
 const start=id=>emit('compaction/start',{turn:1,compactionId:id});
 const end=id=>emit('compaction/end',{turn:1,compactionId:id});
 const compact=id=>{start(id);emit('compaction/summary',{compactionId:id,summary:'Private checkpoint'});emit('user/message',{id:'checkpoint-'+id,source:{kind:'plugin',plugin:'compact',compactionId:id},content:[{type:'text',text:'summary'}]});end(id)};
 const finish=(turn=1)=>{emit('assistant/message',{turn,message:{id:'final',source:{provider:state.provider,model:state.model},content:[{type:'text',text:'RESULT'}]}});emit('turn/end',{turn,reason:{kind:'completed'}});return deepseekResult(active,{stopReason:'end_turn'},state)};
 return {active,emit,start,end,compact,finish};
}
test('Repeated native compaction retains original request and returns only final task output',()=>{
 const f=fixture();for(let i=0;i<3;i++)f.compact('c'+i);
 assert.equal(deepseekResult(f.active,{stopReason:'end_turn'},state).ready,false);
 assert.equal(f.finish().ready,true);assert.equal(f.active.nativeRequestId,'original-id');assert.equal(f.active.text,'RESULT');assert.equal(f.active.compactionCount,3);
});
test('Pending, foreign and duplicate compaction lifecycle cannot certify completion',()=>{
 for(const mutate of [f=>f.start('pending'),f=>f.end('foreign'),f=>{f.start('dup');f.start('dup');f.end('dup')}]) {
  const f=fixture();mutate(f);assert.equal(f.finish().ready,false);
 }
 const f=fixture();f.compact('ok');assert.equal(f.finish(2).ready,false);
});
test('Compaction progress has a bounded grace period and restores normal stall detection on exit',()=>{
 const f=fixture();f.start('slow');f.active.lastProgress=1000;
 assert.equal(progress(f.active,state,302000).stalled,false);assert.equal(progress(f.active,state,602000).stalled,true);
 assert.equal(progress(f.active,state,302000).phase,'compacting');f.end('slow');f.active.lastProgress=1000;
 assert.equal(progress(f.active,state,302000).stalled,true);assert.equal(progress(f.active,state).phase,'running');
});
test('Failed compaction remains distinguishable from success and requires manual inspection',()=>{
 const f=fixture();f.start('failed');f.emit('compaction/end',{turn:1,compactionId:'failed',error:{message:'private detail'}});
 assert.equal(f.active.compactionCount,undefined);assert.equal(f.active.compactionFailureCount,1);
 assert.equal(f.finish().reason,'compaction_failed_requires_review');
});
test('Malformed raw observer events become protocol errors without throwing or leaking payloads',()=>{
 for(const [type,data] of [['assistant/message',{}],['assistant/message',{message:{id:'a',source:{provider:'p',model:'m'},content:[null]}}],['tool/result',{message:{content:[]}}],['tool/result',{}],['tool/call',{}]]) {
  const f=fixture();assert.doesNotThrow(()=>f.emit(type,data));
  assert.equal(f.active.protocolError,true);assert.equal(f.finish().ready,false);
 }
});
