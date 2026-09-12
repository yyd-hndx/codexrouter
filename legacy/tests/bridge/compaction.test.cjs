const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveBinding, marker, hash } = require('../../outputs/opencode-state.cjs');
const { dispatch } = require('../../outputs/opencode-dispatch.cjs');
const { createReconciler } = require('../../outputs/opencode-delivery.cjs');
const { noticeFor, watchdogObservation, unavailableObservation } = require('../../outputs/opencode-events.cjs');

function fixture(rounds = 1) {
  const text = 'authorized task\n\n' + marker('dispatch');
  const cycle = { status: 'waiting_for_grok', deliveryMode:'events', model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId: 'owner', sessionId: 'session',
    directory: 'E:/project', codeDirectory: 'E:/project', submittedMessageId: 'original',
    round: 2, maxRounds: 3, dispatch: { id: 'dispatch', promptHash: hash(text), nextRound: 2 } };
  const user = (id, parts) => ({ info: { id, role: 'user', sessionID: 'session' }, parts });
  const assistant = (id, parentID, extra = {}) => ({ info: { id, parentID, role: 'assistant',
    sessionID: 'session', finish: 'stop', time: { completed: 100 }, ...extra }, parts: [] });
  const messages = [user('original', [{ type: 'text', text }])];
  for (let i = 0; i < rounds; i++) messages.push(
    user('compact' + i, [{ type: 'compaction', auto: true }]),
    assistant('summary' + i, 'compact' + i, { summary: true, mode: 'compaction', agent: 'compaction' }),
    user('continue' + i, [{ type: 'text', text: 'Continue if you have next steps', synthetic: true, metadata: { compaction_continue: true } }]),
    assistant('answer' + i, 'continue' + i));
  return { cycle, messages, user, assistant };
}
function snapshot(f) {
  return { lastUser: f.messages.findLast(m => m.info.role === 'user'), last: f.messages.at(-1),
    binding: resolveBinding(f.cycle, f.messages), permissions: [], questions: [] };
}

test('one or repeated compactions retain original identity and accept only final business response', () => {
  for (const rounds of [1, 3]) {
    const f = fixture(rounds), s = snapshot(f);
    assert.equal(s.binding.request.info.id, 'original');
    assert.equal(s.binding.effectiveRequest.info.id, 'continue' + (rounds - 1));
    assert.equal(s.binding.compactions.length, rounds);
    assert.equal(noticeFor(f.cycle, s).reason, 'completed');
    assert.equal(f.cycle.submittedMessageId, 'original');
  }
});

test('summary completion is not task completion; a stranded compaction reaches watchdog', () => {
  const f = fixture(); f.messages = f.messages.slice(0, 3);
  const s = snapshot(f);
  assert.equal(s.binding.pendingCompaction, true);
  assert.equal(noticeFor(f.cycle, s), null);
  const first = watchdogObservation(f.cycle, s, null, 1000);
  assert.equal(watchdogObservation(f.cycle, s, first.monitor, 301000).notice.reason, 'stalled');
  s.last.info.error = { name: 'compaction_failed' };
  assert.equal(noticeFor(f.cycle, s).reason, 'error');
});

const invalid = {
  'plain user copies continuation text': f => { delete f.messages[3].parts[0].synthetic; },
  'synthetic alone is insufficient': f => { delete f.messages[3].parts[0].metadata; },
  'unmarked text mixed into continuation': f => { f.messages[3].parts.push({ type: 'text', text: 'new task' }); },
  'file attachment mixed into continuation': f => { f.messages[3].parts.push({ type: 'file', url: 'file:///new' }); },
  'manual compaction': f => { f.messages[1].parts[0].auto = false; },
  'absent summary': f => { f.messages.splice(2, 1); },
  'incomplete summary': f => { delete f.messages[2].info.time.completed; },
  'failed summary': f => { f.messages[2].info.error = { name: 'failed' }; },
  'wrong summary parent': f => { f.messages[2].info.parentID = 'unrelated'; },
  'wrong final parent': f => { f.messages[4].info.parentID = 'original'; },
  'cross-session continuation': f => { f.messages[3].info.sessionID = 'other'; },
  'missing continuation session': f => { delete f.messages[3].info.sessionID; },
  'wrong part parent': f => { f.messages[3].parts[0].messageID = 'other'; },
  'new human request between rounds': f => { f.messages.splice(4, 0, f.user('human', [{ type: 'text', text: 'change goal' }])); },
  'new human request at end': f => { f.messages.push(f.user('human', [{ type: 'text', text: 'change goal' }]), f.assistant('new', 'human')); },
  'duplicate message ID': f => { f.messages[4].info.id = f.messages[2].info.id; },
  'duplicate matching dispatch': f => { f.messages.unshift(structuredClone(f.messages[0])); },
  'missing original history': f => { f.messages.shift(); },
  'tampered original prompt': f => { f.messages[0].parts[0].text = 'changed'; },
  'mismatched persisted ID': f => { f.cycle.submittedMessageId = 'other'; },
  'no durable marker': f => { delete f.cycle.dispatch; },
};
for (const [name, mutate] of Object.entries(invalid)) test('rejects ' + name, () => {
  const f = fixture(); mutate(f);
  assert.equal(resolveBinding(f.cycle, f.messages), null);
});

