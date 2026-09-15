'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {hash} = require('./state.cjs');
const normalize = value => path.resolve(value).replace(/\\/g,'/').toLowerCase();
const json = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));

// Only metadata is returned to cycle state. Credentials stay in the RPC payload.
function resolveRoute(spec, directory) {
  const home=spec.zcodeHome || path.join(os.homedir(),'.zcode');
  const config=json(path.join(home,'v2','config.json'));
  let selected, selectionSource='explicit';
  if(Boolean(spec.provider)!==Boolean(spec.model)) throw Error('ZCode requires both provider and model, or neither');
  if(spec.provider) selected={providerId:spec.provider,modelId:spec.model,effort:spec.effort};
  else {
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(path.join(home,'v2','tasks-index.sqlite'),{readOnly:true});
    let tasks;
    try {tasks=db.prepare("SELECT model,workspace_path,meta_json FROM tasks WHERE deleted=0 AND archived=0 AND provider='glm' AND model IS NOT NULL ORDER BY updated_at DESC").all();}
    finally {db.close();}
    const project=tasks.find(t=>normalize(t.workspace_path)===normalize(directory));
    const task=project||tasks[0];
    if(!task) throw Error('No configured ZCode desktop task model; select a model in ZCode or configure an explicit route');
    const providerId=Object.keys(config.provider||{}).sort((a,b)=>b.length-a.length).find(p=>task.model.startsWith(p+'/'));
    if(!providerId) throw Error('Desktop model provider is no longer configured');
    selected={providerId,modelId:task.model.slice(providerId.length+1),effort:JSON.parse(task.meta_json||'{}').thoughtLevel};
    selectionSource=project?'desktop-project-task':'desktop-last-task';
  }
  const provider=config.provider?.[selected.providerId], model=provider?.models?.[selected.modelId];
  if(!model||provider.enabled===false||provider.systemDisabledReason) throw Error('Selected ZCode model is unavailable');
  if(!['anthropic','openai','openai-compatible'].includes(provider.kind)) throw Error('Unsupported ZCode provider kind');
  const options=provider.options||{};
  if(!options.apiKey && options.apiKeyRequired!==false) throw Error('This adapter requires an existing API-key/custom provider; desktop OAuth is not supported');
  let effort=spec.effort||selected.effort||model.reasoning?.defaultVariant;
  if(effort && !model.reasoning?.variants?.includes(effort)) throw Error('Selected ZCode reasoning effort is not advertised');
  const runtimeModel={revision:crypto.randomUUID(),generatedAt:Date.now(),
    model:{providerId:selected.providerId,modelId:selected.modelId},
    ...(effort?{thoughtLevel:effort}:{}),provider:{providerId:selected.providerId,kind:provider.kind,label:provider.name||selected.providerId,
      ...(options.baseURL?{baseURL:options.baseURL}:{}),apiKeyRequired:options.apiKeyRequired,
      ...(options.apiKey?{apiKey:{source:'inline',value:options.apiKey}}:{}),
      ...(options.headers?{headers:options.headers}:{}),...(options.providerOptions?{providerOptions:options.providerOptions}:{}),
      models:[{modelId:selected.modelId,contextWindow:model.limit?.context,maxOutputTokens:model.limit?.output,
        supportsImages:model.modalities?.input?.includes('image'),supportsPdf:model.modalities?.input?.includes('pdf'),supportsVideo:model.modalities?.input?.includes('video'),
        ...(model.reasoning?{reasoning:{enabled:!!model.reasoning.enabled,levels:(model.reasoning.variants||[]).map(value=>({value,label:value})),defaultLevel:model.reasoning.defaultVariant}}:{})}]}};
  return {runtimeModel,provider:selected.providerId,model:selected.modelId,effort:effort||null,selectionSource};
}
function redact(value) {
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,
    /^(apiKey|apiKeyRef|headers|requestHeaders|responseHeaders|authorization|accessToken|refreshToken|clientSecret)$/i.test(key)?'[REDACTED]':redact(v)]));
  return value;
}
async function initialize(rpc,state,spec) {
  const route=resolveRoute(spec,state.directory);
  Object.assign(state,{provider:route.provider,model:route.model,effort:route.effort,selectionSource:route.selectionSource});
  const fresh=await rpc.request('session/create',{
    workspace:{workspacePath:state.directory,workspaceKey:state.directory},runtimeModel:route.runtimeModel,
    mode:'build',titleGenerationEnabled:false,
  });
  const id=fresh.session?.sessionId;
  if(!id||fresh.protocol?.version!==1||normalize(fresh.session.workspace.workspacePath)!==normalize(state.directory)
    ||(fresh.messages||[]).some(m=>m.info?.role==='user')||fresh.projection?.turnCount!==0)throw Error('ZCode fresh session verification failed');
  const selected=fresh.settings?.model?.current;
  if(selected?.providerId!==state.provider||selected?.modelId!==state.model||
    (state.effort&&fresh.settings?.thoughtLevel?.current!==state.effort))throw Error('ZCode selected model/effort mismatch');
  await rpc.request('session/subscribe',{sessionId:id,deliveryKind:'web-remote-replayable',includeSnapshot:false});
  return {sessionId:id};
}
function observe(active,message,state) {
  const e=message.params;
  if(message.method!=='session/event'||e?.sessionId!==state.sessionId)return;
  active.lastProgress=Date.now();
  if(e.type==='model.streaming'&&e.payload?.kind==='text_delta')active.text+=e.payload.delta||'';
  if(e.type==='turn.completed'||e.type==='turn.failed')active.nativeEnd=e;
}
function result(active,result,state) {
  const end=active.nativeEnd, snap=result?.snapshot;
  const fail=reason=>({ready:false,reason});
  if(!result?.accepted||end?.type!=='turn.completed'||end?.sessionId!==state.sessionId||end?.payload?.inputId!==active.id||end?.payload?.resultType!=='success')return fail('zcode_terminal_binding_mismatch');
  if(!end.turnId||!end.eventId||snap?.session?.sessionId!==state.sessionId||snap.projection?.currentTurnId!==end.turnId)return fail('zcode_snapshot_binding_mismatch');
  if(snap.projection?.status!=='idle'||snap.projection?.activeToolCalls?.length||snap.projection?.pendingPermissions?.length
    ||snap.projection?.backgroundJobs?.length||snap.runtime?.pendingRequestIds?.length||active.permissionBlocked||active.protocolError)return fail('zcode_pending_attention');
  const messages=snap.messages||[], users=messages.filter(m=>m.info?.role==='user');
  const request=users.at(-1), answer=messages.at(-1);
  if(!request?.info?.messageId||request.info.sessionId!==state.sessionId||hash((request.parts||[]).filter(p=>p.type==='text').map(p=>p.text).join(''))!==active.promptHash)return fail('zcode_prompt_mismatch');
  if(answer?.info?.role!=='assistant'||answer.info.finish!=='stop'||!answer.info.time?.completed||answer.info.parentMessageId!==request.info.messageId
    ||answer.info.sessionId!==state.sessionId||!answer.info.messageId)return fail('zcode_response_mismatch');
  if(answer.info.model?.providerId!==state.provider||answer.info.model?.modelId!==state.model||
    snap.settings?.model?.current?.providerId!==state.provider||snap.settings?.model?.current?.modelId!==state.model||
    (state.effort&&snap.settings?.thoughtLevel?.current!==state.effort))return fail('zcode_model_mismatch');
  const text=(answer.parts||[]).filter(p=>p.type==='text').map(p=>p.text).join('');
  if(text!==end.payload.response)return fail('zcode_response_text_mismatch');
  active.text=text;active.responseEventId=end.eventId;
  return {ready:true,requestId:request.info.messageId,responseId:answer.info.messageId,reason:'completed'};
}
async function prompt(rpc,state,active,text,journal) {
  let resolveEnd,rejectEnd;
  const endPromise=new Promise((resolve,reject)=>{resolveEnd=resolve;rejectEnd=reject;});
  // A cancelled/closed transport must settle the waiting prompt too.
  const onClose=()=>rejectEnd(Error('ZCode exited during dispatch'));
  const onEvent=m=>{
    const e=m.params;
    if(m.method==='session/event'&&e?.sessionId===state.sessionId&&['turn.completed','turn.failed'].includes(e.type)&&e.payload?.inputId===active.id)resolveEnd(e);
  };
  rpc.on('notification',onEvent);rpc.on('closed',onClose);
  endPromise.catch(()=>{});
  try {
    const ack=await rpc.request('session/send',{sessionId:state.sessionId,inputId:active.id,content:text},45000,active.id);
    if(ack?.accepted!==true||ack.sessionId!==state.sessionId)throw Error('ZCode dispatch acknowledgement mismatch');
    await endPromise;
    const snapshot=await rpc.request('session/read',{sessionId:state.sessionId});
    const output={accepted:true,snapshot};
    journal({method:'zcode/settled',params:output});
    return output;
  } finally {rpc.off('notification',onEvent);rpc.off('closed',onClose);}
}
function reply(message,active,state) {
  if(message.method==='session/requestRuntimePreferences')return {id:message.id,result:{nativeSearchEnhancementsEnabled:false,memoryEnabled:false,askUserQuestionAutoResolutionEnabled:false}};
  if(message.method==='interaction/requestPermission') {
    const choices=message.params?.options;
    if(active)active.permissionIds ||= new Set();
    const fresh=active&&!active.permissionIds.has(message.id)&&message.id!==active.id;
    if(active)active.permissionIds.add(message.id);
    const valid=active&&!active.cancelling&&state.permission==='allow_once'&&message.params?.sessionId===state.sessionId
      &&fresh&&Array.isArray(choices)&&choices.length&&choices.every(o=>o&&typeof o.optionId==='string')&&new Set(choices.map(o=>o.optionId)).size===choices.length;
    const option=valid&&choices.find(o=>o.kind==='allow_once'&&o.response?.decision==='allow'&&!o.response.permissionUpdates);
    if(!option&&active)active.permissionBlocked=true;
    return {id:message.id,result:option?option.response:{decision:'deny',reason:'No authorized allow-once option'}};
  }
  if(active)active.permissionBlocked=true;
  return {id:message.id,error:{code:-32601,message:'Unsupported ZCode client operation'}};
}
function evidence(state,records) {
  const active={id:state.dispatch.id,promptHash:state.dispatch.promptHash,text:''};
  let submitted=false,ack=false,settled;
  const pending=new Map();
  for(const {dispatchId,message:m} of records) {
    if(dispatchId!==state.dispatch.id)continue;
    if(m.direction==='out'&&m.method==='session/send') {
      if(submitted||m.id!==active.id||m.params.inputId!==active.id||m.params.sessionId!==state.sessionId||hash(m.params.content)!==active.promptHash)return {ready:false,reason:'journal_binding_mismatch'};
      submitted=true;
    } else if(m.direction==='out'&&!m.method) {
      const request=pending.get(m.id);if(!request)return {ready:false,reason:'unbound_client_reply'};
      pending.delete(m.id);
      const expected=reply(request,active,state);
      if(JSON.stringify(m.result)!==JSON.stringify(expected.result)||m.error)return {ready:false,reason:'client_reply_mismatch'};
    } else if(m.method&&m.id!==undefined) {
      if(pending.has(m.id))return {ready:false,reason:'duplicate_client_request'};
      pending.set(m.id,m);
    }
    else if(m.id===active.id&&!m.method)ack=m.result?.accepted===true&&m.result.sessionId===state.sessionId;
    else if(m.method==='zcode/settled')settled=m.params;
    else observe(active,m,state);
  }
  if(!submitted||!ack||pending.size||!settled)return {ready:false,reason:'incomplete_evidence'};
  return result(active,settled,state);
}
module.exports={resolveRoute,redact,initialize,observe,result,prompt,reply,evidence};
