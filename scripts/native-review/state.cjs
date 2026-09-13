'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const now = () => new Date().toISOString();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`; const content = JSON.stringify(value, null, 2) + '\n';
  const fd = fs.openSync(temp, 'wx'); try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    // Windows readers/antivirus can briefly hold a replacement target open.
    for(let attempt=0;;attempt++) {
      try {fs.renameSync(temp,file);break;}
      catch(error) {
        if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=10)throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      }
    }
    if (fs.readFileSync(file, 'utf8') !== content) throw Error('State verification failed');
  } finally {try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
function lock(file) { const fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: now() })); return () => { fs.closeSync(fd); fs.unlinkSync(file); }; }
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function assertOwner(state, owner) { if (!owner || state.owner !== owner) throw Error('Cycle owner mismatch'); }
function assertSend(state) {
  if (!['ready', 'reviewed_changes_requested'].includes(state.status)) throw Error('Cycle not ready; inspect or reconcile before sending');
  if (state.round >= state.maxRounds) throw Error('Authorized round limit reached');
  if (state.delivery?.status === 'uncertain' || state.delivery?.status === 'pending') throw Error('Notification delivery needs reconciliation');
}
function grokResult(active, result, state) {
  const meta = result?._meta;
  if (result?.stopReason !== 'end_turn') return { ready: false, reason: result?.stopReason || 'missing_stop_reason' };
  if (!meta?.requestId || meta.sessionId !== state.sessionId || meta.modelId !== state.model) return { ready: false, reason: 'result_binding_mismatch' };
  if (!active.promptIds.size || [...active.promptIds].some(id => id !== meta.requestId)) return { ready: false, reason: 'event_binding_mismatch' };
  if (!active.nativeEnd || active.nativeEnd.prompt_id !== meta.requestId || active.nativeEnd.stop_reason !== 'end_turn') return { ready: false, reason: 'missing_native_end' };
  if (!active.responseId && !active.nativeEndId) return {ready:false,reason:'missing_response_id'};
  if ([...active.tools.values()].some(s => ['pending','in_progress','running'].includes(s))) return { ready: false, reason: 'pending_tools' };
  if (active.permissionBlocked || active.protocolError) return { ready: false, reason: 'attention_required' };
  return { ready: true, requestId: meta.requestId, responseId: active.responseId || active.nativeEndId, reason: 'end_turn' };
}
function deepseekResult(active, result, state) {
  if (result?.stopReason !== 'end_turn' || active.nativeEnd?.reason?.kind !== 'completed') return { ready:false, reason:active.nativeEnd?.reason?.kind || result?.stopReason || 'missing_native_end' };
  if (!active.nativeRequestId || active.foreignInput || active.responseTurn !== active.nativeEnd.turn || active.requestTurn !== active.nativeEnd.turn || active.interrupted || !active.responseId) return { ready:false, reason:'native_binding_mismatch' };
  if (active.source?.model !== state.model || active.source?.provider !== state.provider) return {ready:false,reason:'model_binding_mismatch'};
  if (active.compactions?.size || active.compactionBindingError) return {ready:false,reason:'compaction_incomplete_or_mismatched'};
  if (active.compactionFailed) return {ready:false,reason:'compaction_failed_requires_review'};
  if (active.permissionBlocked || active.protocolError || [...active.tools.values()].some(s=>['pending','running','in_progress'].includes(s))) return {ready:false,reason:'attention_required'};
  return {ready:true,requestId:active.nativeRequestId,responseId:active.responseId,reason:'completed'};
}
function observe(active, message, state) {
  if (message.params?.sessionId !== state.sessionId) return;
  active.lastProgress=Date.now();const params=message.params,update=params.update;
  if (message.method==='review.event') {
    const event=params.event,data=event.data;
    if(event.type==='protocol/error')active.protocolError=true;
    if(event.type==='step/start') active.retry=null;
    if(event.type==='llm/retry') {
      if(data.turn!==active.currentTurn || !data.retryId || !Number.isInteger(data.retry) || data.retry<1
        || !Number.isFinite(data.delayMs) || data.delayMs<0) active.protocolError=true;
      else { active.retry={...data,phase:'backoff'};active.retryCount=(active.retryCount||0)+1; }
    }
    if(event.type==='llm/retry-started') {
      if(!active.retry || data.turn!==active.currentTurn || data.retryId!==active.retry.retryId || data.retry!==active.retry.retry) active.protocolError=true;
      else active.retry.phase='requesting';
    }
    if(event.type==='compaction/start') {
      active.compactions ||= new Map();
      if(!data.compactionId || active.compactions.has(data.compactionId) || data.turn!==active.currentTurn) active.compactionBindingError=true;
      else active.compactions.set(data.compactionId,{turn:data.turn,startedAt:Date.now()});
    }
    if(event.type==='compaction/summary' && !active.compactions?.has(data.compactionId)) active.compactionBindingError=true;
    if(event.type==='compaction/end') {
      const start=active.compactions?.get(data.compactionId);
      if(!start || start.turn!==data.turn) active.compactionBindingError=true;
      else {
        active.compactions.delete(data.compactionId);
        if(data.error) {active.compactionFailed=true;active.compactionFailureCount=(active.compactionFailureCount||0)+1;}
        else active.compactionCount=(active.compactionCount||0)+1;
      }
    }
    if(event.type==='turn/start')active.currentTurn=data.turn;
    if(event.type==='user/message'&&data.source?.kind==='user') {
      const text=(data.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
      if(hash(text)!==active.promptHash||(active.nativeRequestId&&active.nativeRequestId!==data.id))active.foreignInput=true;
      else {active.nativeRequestId=data.id;active.requestTurn=active.currentTurn;}
    }
    if(event.type==='agent/inbox/spliced'&&(data.inserted||[]).some(m=>m.source?.kind==='user'&&hash((m.content||[]).filter(p=>p.type==='text').map(p=>p.text).join(''))!==active.promptHash))active.foreignInput=true;
    if(event.type==='assistant/message') {active.responseId=data.id;active.responseEventId=`${state.sessionId}:${event.seq}`;active.source=data.source;active.responseTurn=data.turn;active.interrupted=!!data.interrupted;active.text=data.text||active.text;}
    if(event.type==='turn/end')active.nativeEnd=data;
    if(event.type==='tool/call')active.tools.set(data.callId,'pending');
    if(event.type==='tool/result')active.tools.set(data.message.toolCallId,'completed');
    return;
  }
  if(params._meta?.promptId)active.promptIds.add(params._meta.promptId);
  if(update?.sessionUpdate==='agent_message_chunk'&&state.backend!=='deepseek-harness') {active.text+=update.content?.text||'';active.responseId=params._meta?.eventId||active.responseId;}
  if(['tool_call','tool_call_update'].includes(update?.sessionUpdate))active.tools.set(update.toolCallId,update.status||active.tools.get(update.toolCallId)||'pending');
  if(message.method==='_x.ai/session_notification'&&update?.sessionUpdate==='turn_completed') {active.nativeEnd=update;active.nativeEndId=params._meta?.eventId;}
}
function progress(active, state, timestamp=Date.now()) {
  const compacting=!!active.compactions?.size;
  const allowance=Math.max((compacting ? (state.compactionStallSeconds ?? Math.max(600,state.stallSeconds)) : state.stallSeconds)*1000,
    active.retry?.phase==='backoff' ? active.retry.delayMs+1000 : 0);
  return {phase:compacting?'compacting':active.retry?.phase==='backoff'?'retry_backoff':'running',compactionCount:active.compactionCount||0,
    retryCount:active.retryCount||0,retry:active.retry||null,
    compactionFailureCount:active.compactionFailureCount||0,
    lastProgressAt:new Date(active.lastProgress).toISOString(),stalled:timestamp-active.lastProgress>allowance};
}
function evidence(state, records) {
  const active={promptHash:state.dispatch.promptHash,text:'',tools:new Map(),promptIds:new Set()};let result, submitted=false;
  const permissions=new Map(),seenPermissionIds=new Set();
  for(const entry of records) {
    if(entry.dispatchId!==state.dispatch.id)continue;
    const m=entry.message;
    if(m.direction==='out'&&m.method==='session/prompt') {
      if(m.id!==state.dispatch.rpcId||m.params.sessionId!==state.sessionId||hash(m.params.prompt.map(p=>p.text).join(''))!==state.dispatch.promptHash)return {ready:false,reason:'journal_binding_mismatch'};
      submitted=true;
    } else if(m.direction==='out' && !m.method) {
      const request=permissions.get(m.id);
      if(!request)return {ready:false,reason:'permission_reply_without_request'};
      permissions.delete(m.id);
      const outcome=m.result?.outcome;
      const selected=request.params.options.find(o=>o.optionId===outcome?.optionId);
      if(m.error || outcome?.outcome!=='selected' || selected?.kind!=='allow_once'
        || state.permission!=='allow_once')return {ready:false,reason:'permission_not_authorized'};
    } else if(m.method==='session/request_permission' && m.id!==undefined) {
      if(!submitted || m.params?.sessionId!==state.sessionId || m.id===state.dispatch.rpcId
        || seenPermissionIds.has(m.id) || !Array.isArray(m.params.options)
        || m.params.options.some(o=>!o || typeof o.optionId!=='string')
        || new Set(m.params.options.map(o=>o.optionId)).size!==m.params.options.length)
        return {ready:false,reason:'permission_binding_mismatch'};
      seenPermissionIds.add(m.id);permissions.set(m.id,m);
    } else if(m.id===state.dispatch.rpcId&&!m.method)result=m.result;
    else if(m.method&&m.id!==undefined)return {ready:false,reason:'client_operation_requires_manual_inspection'};
    else observe(active,m,state);
  }
  if(!submitted||!result)return {ready:false,reason:'incomplete_evidence'};
  if(permissions.size)return {ready:false,reason:'permission_reply_missing'};
  return {...(state.backend==='deepseek-harness'?deepseekResult(active,result,state):grokResult(active,result,state)),responseEventId:active.responseEventId};
}
module.exports = { now, read, save, lock, hash, assertOwner, assertSend, grokResult, deepseekResult, observe, evidence, progress };
