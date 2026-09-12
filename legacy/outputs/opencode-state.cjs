const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const ACTIVE = ['dispatching', 'waiting_for_grok', 'deliveryUncertain'];
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
function saveJson(file, data) {
  const text = JSON.stringify(data, null, 2);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    if (fs.readFileSync(file, 'utf8') !== text) throw Error('State verification failed: ' + file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function acquireLock(file) {
  // An abandoned lock is deliberately not removed automatically: PID reuse and
  // two simultaneous reclaimers must not create multiple writers/listeners.
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error(`Lock exists; inspect its PID before removing: ${file}`);
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(file); throw error; }
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}
const normalizeDirectory = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
const fingerprint = cycle => JSON.stringify([cycle.codexThreadId, cycle.sessionId,
  cycle.directory, cycle.codeDirectory, cycle.submittedMessageId, cycle.dispatch,
  cycle.round, cycle.maxRounds, cycle.status, cycle.lastReviewedAssistantMessageId,
  cycle.scope, cycle.repairScope, cycle.sourceReport, cycle.currentTaskFile, cycle.latestReviewReport, cycle.deliveryMode, cycle.model]);
const marker = id => `[CODEX_DISPATCH:${id}]`;
const textOf = message => (message.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
const hash = text => createHash('sha256').update(text).digest('hex');

function resolveRequest(cycle, messages) {
  const users = messages.filter(m => m.info.role === 'user');
  if (cycle.dispatch?.id) {
    const matches = users.filter(m => textOf(m).endsWith('\n\n' + marker(cycle.dispatch.id))
      && hash(textOf(m)) === cycle.dispatch.promptHash);
    if (matches.length !== 1) return null;
    return matches[0];
  }
  return users.find(m => m.info.id === cycle.submittedMessageId) || null;
}

// A synthetic user role is not a new assignment. Prove the entire continuation
// chain from the durable dispatch, never from its text or the newest message ID.
function resolveBinding(cycle, messages) {
  const request = resolveRequest(cycle, messages);
  if (!request || (cycle.submittedMessageId && cycle.submittedMessageId !== request.info.id)) return null;
  if (request.info.sessionID && request.info.sessionID !== cycle.sessionId) return null;
  const tail = messages.slice(messages.indexOf(request) + 1);
  const hasLaterUser = tail.some(m => m.info.role === 'user');
  if (hasLaterUser && !cycle.dispatch?.id) return null;
  let effectiveRequest = request;
  let pending = null;
  const compactions = [];
  const seen = new Set([request.info.id]);
  for (const message of tail) {
    const info = message.info;
    if (!info.id || seen.has(info.id)) return null;
    seen.add(info.id);
    // Full session identity is required for the compaction exception. Ordinary
    // legacy messages may omit it, but cannot establish a synthetic chain.
    if ((hasLaterUser && info.sessionID !== cycle.sessionId)
      || (info.sessionID && info.sessionID !== cycle.sessionId)) return null;
    const parts = message.parts || [];
    if (parts.some(p => (p.sessionID && p.sessionID !== cycle.sessionId)
      || (p.messageID && p.messageID !== info.id))) return null;
    if (info.role === 'user') {
      if (!pending && parts.length === 1 && parts[0].type === 'compaction' && parts[0].auto === true) {
        pending = { requestId: info.id, summaryId: null, continuationId: null };
        compactions.push(pending);
      } else if (pending?.summaryId && parts.length > 0
        && parts.every(p => p.type === 'text' && p.synthetic === true && p.metadata?.compaction_continue === true)) {
        pending.continuationId = info.id;
        pending = null;
      } else return null;
      effectiveRequest = message;
    } else if (info.role === 'assistant') {
      if ((hasLaterUser || info.parentID) && info.parentID !== effectiveRequest.info.id) return null;
      if (pending) {
        if (info.summary !== true || info.mode !== 'compaction' || info.agent !== 'compaction') return null;
        if (!info.error && info.finish === 'stop' && info.time?.completed
          && !parts.some(p => p.type === 'tool' && ['pending', 'running'].includes(p.state?.status))) {
          if (pending.summaryId) return null;
          pending.summaryId = info.id;
        }
      } else if (info.summary === true || info.mode === 'compaction') return null;
    } else return null;
  }
  return { request, effectiveRequest, compactions, pendingCompaction: Boolean(pending) };
}

function bindingRecord(cycle, binding) {
  return { dispatchId: cycle.dispatch?.id || null, originalRequestId: binding.request.info.id,
    effectiveRequestId: binding.effectiveRequest.info.id, compactions: binding.compactions,
    pendingCompaction: binding.pendingCompaction };
}

module.exports = { ACTIVE, readJson, saveJson, acquireLock, normalizeDirectory,
  fingerprint, marker, textOf, hash, resolveRequest, resolveBinding, bindingRecord };
