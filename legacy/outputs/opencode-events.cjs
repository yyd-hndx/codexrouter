const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const execFile = promisify(require('node:child_process').execFile);
const { createParser } = require('eventsource-parser');

const work = path.resolve(__dirname, '../work/opencode-bridge');
const statePath = path.join(work, 'review-cycle.json');
const ledgerPath = path.join(work, 'event-delivery.json');
const runtimePath = path.join(work, 'event-runtime.json');
const workflowPath = path.join(__dirname, 'opencode-review-workflow.md');
const baseUrl = (process.env.OPENCODE_REVIEW_URL || 'http://127.0.0.1:4096');
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const { ACTIVE, readJson, saveJson, acquireLock } = require('./opencode-state.cjs');
const { createReconciler } = require('./opencode-delivery.cjs');
const {isSummary,isCompleted}=require('./opencode-snapshot.cjs');

function relevantEvent(raw, sessionId) {
  const event = raw.payload || raw;
  if (event.properties?.sessionID !== sessionId) return false;
  return ['session.idle', 'session.error', 'permission.asked', 'question.asked'].includes(event.type)
    || (event.type === 'session.status' && event.properties.status?.type === 'idle');
}
function noticeFor(cycle, snapshot) {
  if (!ACTIVE.includes(cycle.status)) return null;
  const { lastUser, last, status, permissions, questions } = snapshot;
  if (!lastUser?.info.id) return null;
  const bindingMismatch = (Object.hasOwn(snapshot, 'binding')
    ? !snapshot.binding || snapshot.binding.request.info.id !== cycle.submittedMessageId
    : lastUser.info.id !== cycle.submittedMessageId)
    || !['waiting_for_grok', 'callback_pending'].includes(cycle.status)
    || (cycle.dispatch?.responseId && cycle.dispatch.responseId !== last?.info.id)
    || (last?.info.role === 'assistant' && last.info.parentID && last.info.parentID !== lastUser.info.id);
  const request = permissions[0] || questions[0];
  let reason;
  if (request) reason = 'needs_attention';
  else if (last?.info.error) reason = 'error';
  else if (status?.type === 'busy' || status?.type === 'retry') return null;
  // A completed summary is an intermediate result, not a completed assignment.
  else if (snapshot.binding?.pendingCompaction || isSummary(last)) return null;
  else if (isCompleted(last)) reason = 'completed';
  else return null;
  if (!request && last?.info?.id === cycle.lastReviewedAssistantMessageId) return null;
  return {
    key: [cycle.sessionId, lastUser.info.id, reason, request?.id || last.info.id].join(':'),
    reason: bindingMismatch ? 'binding_mismatch' : reason,
    sessionId: cycle.sessionId,
    userMessageId: lastUser?.info.id,
    assistantMessageId: last?.info.id,
    requestId: request?.id,
    bindingMismatch,
  };
}

function cycleKey(cycle) {
  return [cycle.codexThreadId, cycle.sessionId, cycle.directory, cycle.submittedMessageId, cycle.dispatch?.id].join(':');
}

function watchdogObservation(cycle, snapshot, previous, now = Date.now()) {
  const key = cycleKey(cycle);
  if (!ACTIVE.includes(cycle.status)) return { monitor: null, notice: null };
  const { last, status } = snapshot;
  const fingerprint = createHash('sha256').update(JSON.stringify({
    id: last?.info.id, finish: last?.info.finish, error: last?.info.error,
    status: status?.type,
    parts: last?.parts?.map(part => ({ id: part.id, type: part.type, text: part.text,
      tool: part.tool, status: part.state?.status, output: part.state?.output,
      input: part.state?.input, time: part.state?.time })),
  })).digest('hex');
  const unchanged = previous?.key === key && previous.fingerprint === fingerprint;
  const monitor = { key, fingerprint, lastProgressAt: unchanged ? previous.lastProgressAt : now,
    checkedAt: now };
  const tool = last?.parts?.find(part => part.type === 'tool' && ['pending', 'running'].includes(part.state?.status));
  const unfinished = ['busy', 'retry'].includes(status?.type) || tool
    || snapshot.binding?.pendingCompaction || last?.info.summary === true || last?.info.mode === 'compaction'
    || !cycle.submittedMessageId || !['waiting_for_grok', 'callback_pending'].includes(cycle.status)
    || !last || last.info.role !== 'assistant' || !last.info.time?.completed || last.info.finish !== 'stop';
  if (!unfinished || now - monitor.lastProgressAt < POLL_INTERVAL_MS) return { monitor, notice: null };
  // A declared long tool timeout is legitimate work until its deadline plus grace.
  const timeout = Number(tool?.state?.input?.timeout);
  const start = Number(tool?.state?.time?.start);
  if (Number.isFinite(timeout) && timeout > 0 && Number.isFinite(start) && start > 0
    && now < start + timeout + 60000) return { monitor, notice: null };
  return { monitor, notice: {
    key: [key, 'stalled', tool?.id || last?.info.id || 'no-response'].join(':'),
    reason: 'stalled', sessionId: cycle.sessionId, userMessageId: cycle.submittedMessageId || snapshot.lastUser?.info.id,
    assistantMessageId: last?.info.id, toolPartId: tool?.id,
    idleSeconds: Math.floor((now - monitor.lastProgressAt) / 1000),
  } };
}

