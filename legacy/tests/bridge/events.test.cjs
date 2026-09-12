const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createParser } = require('eventsource-parser');
const { noticeFor, relevantEvent, watchdogObservation, unavailableObservation,
  POLL_INTERVAL_MS } = require('../../outputs/opencode-events.cjs');
const cycle = { status: 'waiting_for_grok', sessionId: 'ses_target', submittedMessageId: 'msg_user' };
const done = { lastUser: { info: { id: 'msg_user' } },
  last: { info: { id: 'msg_answer', role: 'assistant', finish: 'stop', time: { completed: 100 } }, parts: [] },
  permissions: [], questions: [] };
test('completed run produces a stable dedupe key', () => {
  assert.equal(noticeFor(cycle, done).reason, 'completed');
  assert.equal(noticeFor(cycle, done).key, noticeFor(cycle, structuredClone(done)).key);
});
test('completed run with stale cycle binding still notifies for reconciliation', () => {
  const stale = { ...cycle, submittedMessageId: 'msg_old' };
  const notice = noticeFor(stale, done);
  assert.equal(notice.reason, 'binding_mismatch');
  assert.equal(notice.bindingMismatch, true);
  assert.equal(notice.userMessageId, 'msg_user');
});
test('busy and retry do not count as completion', () => {
  for (const type of ['busy', 'retry']) assert.equal(noticeFor(cycle, { ...done, status: { type } }), null);
});
test('incomplete model/tool output does not count as completion', () => {
  assert.equal(noticeFor(cycle, { ...done, last: { info: { role: 'assistant', finish: 'tool-calls' } } }), null);
  assert.equal(noticeFor(cycle, { ...done, last: { ...done.last, parts: [{ type: 'tool', state: { status: 'running' } }] } }), null);
});
test('paused or already reviewed jobs are ignored', () => {
  assert.equal(noticeFor({ ...cycle, status: 'paused_round_limit' }, done), null);
  assert.equal(noticeFor({ ...cycle, lastReviewedAssistantMessageId: 'msg_answer' }, done), null);
});
test('permissions and questions are actionable while busy', () => {
  assert.equal(noticeFor(cycle, { ...done, status: { type: 'busy' }, permissions: [{ id: 'per_1' }] }).reason, 'needs_attention');
  assert.equal(noticeFor(cycle, { ...done, questions: [{ id: 'que_1' }] }).requestId, 'que_1');
});
test('stream tokens and other sessions are ignored', () => {
  assert.equal(relevantEvent({ type: 'session.idle', properties: { sessionID: 'ses_other' } }, 'ses_target'), false);
  assert.equal(relevantEvent({ type: 'message.part.updated', properties: { sessionID: 'ses_target' } }, 'ses_target'), false);
  assert.equal(relevantEvent({ payload: { type: 'session.status', properties: { sessionID: 'ses_target', status: { type: 'idle' } } } }, 'ses_target'), true);
});
test('SSE parser handles fragmented CRLF and multiline JSON', () => {
  const received = [];
  const parser = createParser({ onEvent: e => received.push(JSON.parse(e.data)) });
  const text = 'data: {"type":"session.idle",\r\ndata: "properties":{"sessionID":"ses_target"}}\r\n\r\n';
  for (const character of text) parser.feed(character);
  assert.equal(received.length, 1);
  assert.equal(relevantEvent(received[0], 'ses_target'), true);
});

const running = (output = '', timeout = 15000) => ({
  ...done, status: { type: 'busy' },
  last: { info: { id: 'msg_work', role: 'assistant', time: { created: 1000 } },
    parts: [{ id: 'part_startup', type: 'tool', tool: 'bash',
      state: { status: 'running', input: { timeout }, time: { start: 1000 }, output } }] },
});

test('silent startup alerts at five minutes and repeated checks deduplicate', () => {
  assert.equal(POLL_INTERVAL_MS, 300000);
  const first = watchdogObservation(cycle, running(), null, 1000);
  assert.equal(first.notice, null);
  assert.equal(watchdogObservation(cycle, running(), first.monitor, 300999).notice, null);
  const stalled = watchdogObservation(cycle, running(), first.monitor, 301000);
  assert.equal(stalled.notice.reason, 'stalled');
  assert.equal(stalled.notice.toolPartId, 'part_startup');
  assert.equal(stalled.notice.idleSeconds, 300);
  assert.equal(watchdogObservation(cycle, running(), stalled.monitor, 601000).notice.key, stalled.notice.key);
});

