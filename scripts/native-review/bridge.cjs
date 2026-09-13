'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process'); const { Rpc } = require('./rpc.cjs');
const {cleanup}=require('./lifecycle.cjs');
const { now, read, save, lock, hash, assertOwner, assertSend, grokResult, deepseekResult, observe, evidence, progress } = require('./state.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function argsOf(argv) { const out = { action: argv[0] }; for (let i=1;i<argv.length;i+=2) { if (!argv[i].startsWith('--') || argv[i+1] === undefined) throw Error('Arguments require --name value'); out[argv[i].slice(2)] = argv[i+1]; } return out; }
function settings(file) { const config = read(file); if (config.version !== 1) throw Error('Unsupported bridge config'); return config; }
function runtimeSpec(config, state, cycle) {
  const spec = config.backends[state.backend]; if (!spec) throw Error('Backend is not configured');
  const env = { ...process.env, ...spec.env };
  if (spec.credential) {
    const doc = read(spec.credential.file); let value = doc;
    for (const key of spec.credential.keys) value = value?.[key];
    if (typeof value !== 'string' || !value) throw Error('Configured credential unavailable');
    for (const key of spec.credential.envNames) env[key] = value;
  }
  let args = spec.args;
  if (state.backend === 'deepseek-harness' && spec.managedDeepseek) {
    if (!cycle || !path.isAbsolute(cycle)) throw Error('Managed DeepSeek launch requires an absolute cycle directory');
    const patchFile = path.join(cycle, 'deepseek-acp.patch.yml');
    const launch = require('./deepseek-runtime.cjs').deepseekLaunch(spec, patchFile);
    fs.writeFileSync(patchFile, launch.patch);
    args = launch.args; Object.assign(env, launch.env);
  }
  return { command: spec.command, args, env, cwd: state.directory };
}
async function notify(config, state, stateFile, event=state.status) {
  const mode=state.notify||'async';
  if (!['async','events'].includes(mode) || (mode==='events'&&!config.codexCommand)) return;
  const key = `${state.id}:${state.dispatch.id}:${event}`;
  if (state.delivery?.key === key || ['pending','uncertain'].includes(state.delivery?.status)) return;
  state.delivery = { key, status: 'pending', createdAt: now() }; save(stateFile,state);
  const text = `NATIVE_REVIEW_EVENT ${event}. Backend ${state.backend}; cycle ${state.id}; dispatch ${state.dispatch.id}; request ${state.submittedMessageId || 'unbound'}; response ${state.responseId || 'unavailable'}; round ${state.round}. Read ${stateFile} and the codexRouter skill. This is a new review work item in this conversation; preserve any other active user task and handle this callback at a safe step. If owner context compacts, resume this cycle's pinned response. Without newer human input, finish this callback review and report its result, not an older already-answered topic. Verify current owner, latest user instructions, actual artifacts and report before reviewing or dispatching repairs. No new scope is authorized. If stopped or complete, do not restart.`;
  try {
    if(mode==='async') {
      const result=await require('../owner-notify.cjs').submitOwnerMessage(state.owner,text,key);
      if(!result?.submitted||result.threadId!==state.owner||result.eventId!==key)throw Error('Owner submission acknowledgement mismatch');
      state.delivery.status='submitted';state.delivery.submittedAt=now();state.delivery.autoSubmitted=true;state.delivery.transport=result.transport;
    } else {
    const stdout = await new Promise((resolve,reject) => execFile(config.codexCommand, [...(config.codexArgs||[]),'queue','--thread',state.owner,'--message',text], { windowsHide:true, timeout:30000, maxBuffer:128*1024 }, (error,stdout)=>error?reject(error):resolve(stdout)));
    if (!/Queued message/.test(stdout)) throw Error('Queue acknowledgement missing');
    state.delivery.status='queued'; state.delivery.queuedAt=now();state.delivery.autoSubmitted=false;
    }
  } catch { state.delivery.status='uncertain'; }
  save(stateFile,state);
}
async function worker(cycle) {
  const stateFile=path.join(cycle,'state.json'); let state=read(stateFile); const config=settings(state.configFile);
  const unlock=lock(path.join(cycle,'worker.lock')); let rpc,active=null,stopLoop=false,commandChain=Promise.resolve(),notifications=Promise.resolve();const nativeSessions=new Map();
  const wake=(event=state.status)=>{const dispatch=state.dispatch?.id;notifications=notifications.then(()=>{if(state.dispatch?.id===dispatch)return notify(config,state,stateFile,event)});return notifications;};
  const persist=()=>{state.updatedAt=now();save(stateFile,state)};
  const journal=message=>{const fd=fs.openSync(path.join(cycle,'events.jsonl'),'a');try{fs.writeSync(fd,JSON.stringify({at:now(),dispatchId:active?.id||null,message})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd)}};
  const finish=async(result,error)=>{
    const run=active; if (!run) return;
    run.finished=true;
    if (run.cancelling) return;
    if (run.timedOut) { state.status='paused_timeout'; }
    else if(error) { state.status='paused_reconcile'; state.problem=error.message; }
    else {
      const verdict=state.backend==='deepseek-harness'?deepseekResult(run,result,state):grokResult(run,result,state); state.status=verdict.ready?'awaiting_review':'paused_attention';
      state.submittedMessageId=verdict.requestId||run.nativeRequestId||state.submittedMessageId||result?._meta?.requestId||null;
      state.responseId=verdict.responseId||null;state.responseEventId=run.responseEventId||null; state.stopReason=verdict.reason; state.result=result;
      if(verdict.ready && state.problemCode==='stalled') {state.problem=null;state.problemCode=null;}
    }
    if(state.backend==='deepseek-harness') {
      state.progress=progress(run,state);
      const code=run.nativeEnd?.reason?.error?.code;
      if(code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
        state.failure={code,retryCount:run.retryCount||0,sessionId:state.sessionId,requestId:run.nativeRequestId||null};
        state.problemCode=['TRANSPORT','TIMEOUT'].includes(code)?'model_transport':'model_error';
        state.problem=`DeepSeek request ended with ${code}; inspect the preserved session and network before further execution.`;
      }
    }
    state.finishedAt=now();state.lastResponseFile=path.join(cycle,`response-${state.round}.txt`);
    fs.writeFileSync(state.lastResponseFile,run.text);state.dispatch.finishedAt=state.finishedAt;persist();
    active=null;await wake();
  };
  async function stop(status='paused_stopped') {
    if(active) active.cancelling=true;
    state.status='stopping';persist();
    if(rpc&&!rpc.closed&&state.sessionId) {
      try { rpc.notify('session/cancel',{sessionId:state.sessionId}); } catch { /* Transport already ended. */ }
      try { await rpc.request('session/close',{sessionId:state.sessionId},6000); } catch { /* Process close below proves exit. */ }
    }
    if(rpc)await rpc.close();
    if(active){state.lastResponseFile=path.join(cycle,`response-${state.round}.txt`);fs.writeFileSync(state.lastResponseFile,active.text);state.dispatch.finishedAt=now();active=null;}
    state.runtimeExited=true;state.status=status;state.stoppedAt=now();persist();stopLoop=true;
  }
  async function handle(command) {
    assertOwner(state,command.owner);
    if(command.action==='send') {
      assertSend(state); if(active)throw Error('A dispatch is already running');
      if(!command.prompt||!command.prompt.trim())throw Error('Empty prompt');
      const dispatchId=crypto.randomUUID();
      state.dispatch={id:dispatchId,promptHash:hash(command.prompt),startedAt:now(),rpcId:dispatchId};
      state.round++;state.status='dispatching';state.submittedMessageId=null;state.responseId=null;state.responseEventId=null;state.result=null;state.problem=null;state.problemCode=null;state.progress=null;state.failure=null;state.finishedAt=null;state.stopReason=null;state.lastResponseFile=null;
      const promptFile=path.join(cycle,`prompt-${state.round}.txt`);fs.writeFileSync(promptFile,command.prompt);state.currentPromptFile=promptFile;
      active={id:dispatchId,text:'',promptHash:hash(command.prompt),tools:new Map(),promptIds:new Set(),started:Date.now(),lastProgress:Date.now(),finished:false};persist();
      journal({direction:'out',id:dispatchId,method:'session/prompt',params:{sessionId:state.sessionId,prompt:[{type:'text',text:command.prompt}]}});
      state.status='running';persist();
      rpc.request('session/prompt',{sessionId:state.sessionId,prompt:[{type:'text',text:command.prompt}]},0,dispatchId).then(result=>finish(result),error=>finish(null,error)).catch(async error=>{state.status='paused_reconcile';state.problem=error.message;persist()});
      return {dispatched:true,dispatchId,round:state.round,sessionId:state.sessionId};
    }
    if(command.action==='review') {
      if(state.status!=='awaiting_review')throw Error('No verified completed response awaits review');
      if(command.responseId!==state.responseId)throw Error('Reviewed response does not match');
      if(!['complete','changes_requested'].includes(command.outcome))throw Error('Review outcome must be complete or changes_requested');
      if(!command.report||!path.isAbsolute(command.report)||!fs.statSync(command.report).isFile())throw Error('Existing absolute review report required');
      state.latestReviewReport=command.report;state.lastReviewedResponseId=command.responseId;state.reviewedAt=now();
      state.status=command.outcome==='complete'?'complete':state.round>=state.maxRounds?'paused_round_limit':'reviewed_changes_requested';persist();
      if(state.status==='complete'||state.status==='paused_round_limit')await stop(state.status);
      return {status:state.status};
    }
    if(command.action==='stop') { await stop();return {status:state.status,runtimeExited:state.runtimeExited}; }
    if(command.action==='ack-delivery') {
      if(!command.key||command.key!==state.delivery?.key||!['pending','uncertain'].includes(state.delivery.status))throw Error('Exact pending delivery key required');
      state.delivery.status='acknowledged';state.delivery.acknowledgedAt=now();persist();return {status:state.delivery.status};
    }
    throw Error('Unsupported worker command');
  }
  async function commands() {
    for(const file of fs.readdirSync(path.join(cycle,'commands')).filter(n=>n.endsWith('.json')).sort()) {
      const target=path.join(cycle,'commands',file),response=path.join(cycle,'replies',file);
      if(fs.existsSync(response))continue;
      const command=read(target);
      if(command.claimed)continue;
      command.claimed=true;save(target,command);
      try { save(response,{ok:true,result:await handle(command)}); } catch(error) { save(response,{ok:false,error:error.message}); }
    }
  }
  try {
    state.workerPid=process.pid;state.status='starting';persist();
    const spec=runtimeSpec(config,state,cycle);rpc=new Rpc(spec.command,spec.args,{env:spec.env,cwd:spec.cwd});state.runtimePid=rpc.child.pid;persist();
    rpc.on('diagnostic',data=>fs.appendFileSync(path.join(cycle,'runtime.stderr.log'),data));
    rpc.on('frame',journal);
    rpc.on('invalid',()=>{if(active)active.protocolError=true});
    rpc.on('request',message=>{
      if(message.method==='session/request_permission') {
        const allow=active&&state.permission==='allow_once'&&message.params?.sessionId===state.sessionId&&!active.cancelling;
        const choices=message.params?.options;
        if(active)active.permissionIds ||= new Set();
        const valid=Array.isArray(choices)&&choices.every(o=>o&&typeof o.optionId==='string')&&new Set(choices.map(o=>o.optionId)).size===choices.length
          &&message.id!==active?.id&&!active?.permissionIds.has(message.id);
        if(active)active.permissionIds.add(message.id);
        const option=allow&&valid?choices.find(o=>o.kind==='allow_once'):undefined;
        if(!option&&active)active.permissionBlocked=true;
        const reply={id:message.id,result:{outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}}};
        try {journal({direction:'out',...reply});rpc.write(reply);}
        catch(error) {if(active)active.protocolError=true;rpc.child.stdin.destroy();}
      }else {if(active)active.permissionBlocked=true;rpc.write({id:message.id,error:{code:-32601,message:'Unsupported client operation'}});}
    });
    rpc.on('notification',message=>{
      if(message.method==='review.session')nativeSessions.set(message.params.sessionId,message.params);
      if(!active||message.params?.sessionId!==state.sessionId)return;
      observe(active,message,state);
      if(state.problemCode==='stalled') {state.problem=null;state.problemCode=null;active.stallNotified=false;persist();}
      if(/^(compaction\/|llm\/retry|step\/start)/.test(message.params?.event?.type||'')) {state.progress=progress(active,state);persist();}
      if(active.nativeRequestId&&state.submittedMessageId!==active.nativeRequestId){state.submittedMessageId=active.nativeRequestId;persist();}
    });
    await rpc.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'codex-review-bridge',version:'1'}});
    const fresh=await rpc.request('session/new',{cwd:state.directory,mcpServers:[]});
    if(!fresh.sessionId)throw Error('No session identity returned');
    if(state.backend==='deepseek-harness') {
      const modelOption=fresh.configOptions?.find(o=>o.category==='model'||o.id==='model');
      const choices=(modelOption?.options||[]).flatMap(o=>o.options||[o]);
      const selection=choices.find(o=>o.value===config.backends[state.backend].modelSelector);
      if(!selection)throw Error('Configured DeepSeek model is not advertised');
      await rpc.request('session/set_config_option',{sessionId:fresh.sessionId,configId:modelOption.id,value:selection.value});
      const selected=await rpc.request('session/set_config_option',{sessionId:fresh.sessionId,configId:'reasoning_effort',value:state.effort});
      if(!selected.configOptions?.some(o=>o.id==='reasoning_effort'&&o.currentValue===state.effort))throw Error('DeepSeek effort mismatch');
      const observed=nativeSessions.get(fresh.sessionId),actual=observed?.header;
      if(!actual?.cwd||path.resolve(actual.cwd).toLowerCase()!==state.directory.toLowerCase()||actual.parentSession||actual.isSeeded||observed.eventCount!==0)throw Error('DeepSeek workspace/session verification failed');
    } else {
      const actual=fresh._meta?.currentWorkingDirectory;
      if(!actual||path.resolve(actual).toLowerCase()!==state.directory.toLowerCase())throw Error('Runtime workspace mismatch');
      if(fresh.models?.currentModelId!==config.backends[state.backend].modelSelector)throw Error('Runtime model mismatch');
      const efforts=fresh._meta?.['x.ai/sessionConfig']?.options||[];
      if(!efforts.some(o=>o.id===state.effort&&o.selected))throw Error('Runtime reasoning effort mismatch');
    }
    state.sessionId=fresh.sessionId;state.sessionVerified=true;state.status='ready';state.readyAt=now();persist();
    while(!stopLoop) {
      commandChain=commandChain.then(commands);await commandChain;
      if(rpc.closed&&!stopLoop) {state.status='paused_reconcile';state.problem='Runtime exited; use reconcile, never resend blindly';persist();if(state.dispatch)await wake();stopLoop=true;}
      if(active&&!active.cancelling) {
        const elapsed=Date.now()-active.started;
        if(elapsed>state.maxRuntimeSeconds*1000) {await stop('paused_timeout');await wake();}
        else if(progress(active,state).stalled&&!active.stallNotified) {active.stallNotified=true;state.problemCode='stalled';state.progress=progress(active,state);state.problem=`No observable progress (${state.progress.phase}); inspect before stopping`;persist();void wake('stalled');}
      }
      if(!stopLoop)await sleep(150);
    }
  }catch(error) {state.status='paused_error';state.problem=error.message;persist();if(state.dispatch)await wake();}
  finally {await cleanup({close:async()=>{if(rpc&&!rpc.closed)await rpc.close();},notifications:()=>notifications,
    persist:()=>{state.workerExitedAt=now();state.runtimeExited=rpc?.closed||!rpc;persist();},unlock});}
}
async function command(cycle,action,options) {
  const timeoutSeconds=Number(options['command-timeout-seconds']??45);
  if(!Number.isFinite(timeoutSeconds)||timeoutSeconds<1||timeoutSeconds>60)throw Error('Command timeout must be 1-60 seconds');
  const state=read(path.join(cycle,'state.json'));assertOwner(state,options.owner||process.env.CODEX_THREAD_ID);
  if(!fs.existsSync(path.join(cycle,'worker.lock')))throw Error('Worker is not live; use reconcile');
  const id=crypto.randomUUID(),request={action,owner:options.owner||process.env.CODEX_THREAD_ID,key:options.key};
  if(action==='send')request.prompt=options['prompt-file']?fs.readFileSync(options['prompt-file'],'utf8').replace(/^\uFEFF/,''):options.prompt;
  if(action==='review')Object.assign(request,{responseId:options['response-id'],outcome:options.outcome,report:options.report?path.resolve(options.report):undefined});
  save(path.join(cycle,'commands',id+'.json'),request);
  const reply=path.join(cycle,'replies',id+'.json');
  const deadline=Date.now()+timeoutSeconds*1000;
  while(Date.now()<deadline){if(fs.existsSync(reply)){const result=read(reply);if(!result.ok)throw Error(result.error);return result.result;}await sleep(100);}
  throw Error(`Command ${id} outcome unknown; inspect reply and state. Do not repeat send.`);
}
async function main(options) {
  if(options.action==='worker')return worker(path.resolve(options.cycle));
  if(options.action==='init') {
    const configFile=path.resolve(options.config);const config=settings(configFile);const backend=config.backends[options.backend];if(!backend)throw Error('Unknown backend');
    const directory=fs.realpathSync(path.resolve(options.directory));const owner=options.owner||process.env.CODEX_THREAD_ID;if(!owner)throw Error('Verified owner required');
    const parent=path.join(directory,'.agent-work','native-review');fs.mkdirSync(parent,{recursive:true});const release=lock(path.join(parent,'init.lock'));let cycle;
    try {
      const current=path.join(parent,'current.json');if(fs.existsSync(current)){const prior=read(read(current).stateFile);if(!['complete','paused_stopped','paused_round_limit','paused_timeout','paused_error','paused_reconcile'].includes(prior.status)||fs.existsSync(path.join(path.dirname(read(current).stateFile),'worker.lock')))throw Error('Previous native review cycle is still active');
        if(prior.runtimePid&&!prior.runtimeExited)throw Error('Previous runtime exit is unverified; inspect and reconcile before starting another cycle');}
      const id=crypto.randomUUID();cycle=path.join(parent,id);for(const folder of ['commands','replies'])fs.mkdirSync(path.join(cycle,folder),{recursive:true});
      const maxRounds=Number(options['max-rounds']||4),maxRuntimeSeconds=Number(options['max-runtime']||1200),stallSeconds=Number(options['stall-seconds']||300);
      const compactionStallSeconds=Number(options['compaction-stall-seconds']||Math.max(600,stallSeconds));
      if(!Number.isInteger(maxRounds)||maxRounds<1||!Number.isFinite(maxRuntimeSeconds)||maxRuntimeSeconds<1||!Number.isFinite(stallSeconds)||stallSeconds<1)throw Error('Invalid bounds');
      if(!Number.isFinite(compactionStallSeconds)||compactionStallSeconds<stallSeconds)throw Error('Compaction stall bound must be at least the normal stall bound');
      const notifyMode=options.notify||'async';if(!['async','direct','events','manual'].includes(notifyMode))throw Error('Invalid notification mode');
      const permission=options.permission||'reject';if(!['reject','allow_once'].includes(permission))throw Error('Invalid permission policy');
      if(notifyMode==='async')await require('../owner-notify.cjs').probeOwnerChannel();
      save(path.join(cycle,'state.json'),{version:1,id,owner,backend:options.backend,provider:backend.provider,model:backend.model,effort:backend.effort,directory,configFile,status:'starting',scope:options.scope||'',round:0,maxRounds,maxRuntimeSeconds,stallSeconds,compactionStallSeconds,notify:notifyMode,permission,createdAt:now()});
      save(current,{stateFile:path.join(cycle,'state.json')});
      const stdout=fs.openSync(path.join(cycle,'worker.stdout.log'),'a'),stderr=fs.openSync(path.join(cycle,'worker.stderr.log'),'a');
      const proc=spawn(process.execPath,[__filename,'worker','--cycle',cycle],{detached:true,windowsHide:true,stdio:['ignore',stdout,stderr]});proc.unref();fs.closeSync(stdout);fs.closeSync(stderr);
    }finally{release();}
    for(let i=0;i<550;i++){const state=read(path.join(cycle,'state.json'));if(state.status!=='starting')return {cycle,...state};await sleep(100);}
    return {cycle,status:'starting'};
  }
  const cycle=path.resolve(options.cycle);
  if(options.action==='wait')return require('./wait.cjs').waitForResult(cycle,options);
  if(['snapshot','status','read'].includes(options.action)) {const state=read(path.join(cycle,'state.json'));if(options.action==='read'&&state.lastResponseFile)return {state,response:fs.readFileSync(state.lastResponseFile,'utf8')};return state;}
  if(options.action==='reconcile') {
    const state=read(path.join(cycle,'state.json'));assertOwner(state,options.owner||process.env.CODEX_THREAD_ID);
    let alive=false;try{process.kill(state.workerPid,0);alive=true}catch{}
    const eventFile=path.join(cycle,'events.jsonl');let proof={ready:false,reason:'no_dispatch'};
    if(state.dispatch&&fs.existsSync(eventFile)) {try{proof=evidence(state,fs.readFileSync(eventFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)));}catch{proof={ready:false,reason:'unreadable_evidence'};}}
    return {state,workerPidExists:alive,workerLock:fs.existsSync(path.join(cycle,'worker.lock')),evidence:eventFile,proof,action:'Read-only. No model request sent or replayed. Proof does not override stopped/paused state. Dead-worker continuation is manual; never resend automatically.'};
  }
  return command(cycle,options.action,options);
}
if(require.main===module)main(argsOf(process.argv.slice(2))).then(result=>{if(result!==undefined)console.log(JSON.stringify(result,null,2))}).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={main,argsOf,runtimeSpec,notify};