function unavailableObservation(cycle, previous, now = Date.now()) {
  const key = cycleKey(cycle);
  const monitor = { key, unavailableSince: previous?.key === key && previous.unavailableSince
    ? previous.unavailableSince : now, checkedAt: now };
  return { monitor, notice: now - monitor.unavailableSince < POLL_INTERVAL_MS ? null : {
    key: [key, 'service_unavailable'].join(':'), reason: 'service_unavailable',
    sessionId: cycle.sessionId, userMessageId: cycle.submittedMessageId,
  } };
}

async function main() {
  const auth = process.env.OPENCODE_BRIDGE_AUTH;
  const cli = process.env.OPENCODE_BRIDGE_CODEX;
  if (!auth) throw new Error('Start through opencode-events.ps1.');
  delete process.env.OPENCODE_BRIDGE_AUTH;
  const headers = { Authorization: auth };
  const probeSession = process.argv.includes('--probe-session')
    ? process.argv[process.argv.indexOf('--probe-session') + 1] : null;
  let chain = Promise.resolve();
  let stopping = false;
  let controller;
  let watchdog;
  let pollTimer;
  let consecutiveFailures = 0;
  const log = (event, data = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));
  const runtime = (status) => saveJson(runtimePath, { pid: process.pid, status,
    pollIntervalMs: POLL_INTERVAL_MS, updatedAt: new Date().toISOString() });

  async function api(route, cycle) {
    const response = await fetch(baseUrl + route + '?directory=' + encodeURIComponent(cycle.directory),
      { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`OpenCode ${route}: HTTP ${response.status}`);
    return response.json();
  }
  const reconcile = createReconciler({
    readCycle: () => readJson(statePath), readLedger: () => readJson(ledgerPath, { delivered: [] }),
    lockCycle: () => acquireLock(path.join(work, 'dispatch.lock')),
    saveCycle: value => saveJson(statePath, value),
    saveLedger: value => saveJson(ledgerPath, value), api,
    noticeFor, watchdog: watchdogObservation, unavailable: unavailableObservation,
    queue: (thread, message) => execFile(cli, ['queue', '--thread', thread, '--message', message],
      { windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 }),
    submit: (thread, message, eventId) => require('../../scripts/owner-notify.cjs').submitOwnerMessage(thread, message, eventId),
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)), log, workflowPath, statePath,
  });
  let scheduled = false;
  function schedule() {
    if (scheduled || stopping) return;
    scheduled = true;
    chain = chain.then(async () => {
      scheduled = false;
      const cycle = readJson(statePath);
      if (cycle.status === 'complete' || cycle.status.startsWith('paused')) {
        stopping = true;
        controller?.abort();
        return;
      }
      if (!probeSession) await reconcile();
    }).catch(error => log('delivery_error', { message: error.message.slice(0, 300) }));
  }
  runtime('starting');
  // libuv requires the expanded path on Windows, including 8.3 temp aliases.
  const fileWatcher = probeSession ? null : fs.watch(fs.realpathSync.native(work), (_, name) => {
    if (name === 'review-cycle.json') schedule();
  });
  if (!probeSession) {
    pollTimer = setInterval(schedule, POLL_INTERVAL_MS);
    schedule(); // Also catch API outages when SSE never connects.
  }
  const stop = () => { stopping = true; controller?.abort(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    while (!stopping) {
      controller = new AbortController();
      const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => controller.abort(), 45000);
      };
      try {
        resetWatchdog();
        const response = await fetch(baseUrl + '/global/event', { headers, signal: controller.signal });
        if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
          throw new Error(`SSE connection rejected: ${response.status}`);
        }
        runtime('connected');
        log('connected');
        consecutiveFailures = 0;
        // Reconcile once per connection to catch a completion during a disconnect.
        schedule();
        const parser = createParser({ onEvent(event) {
          let raw;
          try { raw = JSON.parse(event.data); } catch { return; }
          const cycle = readJson(statePath);
          if (!relevantEvent(raw, probeSession || cycle.sessionId)) return;
          const payload = raw.payload || raw;
          log('received', { type: payload.type, sessionId: payload.properties.sessionID });
          if (probeSession) { stop(); return; }
          schedule();
        }});
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          resetWatchdog();
          parser.feed(decoder.decode(chunk, { stream: true }));
          if (stopping) break;
        }
      } catch (error) {
        if (!stopping) log('reconnect', { message: error.message.slice(0, 150) });
      } finally { clearTimeout(watchdog); }
      if (!stopping) {
        runtime('reconnecting');
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, 1000 * 2 ** consecutiveFailures++)));
      }
    }
  } finally {
    clearInterval(pollTimer);
    fileWatcher?.close();
    await chain;
    runtime('stopped');
  }
}

module.exports = { noticeFor, relevantEvent, watchdogObservation, unavailableObservation, POLL_INTERVAL_MS };
if (require.main === module) {
  let release;
  try { release = acquireLock(path.join(work, 'listener.lock')); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (release) main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(release);
}