function harness(f) {
  let state = structuredClone(f.cycle), ledger = { delivered: [] };
  const calls = { posts: 0, queue: [], starts: 0 };
  const deps = {
    lock: () => () => {}, read: () => structuredClone(state), save: c => { state = structuredClone(c); },
    startListener: async () => { calls.starts++; }, wait: async () => {},
    api: async (route, c, body) => {
      if (body) { calls.posts++; throw Error('unexpected model request'); }
      if (route.endsWith('/message')) return structuredClone(f.messages);
      if (route === '/session/session') return { directory: 'E:/project' };
      return route === '/session/status' ? {} : [];
    },
  };
  const deliveryDeps = { ...deps, readCycle: deps.read, readLedger: () => structuredClone(ledger),
    saveLedger: l => { ledger = structuredClone(l); }, noticeFor, watchdog: watchdogObservation,
    unavailable: unavailableObservation, queue: async (owner, message) => {
      calls.queue.push({ owner, message }); return { stdout: 'Queued message mock.' };
    }, log: () => {}, workflowPath: 'workflow', statePath: 'state' };
  return { deps, deliveryDeps, calls, state: () => state, ledger: () => ledger };
}

test('Reconcile records compacted chain without changing original ID, owner, scope or round and sends nothing', async () => {
  const f = fixture(2); f.cycle.scope = 'authorized only';
  const h = harness(f);
  for (let i = 0; i < 2; i++) {
    await dispatch({ action: 'reconcile', threadId: 'owner', sessionId: 'session', directory: 'E:/project' }, h.deps);
    assert.equal(h.state().submittedMessageId, 'original');
    assert.equal(h.state().requestBinding.effectiveRequestId, 'continue1');
    assert.equal(h.state().round, 2); assert.equal(h.state().scope, 'authorized only');
  }
  assert.equal(h.calls.posts, 0);
});

test('recovery rejects real newer requests and owner mismatch without saving or sending', async () => {
  for (const wrongOwner of [false, true]) {
    const f = fixture(); if (!wrongOwner) f.messages.push(f.user('human', [{ type: 'text', text: 'new' }]));
    const h = harness(f);
    await assert.rejects(dispatch({ action: 'reconcile', threadId: wrongOwner ? 'wrong' : 'owner', sessionId: 'session', directory: 'E:/project' }, h.deps));
    assert.deepEqual(h.state(), f.cycle); assert.equal(h.calls.posts, 0);
  }
});

test('callback delivers original and effective IDs once, including after listener restart', async () => {
  const h = harness(fixture(2));
  const reconcile = createReconciler(h.deliveryDeps);
  await reconcile(); await reconcile(); await createReconciler(h.deliveryDeps)();
  assert.equal(h.calls.queue.length, 1);
  assert.match(h.calls.queue[0].message, /OPENCODE_EVENT completed/);
  assert.match(h.calls.queue[0].message, /original dispatch request original/);
  assert.equal(h.ledger().lastQueued.verifiedRequestId, 'original');
  assert.equal(h.ledger().lastQueued.userMessageId, 'continue1');
});

test('already-delivered mismatch keeps same key after upgrade, so no duplicate notification', async () => {
  const f = fixture(), h = harness(f);
  const old = createReconciler({ ...h.deliveryDeps, noticeFor: (c, s) => {
    const copy = { ...s }; delete copy.binding; return noticeFor(c, copy);
  } });
  await old();
  assert.match(h.calls.queue[0].message, /binding_mismatch/);
  await createReconciler(h.deliveryDeps)();
  assert.equal(h.calls.queue.length, 1);
});

test('valid chain with unpersisted binding still requests reconciliation, never silent adoption', async () => {
  const f = fixture(); f.cycle.status = 'deliveryUncertain'; f.cycle.submittedMessageId = null;
  const h = harness(f); await createReconciler(h.deliveryDeps)();
  assert.match(h.calls.queue[0].message, /binding_mismatch/);
  await dispatch({ action: 'reconcile', threadId: 'owner', sessionId: 'session', directory: 'E:/project' }, h.deps);
  assert.equal(h.state().submittedMessageId, 'original'); assert.equal(h.calls.posts, 0);
});
