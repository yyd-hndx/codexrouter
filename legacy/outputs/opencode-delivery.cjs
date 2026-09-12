const { ACTIVE, fingerprint, resolveBinding, bindingRecord, completedCycle } = require('./opencode-state.cjs');

function createReconciler(deps) {
  let ledger = deps.readLedger();
  // Historical 'delivered' entries prove only queue acceptance. Keep them for dedupe.
  ledger.delivered ||= [];
  ledger.queued ||= [];
  ledger.submitted ||= [];
  if (ledger.pending) ledger.deliveryUncertain ||= ledger.pending;
  async function persist() {
    // Retrying a local save must never retry an already acknowledged queue call.
    for (let attempt = 0; ; attempt++) {
      try { deps.saveLedger(ledger); return; }
      catch (error) { if (attempt >= 2) throw error; await deps.wait(100 * (attempt + 1)); }
    }
  }
  return async function reconcile() {
    let cycle = deps.readCycle();
    if (!ACTIVE.includes(cycle.status)) return;
    if (!cycle.codexThreadId || !cycle.sessionId || !cycle.directory) {
      deps.log('invalid_cycle', { detail: 'Missing owner/session/directory; inspect review-cycle.json.' });
      return;
    }
    let notice, completionMessages;
    try {
      const [messages, permissions, questions, statuses] = await Promise.all([
        deps.api('/session/' + cycle.sessionId + '/message', cycle), deps.api('/permission', cycle),
        deps.api('/question', cycle), deps.api('/session/status', cycle),
      ]);
      const binding = resolveBinding(cycle, messages);
      const snapshot = { binding, lastUser: messages.findLast(m => m.info.role === 'user'), last: messages.at(-1),
        permissions: permissions.filter(p => p.sessionID === cycle.sessionId),
        questions: questions.filter(p => p.sessionID === cycle.sessionId), status: statuses[cycle.sessionId] };
      const observed = deps.watchdog(cycle, snapshot, ledger.monitor);
      ledger.monitor = observed.monitor;
      delete ledger.availability;
      notice = deps.noticeFor(cycle, snapshot) || observed.notice;
      if (notice?.reason === 'completed') completionMessages = messages;
      if (notice && binding && cycle.dispatch?.id) {
        notice.dispatchId = cycle.dispatch.id;
        notice.verifiedRequestId = binding.request.info.id;
        notice.requestBinding = bindingRecord(cycle, binding);
      }
    } catch (error) {
      const observed = deps.unavailable(cycle, ledger.availability);
      ledger.availability = observed.monitor;
      notice = observed.notice;
      deps.log('snapshot_unavailable', { sessionId: cycle.sessionId });
    }
    await persist();
    if (!notice) return;
    const legacyKey = notice.key;
    notice.key = [cycle.codexThreadId, cycle.directory, cycle.dispatch?.id || '', legacyKey].join(':');
    if (fingerprint(deps.readCycle()) !== fingerprint(cycle)) return;
    if (completionMessages && cycle.dispatch?.id) {
      const pinned = completedCycle(cycle, completionMessages);
      if (fingerprint(pinned) !== fingerprint(cycle)) {
        const release = deps.lockCycle();
        try {
          if (fingerprint(deps.readCycle()) !== fingerprint(cycle)) return;
          deps.saveCycle(pinned); // The owner can wake immediately after submission.
          cycle = pinned;
        } finally { release(); }
      }
    }
    const mode=cycle.deliveryMode||'async';
    if (mode === 'direct') {
      ledger.lastNotice={...notice,codexThreadId:cycle.codexThreadId,status:'available',autoSubmitted:false,observedAt:new Date().toISOString()};
      await persist();return; // Direct consumers use Wait; no user-queue side effect.
    }
    if(!['async','events'].includes(mode))throw Error('Unsupported delivery mode.');
    if ([...ledger.submitted,...ledger.queued,...ledger.delivered].includes(notice.key)
      || ([...ledger.submitted,...ledger.queued,...ledger.delivered].includes(legacyKey) && !cycle.dispatch)) return;
    if (ledger.pending || ledger.deliveryUncertain) {
      deps.log('delivery_blocked', { detail: 'Queue outcome requires reconciliation; inspect event-delivery.json.' });
      return;
    }
    // Include request, dispatch identity, round, status, reviewed cursor and scope.
    if (fingerprint(deps.readCycle()) !== fingerprint(cycle)) return;
    notice.codexThreadId = cycle.codexThreadId;
    const guidance = notice.bindingMismatch || ['dispatching', 'deliveryUncertain'].includes(cycle.status)
      ? 'Dispatch binding needs reconciliation. Read actual messages; use bridge Reconcile if its persisted dispatch marker proves the request. Do not blindly adopt newer user input or resend.'
      : ['stalled', 'service_unavailable'].includes(notice.reason)
        ? 'Inspect actual tool progress, timeout and service health before recovery. Do not automatically abort, restart a healthy service or replay.'
        : 'Inspect the actual response and continue the authorized review.';
    const continuation = notice.requestBinding?.compactions.length
      ? ` Verified automatic compaction chain from original dispatch request ${notice.verifiedRequestId}; current continuation ${notice.userMessageId}. Keep the original submittedMessageId; use Reconcile to persist the verified chain if needed.` : '';
    const message = `OPENCODE_EVENT ${notice.reason}. Event ${notice.key}. Session ${notice.sessionId}; request ${notice.userMessageId || 'unbound'}; response ${notice.assistantMessageId || 'unavailable'}; round ${cycle.round}.${continuation} Read ${deps.workflowPath} and ${deps.statePath}. This is a new review work item in this conversation; preserve any other active user task and handle this callback at a safe step. ${guidance} If owner context compacts, resume the pinned response from this cycle. Without newer human input, finish this callback review and report its result, not an older already-answered topic. Honor the latest user instructions, owner, request IDs and round limit. This notification authorizes no new scope.`;
    ledger.pending = notice;
    await persist(); // If this fails, no external queue call takes place.
    if (fingerprint(deps.readCycle()) !== fingerprint(cycle)) {
      delete ledger.pending; await persist(); return;
    }
    let result;
    try {
      if(mode==='async') {
        result=await deps.submit(cycle.codexThreadId,message,notice.key);
        if(!result?.submitted||result.threadId!==cycle.codexThreadId||result.eventId!==notice.key)throw Error('Owner submission acknowledgement mismatch.');
      } else {
        result = await deps.queue(cycle.codexThreadId, message);
        if (!/Queued message/.test(result.stdout)) throw Error('Queue acknowledgement missing.');
      }
    } catch (error) {
      // Only an OS-level failure to spawn proves no message was submitted.
      if (mode==='events' && ['ENOENT', 'EACCES'].includes(error.code) && !error.killed) delete ledger.pending;
      else ledger.deliveryUncertain = { ...notice, detail: 'Delivery result unknown; inspect target task before resolving.' };
      await persist();
      throw error;
    }
    if(mode==='async') {
      ledger.submitted=[...ledger.submitted.slice(-199),notice.key];
      ledger.lastSubmitted={...notice,status:'submitted',autoSubmitted:true,submittedAt:new Date().toISOString(),transport:result.transport};
    } else {
      ledger.queued = [...ledger.queued.slice(-199), notice.key];
      ledger.lastQueued = { ...notice, status:'queued',autoSubmitted:false,queuedAt:new Date().toISOString(),acknowledgement:result.stdout.trim() };
    }
    delete ledger.pending;
    delete ledger.deliveryUncertain;
    await persist();
    deps.log(mode==='async'?'submitted':'queued', { reason: notice.reason, messageId: notice.assistantMessageId });
  };
}
module.exports = { createReconciler };
