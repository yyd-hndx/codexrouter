const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReconciler } = require('../../outputs/opencode-delivery.cjs');
const { dispatch } = require('../../outputs/opencode-dispatch.cjs');
const { noticeFor, watchdogObservation, unavailableObservation } = require('../../outputs/opencode-events.cjs');
const { saveJson, readJson, acquireLock, marker, hash } = require('../../outputs/opencode-state.cjs');
const clone = structuredClone;
const cycle = { status: 'waiting_for_grok', deliveryMode:'events', model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId: 'owner', sessionId: 'session',
  directory: 'E:/project', codeDirectory: 'E:/project', submittedMessageId: 'user', round: 1, maxRounds: 3 };
const user = { info: { id: 'user', role: 'user' }, parts: [{ type: 'text', text: 'task' }] };
const answer = { info: { id: 'answer', role: 'assistant', parentID: 'user', finish: 'stop', time: { completed: 100 } }, parts: [] };

function deliveryHarness(changes = {}, options = {}) {
  let state = { ...cycle, ...changes }, diskLedger = clone(options.ledger || { delivered: [] });
  const calls = { api: 0, queue: [], submit: [], writes: 0, logs: [] };
  let now = 1000;
  const deps = {
    readCycle: () => clone(state), readLedger: () => clone(diskLedger),
    saveLedger: value => { calls.writes++; options.onSave?.(value, calls); diskLedger = clone(value); },
    api: async route => {
      calls.api++; options.onApi?.(state);
      if (options.outage) throw Error('offline');
      return route.endsWith('/message') ? clone(options.messages ?? [user, answer]) : route === '/session/status' ? {} : [];
    },
    noticeFor, watchdog: (c, s, p) => watchdogObservation(c, s, p, now),
    unavailable: (c, p) => unavailableObservation(c, p, now),
    queue: async (thread, message) => {
      calls.queue.push({ thread, message });
      return options.queue ? options.queue() : { stdout: 'Queued message mock.' };
    },
    submit: async (threadId, message, eventId) => {
      calls.submit.push({threadId,message,eventId});
      return options.submit ? options.submit(threadId,eventId) : {submitted:true,threadId,eventId,transport:'mock'};
    },
    wait: async () => {}, log: (...args) => calls.logs.push(args), workflowPath: 'workflow', statePath: 'state',
  };
  return { calls, reconcile: createReconciler(deps), restart: () => createReconciler(deps),
    ledger: () => diskLedger, state, advance: () => { now += 300000; } };
}

test('Async/default callbacks persist exact-owner acceptance and dedupe after restart',async()=>{
  for(const deliveryMode of [undefined,'async']) {
    const h=deliveryHarness({deliveryMode});
    await h.reconcile();await h.reconcile();await h.restart()();
    assert.equal(h.calls.submit.length,1);assert.equal(h.calls.queue.length,0);
    assert.equal(h.calls.submit[0].threadId,'owner');
    assert.equal(h.ledger().lastSubmitted.status,'submitted');
    assert.equal(h.ledger().lastSubmitted.autoSubmitted,true);
  }
});

test('Async uncertain and wrong-owner receipts block resubmission across restart',async()=>{
  for(const submit of [async()=>{throw Object.assign(Error('lost receipt'),{code:'ENOENT'})},async(threadId,eventId)=>({submitted:true,threadId:'other',eventId})]) {
    const h=deliveryHarness({deliveryMode:'async'},{submit});
    await assert.rejects(h.reconcile());await h.reconcile();await h.restart()();
    assert.equal(h.calls.submit.length,1);assert.equal(h.calls.queue.length,0);
    assert.ok(h.ledger().deliveryUncertain);
  }
});

test('normal completion deduplicates repeated events and process restart', async () => {
  const h = deliveryHarness(); await h.reconcile(); await h.reconcile(); await h.restart()();
  assert.equal(h.calls.queue.length, 1);
  assert.equal(h.ledger().lastQueued.status,'queued');
  assert.equal(h.ledger().lastQueued.autoSubmitted,false);
  assert.equal(h.ledger().delivered.length,0);
});