test('new output and reasoning reset inactivity without storing private content', () => {
  const first = watchdogObservation(cycle, running(), null, 1000);
  const progress = watchdogObservation(cycle, running('private output'), first.monitor, 301000);
  assert.equal(progress.notice, null);
  assert.equal(progress.monitor.lastProgressAt, 301000);
  assert.equal(progress.monitor.fingerprint.length, 64);
  assert.ok(!JSON.stringify(progress).includes('private output'));
  const thinking = { ...running(), last: { info: { id: 'msg_think', role: 'assistant' },
    parts: [{ id: 'reasoning1', type: 'reasoning', text: 'first thought' }] } };
  const thought = watchdogObservation(cycle, thinking, null, 1000);
  thinking.last.parts[0].text += ' continuing';
  assert.equal(watchdogObservation(cycle, thinking, thought.monitor, 301000).notice, null);
});

test('long command gets its requested timeout plus grace', () => {
  const long = running('', 900000);
  const first = watchdogObservation(cycle, long, null, 1000);
  assert.equal(watchdogObservation(cycle, long, first.monitor, 301000).notice, null);
  assert.equal(watchdogObservation(cycle, long, first.monitor, 960999).notice, null);
  assert.equal(watchdogObservation(cycle, long, first.monitor, 961000).notice.reason, 'stalled');
});

test('new owner or session resets inactivity; newer user input cannot trigger an old alert', () => {
  const first = watchdogObservation(cycle, running(), null, 1000);
  for (const change of [{ sessionId: 'ses_new' }, { model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId: 'new_owner' }]) {
    assert.equal(watchdogObservation({ ...cycle, ...change }, running(), first.monitor, 301000).notice, null);
  }
  const newer = { ...done, lastUser: { info: { id: 'msg_new' } } };
  assert.equal(noticeFor(cycle, newer).reason, 'binding_mismatch');
  assert.equal(watchdogObservation(cycle, newer, first.monitor, 301000).monitor.lastProgressAt, 301000);
  assert.equal(watchdogObservation({ ...cycle, submittedMessageId: 'msg_new' },
    { ...running(), lastUser: newer.lastUser }, first.monitor, 301000).notice, null);
});

test('missing response and unfinished idle response eventually notify', () => {
  for (const snapshot of [{ ...running(), last: null },
    { ...running(), status: null, last: { info: { id: 'msg_interrupted', role: 'assistant',
      finish: 'tool-calls', time: { completed: 1000 } }, parts: [] } }]) {
    const first = watchdogObservation(cycle, snapshot, null, 1000);
    assert.equal(watchdogObservation(cycle, snapshot, first.monitor, 301000).notice.reason, 'stalled');
  }
});

test('inactive cycles never alert and polling recovers missed completion', () => {
  for (const status of ['complete', 'paused_round_limit', 'reviewing', 'dispatching']) {
    assert.equal(watchdogObservation({ ...cycle, status }, running(), null).notice, null);
  }
  assert.equal(watchdogObservation({ ...cycle, submittedMessageId: null }, running(), null).notice, null);
  const first = watchdogObservation(cycle, done, null, 1000);
  assert.equal(watchdogObservation(cycle, done, first.monitor, 301000).notice, null);
  assert.equal(noticeFor(cycle, done).reason, 'completed');
});

test('API outage alerts after five minutes and new requests reset its timer', () => {
  const first = unavailableObservation(cycle, null, 1000);
  assert.equal(first.notice, null);
  const later = unavailableObservation(cycle, first.monitor, 301000);
  assert.equal(later.notice.reason, 'service_unavailable');
  assert.equal(unavailableObservation(cycle, later.monitor, 601000).notice.key, later.notice.key);
  assert.equal(unavailableObservation({ ...cycle, submittedMessageId: 'new' }, first.monitor, 301000).notice, null);
});
