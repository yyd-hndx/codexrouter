const path = require('node:path');
const { ACTIVE, readJson, normalizeDirectory, textOf, resolveBinding, bindingRecord } = require('./opencode-state.cjs');
const { noticeFor, watchdogObservation } = require('./opencode-events.cjs');
const work = path.resolve(__dirname, '../work/opencode-bridge');

// Read-only polling of one owned dispatch. It never posts, queues or advances a round.
async function waitForResult(input, deps) {
  const initial = deps.read();
  const dispatchId = input.dispatchId;
  const timeoutSeconds = Number(input.timeoutSeconds ?? 45);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 60) throw Error('Wait timeout must be between 0 and 60 seconds.');
  const identity = cycle => JSON.stringify([cycle.codexThreadId, cycle.sessionId, cycle.directory,
    cycle.codeDirectory, cycle.dispatch?.id, cycle.dispatch?.promptHash, cycle.scope, cycle.round, cycle.model]);
  function check(cycle) {
    if (!input.threadId || cycle.codexThreadId !== input.threadId) throw Error('Cycle owner mismatch.');
    if (!input.sessionId || cycle.sessionId !== input.sessionId) throw Error('Session mismatch.');
    if (!input.directory || !cycle.directory || !cycle.codeDirectory
      || normalizeDirectory(input.directory) !== normalizeDirectory(cycle.directory)
      || normalizeDirectory(input.directory) !== normalizeDirectory(cycle.codeDirectory)) throw Error('Project directory mismatch.');
    if (!dispatchId || cycle.dispatch?.id !== dispatchId) throw Error('Wait requires the matching dispatch ID.');
    if (identity(cycle) !== identity(initial)) throw Error('Dispatch ownership or scope changed while waiting.');
  }
  check(initial);
  const deadline = Date.now() + timeoutSeconds * 1000;
  let monitor = deps.readMonitor?.();
  for (;;) {
    const state = deps.read();check(state);
    if (!ACTIVE.includes(state.status)) return {pending:false,timedOut:false,state,reason:'cycle_not_active'};
    let session, messages, permissions, questions, statuses;
    try {
      [session, messages, permissions, questions, statuses] = await Promise.all([
        deps.api('/session/' + state.sessionId,state,deadline),
        deps.api('/session/' + state.sessionId + '/message',state,deadline),
        deps.api('/permission',state,deadline),deps.api('/question',state,deadline),deps.api('/session/status',state,deadline),
      ]);
    } catch {
      check(deps.read());
      return {pending:true,timedOut:Date.now()>=deadline,state,needsAttention:true,reason:'snapshot_unavailable',action:'Inspect service health; no prompt was sent or retried.'};
    }
    const current = deps.read();check(current);
    if (!ACTIVE.includes(current.status)) return {pending:false,timedOut:false,state:current,reason:'cycle_not_active'};
    if (normalizeDirectory(session.directory) !== normalizeDirectory(current.directory)) throw Error('Actual session directory mismatch.');
    const binding = resolveBinding(current,messages);
    const snapshot = {binding,lastUser:messages.findLast(m=>m.info.role==='user'),last:messages.at(-1),
      permissions:permissions.filter(p=>p.sessionID===current.sessionId),
      questions:questions.filter(p=>p.sessionID===current.sessionId),status:statuses[current.sessionId]};
    const observed = watchdogObservation(current,snapshot,monitor);monitor=observed.monitor;
    const notice = noticeFor(current,snapshot) || observed.notice;
    if (notice) {
      const result = {pending:false,timedOut:false,state:current,notice,
        completed:notice.reason==='completed' && !!binding,
        needsAttention:notice.reason!=='completed',
        requestBinding:binding ? bindingRecord(current,binding) : null};
      if (binding && !binding.pendingCompaction && snapshot.last?.info.role==='assistant'
        && snapshot.last.info.summary!==true && snapshot.last.info.mode!=='compaction') result.response=textOf(snapshot.last);
      return result;
    }
    if (Date.now()>=deadline) return {pending:true,timedOut:true,state:current,progress:binding?.pendingCompaction?'compacting':'running'};
    await deps.wait(Math.min(1000,Math.max(0,deadline-Date.now())));
  }
}

async function main() {
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  const input=JSON.parse(raw.replace(/^\uFEFF/,''));input.threadId=process.env.CODEX_THREAD_ID;
  const auth=process.env.OPENCODE_BRIDGE_AUTH;delete process.env.OPENCODE_BRIDGE_AUTH;
  if(!auth)throw Error('Run through opencode-bridge.ps1.');
  const result=await waitForResult(input,{
    read:()=>readJson(path.join(work,'review-cycle.json')),
    readMonitor:()=>readJson(path.join(work,'event-delivery.json'),{}).monitor,
    wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    api:async(route,state,deadline)=>{
      const response=await fetch((process.env.OPENCODE_REVIEW_URL || 'http://127.0.0.1:4096')+route+'?directory='+encodeURIComponent(state.directory),{
        headers:{Authorization:auth},signal:AbortSignal.timeout(Math.max(1,Math.min(15000,deadline-Date.now())))});
      if(!response.ok)throw Error('OpenCode snapshot unavailable');return response.json();
    },
  });
  console.log(JSON.stringify(result));
}
module.exports={waitForResult};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