test('Explicit direct completion persists availability without queueing or erasing ambiguous historical delivery',async()=>{
  for(const deliveryMode of ['direct']) {
    const h=deliveryHarness({deliveryMode},{ledger:{delivered:['historical'],pending:{key:'old'}}});
    await h.reconcile();await h.restart()();
    assert.equal(h.calls.queue.length,0);
    assert.equal(h.ledger().lastNotice.status,'available');
    assert.equal(h.ledger().lastNotice.assistantMessageId,'answer');
    assert.equal(h.ledger().pending.key,'old');
    assert.deepEqual(h.ledger().delivered,['historical']);
  }
});
test('dispatching, absent ID and uncertain binding query real history and notify', async () => {
  for (const status of ['dispatching', 'waiting_for_grok', 'deliveryUncertain']) {
    const h = deliveryHarness({ status, submittedMessageId: null }); await h.reconcile();
    assert.equal(h.calls.api, 4); assert.equal(h.calls.queue.length, 1);
    assert.match(h.calls.queue[0].message, /binding_mismatch/);
  }
});
test('dispatch interrupted before a message exists eventually alerts', async () => {
  const h = deliveryHarness({ status: 'dispatching', submittedMessageId: null }, { messages: [] });
  await h.reconcile(); assert.equal(h.calls.queue.length, 0);
  h.advance(); await h.reconcile(); assert.equal(h.calls.queue.length, 1);
});
test('uncertain binding with running tool still gets stalled watchdog', async () => {
  const h = deliveryHarness({ status: 'deliveryUncertain', submittedMessageId: null }, {
    messages: [user, { info: { id: 'running', role: 'assistant' }, parts: [] }],
  });
  await h.reconcile(); h.advance(); await h.reconcile(); assert.equal(h.calls.queue.length, 1);
});
test('API outage without any completion event eventually alerts', async () => {
  const h = deliveryHarness({ status: 'dispatching', submittedMessageId: null }, { outage: true });
  await h.reconcile(); h.advance(); await h.reconcile(); assert.equal(h.calls.queue.length, 1);
});
test('acknowledged queue retries only ledger writes', async () => {
  let fail = true;
  const h = deliveryHarness({}, { onSave: ledger => {
    if (ledger.lastQueued && fail) { fail = false; throw Error('disk locked'); }
  } });
  await h.reconcile(); await h.reconcile(); assert.equal(h.calls.queue.length, 1);
  assert.equal(h.ledger().pending, undefined);
});
test('persistent post-ack write failure does not repeat queue in process or after restart', async () => {
  let fail = true;
  const h = deliveryHarness({}, { onSave: ledger => { if (ledger.lastQueued && fail) throw Error('disk full'); } });
  await assert.rejects(h.reconcile(), /disk full/); assert.equal(h.calls.queue.length, 1);
  await h.restart()(); assert.equal(h.calls.queue.length, 1); // Disk retained pending.
  fail = false; await h.reconcile(); assert.equal(h.calls.queue.length, 1);
});
test('write failure before enqueue makes no queue call', async () => {
  const h = deliveryHarness({}, { onSave: ledger => { if (ledger.pending) throw Error('disk full'); } });
  await assert.rejects(h.reconcile(), /disk full/); assert.equal(h.calls.queue.length, 0);
});
test('pending or uncertain ledger blocks automatic resubmission after restart', async () => {
  for (const key of ['pending', 'deliveryUncertain']) {
    const h = deliveryHarness({}, { ledger: { delivered: [], [key]: { key: 'old' } } });
    await h.reconcile(); await h.restart()(); assert.equal(h.calls.queue.length, 0);
  }
});
test('timeout, missing acknowledgement and nonzero queue exit never blindly retry', async () => {
  for (const queue of [() => { throw Object.assign(Error('timeout'), { killed: true }); },
    () => ({ stdout: 'unexpected output' }), () => { throw Object.assign(Error('exit'), { code: 1 }); }]) {
    const h = deliveryHarness({}, { queue }); await assert.rejects(h.reconcile());
    await h.reconcile(); await h.restart()(); assert.equal(h.calls.queue.length, 1);
    assert.ok(h.ledger().deliveryUncertain);
  }
});
test('proven spawn failure can retry on next observation', async () => {
  let first = true;
  const h = deliveryHarness({}, { queue: () => {
    if (first) { first = false; throw Object.assign(Error('missing cli'), { code: 'ENOENT' }); }
    return { stdout: 'Queued message mock.' };
  } });
  await assert.rejects(h.reconcile()); await h.reconcile(); assert.equal(h.calls.queue.length, 2);
});
test('request, owner, directory, dispatch, round, pause and review changes invalidate snapshot', async () => {
  for (const change of [{ submittedMessageId: 'next' }, { model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId: 'other' }, { directory: 'other' },
    { dispatch: { id: 'next' } }, { round: 2 }, { maxRounds: 1 }, { status: 'paused_user' }, { lastReviewedAssistantMessageId: 'answer' }]) {
    const h = deliveryHarness({}, { onApi: state => Object.assign(state, change) });
    await h.reconcile(); assert.equal(h.calls.queue.length, 0);
  }
});
test('completed, paused and reviewing cycles do not query or enqueue', async () => {
  for (const status of ['complete', 'paused_user', 'reviewing']) {
    const h = deliveryHarness({ status }); await h.reconcile(); assert.equal(h.calls.api, 0);
  }
});
test('different assistant parent requires reconciliation, never normal completion', async () => {
  const h = deliveryHarness({}, { messages: [user, { ...answer, info: { ...answer.info, parentID: 'other' } }] });
  await h.reconcile(); assert.match(h.calls.queue[0].message, /binding_mismatch/);
});

