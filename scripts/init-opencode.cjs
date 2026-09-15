'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { options } = require('./options.cjs');
const { saveJson, acquireLock } = require('../legacy/outputs/opencode-state.cjs');
try {
  const o = options(process.argv.slice(2), ['directory', 'session', 'owner', 'provider', 'model', 'task', 'scope', 'max-rounds', 'title', 'delivery-mode']);
  for (const k of ['directory', 'session', 'owner', 'task', 'scope']) if (!o[k]) throw Error('Required: --' + k);
  if (process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== o.owner) throw Error('Owner differs from the current Codex task.');
  const directory = fs.realpathSync(o.directory);
  const task = fs.realpathSync(o.task);
  const maxRounds = Number(o['max-rounds'] || 4);
  const deliveryMode = o['delivery-mode'] || 'async';
  if (!['async', 'direct', 'events'].includes(deliveryMode)) throw Error('Invalid delivery mode.');
  if (!Number.isInteger(maxRounds) || maxRounds < 1) throw Error('Invalid round limit.');
  const work = path.join(__dirname, '../legacy/work/opencode-bridge');
  fs.mkdirSync(work, { recursive: true });
  const release = acquireLock(path.join(work, 'dispatch.lock'));
  try {
    const state = path.join(work, 'review-cycle.json');
    if (fs.existsSync(state)) throw Error('Existing legacy cycle: inspect and archive an inactive cycle before initialization.');
    saveJson(state, { status: 'ready_to_dispatch', codexThreadId: o.owner, sessionId: o.session, sessionTitle: o.title||o.scope, directory, codeDirectory: directory, ...(o.provider||o.model ? { model: { ...(o.provider ? {providerID:o.provider}:{}), ...(o.model ? {modelID:o.model}: {}) } } : {}), scope: o.scope, sourceReport: null, currentTaskFile: task, latestReviewReport: null, round: 0, maxRounds, deliveryMode, submittedMessageId: null, lastReviewedAssistantMessageId: null });
    console.log(JSON.stringify({ state, note: 'Initialized locally. Send still verifies actual directory and empty session before posting.' }));
  } finally { release(); }
} catch (e) { console.error(e.message); process.exitCode = 1; }
