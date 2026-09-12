const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { readJson, saveJson, acquireLock, normalizeDirectory, fingerprint,
  marker, hash, resolveBinding, bindingRecord, completedCycle } = require('./opencode-state.cjs');
const work = path.resolve(__dirname, '../work/opencode-bridge');
const statePath = path.join(work, 'review-cycle.json');

function checkOwner(cycle, input) {
  if (!input.threadId || cycle.codexThreadId !== input.threadId) throw Error('Current Codex thread does not own this cycle.');
  if (!input.sessionId || cycle.sessionId !== input.sessionId) throw Error('A verified, explicitly bound session is required.');
  if (!cycle.directory || !cycle.codeDirectory
    || normalizeDirectory(cycle.directory) !== normalizeDirectory(input.directory)
    || normalizeDirectory(cycle.codeDirectory) !== normalizeDirectory(input.directory)) throw Error('Cycle and code-project directory do not match.');
}

async function dispatch(input, deps) {
  const release = deps.lock();
  try {
    let cycle = deps.read();
    checkOwner(cycle, input);
    if (input.action === 'reconcile') {
      if (!['dispatching', 'deliveryUncertain', 'waiting_for_grok', 'callback_pending', 'reviewing'].includes(cycle.status)) throw Error('Cycle is not awaiting dispatch reconciliation.');
      const session = await deps.api('/session/' + cycle.sessionId, cycle);
      if (normalizeDirectory(session.directory) !== normalizeDirectory(cycle.directory)) throw Error('Actual session directory mismatch.');
      const messages = await deps.api('/session/' + cycle.sessionId + '/message', cycle);
      const binding = resolveBinding(cycle, messages);
      if (!binding) {
        throw Error('No unique current dispatch proven; inspect history. Nothing was sent.');
      }
      const request = binding.request;
      if (fingerprint(deps.read()) !== fingerprint(cycle)) throw Error('Cycle changed during reconciliation.');
      cycle = { ...cycle, submittedMessageId: request.info.id,
        round: cycle.dispatch?.nextRound ?? cycle.round,
        status: ['callback_pending', 'reviewing'].includes(cycle.status) ? cycle.status : 'waiting_for_grok',
        requestBinding: bindingRecord(cycle, binding) };
      cycle = completedCycle(cycle, messages);
      deps.save(cycle);
      if (cycle.status !== 'reviewing') await deps.startListener();
      return { submitted: true, reconciled: true, sessionId: cycle.sessionId,
        submittedMessageId: request.info.id, effectiveRequestId: binding.effectiveRequest.info.id,
        status: cycle.status, responseId: cycle.dispatch?.responseId || null, round: cycle.round };
    }
    if (!['ready_to_dispatch', 'reviewing'].includes(cycle.status)) throw Error('Send requires ready_to_dispatch or reviewing. Use Reconcile for an uncertain prior send.');
    if (!input.prompt?.trim() || !input.variant?.trim()) throw Error('A prompt and explicit variant are required.');
    if (!cycle.model?.providerID || !cycle.model?.modelID) throw Error('Configure cycle.model.providerID and modelID before Send.');
    const deliveryMode=cycle.deliveryMode||'async';
    if(!['async','direct','events'].includes(deliveryMode))throw Error('Unsupported delivery mode.');
    if (!Number.isInteger(cycle.round) || !Number.isInteger(cycle.maxRounds)
      || cycle.round < 0 || cycle.round >= cycle.maxRounds) throw Error('Invalid round or authorized round limit reached.');
    const [session, messages, statuses, permissions, questions] = await Promise.all([
      deps.api('/session/' + cycle.sessionId, cycle), deps.api('/session/' + cycle.sessionId + '/message', cycle),
      deps.api('/session/status', cycle), deps.api('/permission', cycle), deps.api('/question', cycle),
    ]);
    if (normalizeDirectory(session.directory) !== normalizeDirectory(cycle.directory)) throw Error('Actual session directory mismatch.');
    if (['busy', 'retry'].includes(statuses[cycle.sessionId]?.type)
      || [...permissions, ...questions].some(p => p.sessionID === cycle.sessionId)
      || messages.at(-1)?.parts?.some(p => p.type === 'tool' && ['running', 'pending'].includes(p.state?.status))) {
      throw Error('Session has running work or pending attention; do not dispatch.');
    }
    if (cycle.round === 0 && messages.length) throw Error('A new cycle requires a verified empty session.');
    if (cycle.round > 0 && (!cycle.lastReviewedAssistantMessageId
      || messages.at(-1)?.info.id !== cycle.lastReviewedAssistantMessageId)) throw Error('Latest response must be reviewed before another dispatch.');
    if (cycle.dispatch?.responseId && cycle.dispatch.responseId !== cycle.lastReviewedAssistantMessageId) throw Error('Pinned response must be reviewed before another dispatch.');
    if (fingerprint(deps.read()) !== fingerprint(cycle)) throw Error('Cycle changed during preflight.');
    const id = randomUUID();
    const prompt = input.prompt + '\n\n' + marker(id);
    cycle = { ...cycle, deliveryMode, status: 'dispatching', submittedMessageId: null,
      dispatch: { id, promptHash: hash(prompt), startedAt: new Date().toISOString(),
        nextRound: cycle.round + 1 } };
    delete cycle.requestBinding;
    delete cycle.dispatchReconciliation;
    deps.save(cycle); // Durable recovery identity before any external submission.
    if (fingerprint(deps.read()) !== fingerprint(cycle)) throw Error('Dispatch state verification failed; nothing sent.');
    await deps.startListener(); // Catch-up exists even if this process dies after POST.
    if (fingerprint(deps.read()) !== fingerprint(cycle)) throw Error('Cycle changed before send; nothing sent.');
    let sendError;
    try {
      await deps.api('/session/' + cycle.sessionId + '/prompt_async', cycle, {
        model: cycle.model, variant: input.variant, parts: [{ type: 'text', text: prompt }],
      });
    } catch (error) { sendError = error; }
    // Never retry POST, including ambiguous HTTP failures/timeouts.
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await deps.wait(500);
      let history;
      try { history = await deps.api('/session/' + cycle.sessionId + '/message', cycle); }
      catch { continue; }
      const binding = resolveBinding(cycle, history);
      if (!binding) continue;
      const request = binding.request;
      if (fingerprint(deps.read()) !== fingerprint(cycle)) throw Error('Submission may exist; cycle changed. Reconcile, do not resend.');
      const bound = { ...cycle, status: 'waiting_for_grok', submittedMessageId: request.info.id,
        round: cycle.dispatch.nextRound, requestBinding: bindingRecord(cycle, binding) };
      deps.save(bound);
      if (fingerprint(deps.read()) !== fingerprint(bound)) throw Error('Post-send state verification failed; reconcile, do not resend.');
      return { submitted: true, sessionId: cycle.sessionId, submittedMessageId: request.info.id,
        dispatchId: id, round: bound.round };
    }
    if (fingerprint(deps.read()) === fingerprint(cycle)) deps.save({ ...cycle, status: 'deliveryUncertain' });
    throw Error(`Submission binding uncertain${sendError ? ' after API failure' : ''}; listener retained. Use Reconcile; never resend blindly.`);
  } finally { release(); }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const auth = process.env.OPENCODE_BRIDGE_AUTH;
  delete process.env.OPENCODE_BRIDGE_AUTH;
  if (!auth || !process.env.CODEX_THREAD_ID) throw Error('Run through the bridge inside the owning Codex task.');
  input.threadId = process.env.CODEX_THREAD_ID;
  const result = await dispatch(input, {
    lock: () => acquireLock(path.join(work, 'dispatch.lock')),
    read: () => readJson(statePath), save: value => saveJson(statePath, value),
    wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
    startListener: async () => {
      const result = await execFile(process.env.OPENCODE_BRIDGE_PWSH || 'pwsh.exe',
        ['-NoProfile', '-File', path.join(__dirname, 'opencode-events.ps1'), '-Action', 'Start'],
        { windowsHide: true, timeout: 20000 });
      const status = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
      if (!['starting', 'connected', 'reconnecting'].includes(status.status)) throw Error('Listener did not become ready; no dispatch performed.');
    },
    api: async (route, cycle, body) => {
      const response = await fetch((process.env.OPENCODE_REVIEW_URL || 'http://127.0.0.1:4096') + route + '?directory=' + encodeURIComponent(cycle.directory), {
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error(`OpenCode ${route}: HTTP ${response.status}`);
      const text = await response.text(); return text ? JSON.parse(text) : null;
    },
  });
  console.log(JSON.stringify(result));
}
module.exports = { dispatch };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