function dispatchHarness(options = {}) {
  let state = { ...cycle, status: 'ready_to_dispatch', round: 0, submittedMessageId: null, ...options.cycle };
  let messages = clone(options.messages || []);
  const calls = { posts: 0, starts: 0, released: 0, order: [] };
  const input = { action: 'send', threadId: 'owner', sessionId: 'session', directory: 'E:/project', prompt: 'task', variant: 'xhigh' };
  const deps = {
    lock: () => () => { calls.released++; }, read: () => clone(state),
    save: value => { options.onSave?.(value); state = clone(value); calls.order.push(value.status); },
    startListener: async () => { calls.starts++; calls.order.push('listener'); if (options.startFails) throw Error('start failed'); },
    wait: async () => {},
    api: async (route, c, body) => {
      if (body) {
        calls.posts++; calls.order.push('post');
        if (!options.noMessage) messages.push({ info: { id: 'actual_user', role: 'user' }, parts: clone(body.parts) });
        if (options.sendThrows) throw Error('network timeout');
        return null;
      }
      if (route.endsWith('/message')) return clone(messages);
      if (route === '/session/session') return { directory: options.actualDirectory || 'E:/project' };
      if (route === '/session/status') return options.busy ? { session: { type: 'busy' } } : {};
      return [];
    },
  };
  return { calls, input, deps, run: () => dispatch(input, deps), state: () => state, messages: () => messages };
}
test('Send saves recovery identity and starts listener before POST, then binds actual ID', async () => {
  const h = dispatchHarness(); const result = await h.run();
  assert.deepEqual(h.calls.order, ['dispatching', 'listener', 'post', 'waiting_for_grok']);
  assert.equal(result.submittedMessageId, 'actual_user'); assert.equal(h.state().round, 1);
  assert.equal(h.calls.posts, 1); assert.equal(h.calls.released, 1);
});
test('failure before durable save or listener readiness never sends', async () => {
  for (const opts of [{ onSave: () => { throw Error('disk full'); } }, { startFails: true }]) {
    const h = dispatchHarness(opts); await assert.rejects(h.run()); assert.equal(h.calls.posts, 0);
  }
});
test('ambiguous POST uses recorded unique marker and never repeats request', async () => {
  const h = dispatchHarness({ sendThrows: true }); await h.run(); assert.equal(h.calls.posts, 1);
  assert.equal(h.state().submittedMessageId, 'actual_user');
});
test('post-send state failure leaves durable recoverable dispatch and Reconcile sends nothing', async () => {
  let fail = true;
  const h = dispatchHarness({ onSave: value => { if (value.status === 'waiting_for_grok' && fail) throw Error('write failed'); } });
  await assert.rejects(h.run(), /write failed/); assert.equal(h.state().status, 'dispatching');
  fail = false; h.input.action = 'reconcile'; await h.run();
  assert.equal(h.calls.posts, 1); assert.equal(h.state().submittedMessageId, 'actual_user'); assert.equal(h.state().round, 1);
});
test('unproven submission stays uncertain and cannot be resent or reconciled blindly', async () => {
  const h = dispatchHarness({ noMessage: true, sendThrows: true }); await assert.rejects(h.run(), /uncertain/);
  assert.equal(h.state().status, 'deliveryUncertain'); await assert.rejects(h.run(), /Reconcile/);
  h.input.action = 'reconcile'; await assert.rejects(h.run(), /No unique/); assert.equal(h.calls.posts, 1);
});
test('newer unrelated user message prevents recovery from adopting or overwriting it', async () => {
  const h = dispatchHarness(); await h.run(); h.messages().push(user); h.input.action = 'reconcile';
  await assert.rejects(h.run(), /No unique/); assert.equal(h.calls.posts, 1);
});
test('owner mismatch, busy session, reused fresh session, wrong directory and round cap reject Send', async () => {
  for (const options of [{ cycle: { model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId: 'other' } }, { busy: true }, { messages: [user] },
    { actualDirectory: 'E:/wrong' }, { cycle: { round: 3 } }]) {
    const h = dispatchHarness(options); await assert.rejects(h.run()); assert.equal(h.calls.posts, 0);
  }
});
test('repair round requires latest reviewed response and increments exactly once', async () => {
  const h = dispatchHarness({ cycle: { status: 'reviewing', round: 1, lastReviewedAssistantMessageId: 'answer' }, messages: [user, answer] });
  await h.run(); assert.equal(h.state().round, 2); await assert.rejects(h.run()); assert.equal(h.calls.posts, 1);
});
test('real atomic save replaces valid JSON, preserves previous file on invalid data, lock excludes second writer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-state-test-'));
  const file = path.join(dir, 'cycle.json');
  try {
    saveJson(file, { value: 1 }); saveJson(file, { value: 2 }); assert.deepEqual(readJson(file), { value: 2 });
    const circular = {}; circular.self = circular; assert.throws(() => saveJson(file, circular));
    assert.deepEqual(readJson(file), { value: 2 });
    const lock = path.join(dir, 'test.lock'); const release = acquireLock(lock);
    assert.throws(() => acquireLock(lock), /Lock exists/); release(); acquireLock(lock)();
    assert.deepEqual(fs.readdirSync(dir), ['cycle.json']);
  } finally {
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'grok-state-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
