'use strict';
const fs=require('node:fs');const path=require('node:path');const readline=require('node:readline');
const backend=process.argv[2],sessionId='mock-session';let turn=0,seq=0;
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\n');
(async()=>{
const handlers=new Map();(await import('../deepseek-events.mjs')).default({on:(name,fn)=>handlers.set(name,fn)});
const nativeSession={id:sessionId,header:{id:sessionId,cwd:process.cwd()},seq:0};
const event=(type,data)=>handlers.get('session/event')(nativeSession,{type,seq:seq++,time:Date.now(),data});
const pendingPermissions=new Map();
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);const reply=result=>send({id:m.id,result});
 if(!m.method&&pendingPermissions.has(m.id)){const finish=pendingPermissions.get(m.id);pendingPermissions.delete(m.id);fs.writeFileSync(path.join(process.cwd(),'permission-reply.json'),JSON.stringify(m));finish();return;}
 if(m.method==='initialize')return reply({protocolVersion:1});
 if(m.method==='session/new') {
  if(backend==='deepseek-harness')handlers.get('session/created')(nativeSession);
  return reply({sessionId,models:{currentModelId:'mock'},_meta:{currentWorkingDirectory:process.cwd(),'x.ai/sessionConfig':{options:[{id:'xhigh',selected:true}]}},configOptions:[{id:'model',category:'model',options:[{value:'mock'}]}]});
 }
 if(m.method==='session/set_config_option')return reply({configOptions:[{id:'reasoning_effort',currentValue:'max'}]});
 if(m.method==='session/close')return reply({});
 if(m.method==='session/cancel')return;
 if(m.method!=='session/prompt')return;
 fs.appendFileSync(path.join(process.cwd(),'received.jsonl'),JSON.stringify(m)+'\n');
 const text=m.params.prompt[0].text,requestId='request-'+(++turn);event('turn/start',{turn});
 if(backend==='deepseek-harness')event('user/message',{id:requestId,source:{kind:'user'},content:[{type:'text',text}]});
 if(text==='HANG')return;
 if(text==='COMPACT_SLOW'||text==='COMPACT_FAIL') event('compaction/start',{turn,compactionId:'compact-a'});
 const finish=()=>setTimeout(()=>{
  fs.writeFileSync(path.join(process.cwd(),'probe.txt'),text);
  if(backend==='deepseek-harness') {
   if(text==='COMPACT_SLOW') {
    event('compaction/summary',{compactionId:'compact-a'});
    event('user/message',{id:'checkpoint',source:{kind:'plugin',plugin:'compact',compactionId:'compact-a'},content:[{type:'text',text:'summary'}]});
    event('compaction/end',{turn,compactionId:'compact-a'});
   }
   if(text==='COMPACT_FAIL')event('compaction/end',{turn,compactionId:'compact-a',error:{message:'simulated failure'}});
   event('tool/call',{callId:'t'+turn,name:'write'});event('tool/result',{message:{content:[{type:'tool-result',toolCallId:'t'+turn}]}});
   if(text==='MALFORMED')event('tool/result',{message:{content:[]}});
   event('assistant/message',{turn,message:{id:'response-'+turn,source:{provider:'mock',model:'mock'},content:[{type:'text',text:'Done'}]}});
   event('turn/end',{turn,reason:{kind:'completed'}});reply({stopReason:'end_turn'});
  }else {
   send({method:'session/update',params:{sessionId,_meta:{promptId:requestId,eventId:'response-'+turn},update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Done'}}}});
   send({method:'_x.ai/session_notification',params:{sessionId,_meta:{eventId:'end-'+turn},update:{sessionUpdate:'turn_completed',prompt_id:requestId,stop_reason:'end_turn'}}});
   reply({stopReason:'end_turn',_meta:{sessionId,requestId,modelId:'mock'}});
  }
 },['COMPACT_SLOW','STALL_RESUME'].includes(text)?1600:100);
 if(text==='PERMISSION'){
  const id='permission-'+turn;pendingPermissions.set(id,finish);
  send({id,method:'session/request_permission',params:{sessionId,options:[{kind:'allow_once',optionId:'once'},{kind:'reject_once',optionId:'deny'}]}});
 }else finish();
});
})().catch(error=>{console.error(error);process.exitCode=1;});
