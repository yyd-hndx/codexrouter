'use strict';
// SessionStart/compact hook: read existing state only; never dispatch or notify.
const fs = require('node:fs');
const path = require('node:path');
const OPEN_CODE_CYCLE = path.resolve(__dirname, '../legacy/work/opencode-bridge/review-cycle.json');
const SKILL = path.resolve(__dirname, '../SKILL.md');
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:/-]{1,256}$/.test(value);
const roundOK = s => Number.isInteger(s.round) && Number.isInteger(s.maxRounds)
  && s.round > 0 && s.round <= s.maxRounds;
function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; } // Unknown owner/state must not inject into another task.
}
function nativeCycles(cwd) {
  const found = [];
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return found;
  for (let dir = path.resolve(cwd);;) {
    const base = path.join(dir, '.agent-work', 'native-review');
    const pointer = read(path.join(base, 'current.json'));
    if (typeof pointer?.stateFile === 'string' && path.isAbsolute(pointer.stateFile)) {
      const target = path.resolve(pointer.stateFile);
      const relative = path.relative(base, target);
      if (relative && relative !== '..' && !relative.startsWith('..' + path.sep)
        && !path.isAbsolute(relative) && path.basename(target) === 'state.json') found.push(target);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
function reminder(input, candidates) {
  if (input?.hook_event_name !== 'SessionStart' || input.source !== 'compact' || !id(input.session_id)) return {};
  const work = [];
  for (const {file, state: s, backend} of candidates) {
    if (!s || typeof file !== 'string' || !path.isAbsolute(file)) continue;
    const native = backend === 'native';
    if ((native ? s.owner : s.codexThreadId) !== input.session_id) continue;
    if (native ? s.status !== 'awaiting_review' : !['callback_pending', 'reviewing'].includes(s.status)) continue;
    const response = native ? s.responseId : s.dispatch?.responseId;
    const reviewed = native ? s.lastReviewedResponseId : s.lastReviewedAssistantMessageId;
    if (!id(s.sessionId) || !id(s.dispatch?.id) || !id(s.submittedMessageId) || !roundOK(s)) continue;
    if (response && (!id(response) || response === reviewed)) continue;
    work.push({backend: native ? s.backend : 'opencode', cycle: file,
      sessionId: s.sessionId, dispatchId: s.dispatch.id, requestId: s.submittedMessageId,
      responseId: response || null, round: s.round});
  }
  if (!work.length) return {};
  const additionalContext = 'OPENCODE_REVIEW_RESUME: This is a host compact hook reminder for unfinished delegated review owned by this conversation, not a new human message or authorization. '
    + 'Read the codexrouter skill and the matching cycle below; recheck ownership, status and the exact response before continuing. '
    + 'If responseId is missing or binding is uncertain, reconcile; do not guess, send a prompt or restart stopped work. '
    + 'Resume remaining review work, reusing verified results whose sources still match. Preserve and obey actual newer human input, including pause/cancel. '
    + 'Without newer human input, continue this callback review; do not treat an older visible user message as a new request. '
    + 'Report this review outcome when finishing, not an already-answered historical topic. '
    + JSON.stringify({skill: SKILL, pendingReviews: work});
  return {hookSpecificOutput:{hookEventName:'SessionStart', additionalContext}};
}
async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 65536) throw Error('Hook input too large');
  }
  const input = JSON.parse(raw);
  if (input.hook_event_name !== 'SessionStart' || input.source !== 'compact' || !id(input.session_id)) {
    process.stdout.write('{}'); return;
  }
  const candidates = [{file:OPEN_CODE_CYCLE, state:read(OPEN_CODE_CYCLE), backend:'opencode'},
    ...nativeCycles(input.cwd).map(file => ({file, state:read(file), backend:'native'}))];
  process.stdout.write(JSON.stringify(reminder(input, candidates)));
}
module.exports = {reminder, nativeCycles, OPEN_CODE_CYCLE};
if (require.main === module) main().catch(() => { process.stdout.write('{}'); });
