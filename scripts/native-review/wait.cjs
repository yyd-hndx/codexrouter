'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { read, assertOwner } = require('./state.cjs');

// Observe only this dispatch. This command neither sends messages nor changes state.
async function waitForResult(cycle, options) {
  const stateFile = path.join(cycle, 'state.json');
  const owner = options.owner || process.env.CODEX_THREAD_ID;
  const initial = read(stateFile);
  assertOwner(initial, owner);
  const dispatchId = options['dispatch-id'] || initial.dispatch?.id;
  if (!dispatchId || initial.dispatch?.id !== dispatchId) throw Error('Wait requires the matching dispatch id');
  const timeoutSeconds = Number(options['timeout-seconds'] ?? 45);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 60) throw Error('Wait timeout must be between 0 and 60 seconds');

  return new Promise((resolve, reject) => {
    let watcher, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const inspect = (deadline = false) => {
      try {
        const state = read(stateFile);
        assertOwner(state, owner);
        if (state.dispatch?.id !== dispatchId) throw Error('Dispatch changed while waiting; inspect the new run separately');
        const pending = ['dispatching', 'running', 'stopping'].includes(state.status);
        const needsAttention = !!state.problem || !!state.workerExitedAt;
        if (pending && !needsAttention && !deadline) return;
        const result = { pending, timedOut: pending && deadline && !needsAttention, state };
        if (!pending && state.lastResponseFile) {
          const responseFile = path.resolve(state.lastResponseFile);
          const relative = path.relative(cycle, responseFile);
          if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw Error('Response file is outside the owned cycle');
          result.response = fs.readFileSync(responseFile, 'utf8');
        }
        finish(null, result);
      } catch (error) { finish(error); }
    };
    // Watch the directory because state is persisted by an atomic rename.
    try {
      watcher = fs.watch(cycle, (_event, name) => {
        if (name === null || String(name) === 'state.json') inspect();
      });
      watcher.on('error', error => finish(error));
      timer = setTimeout(() => inspect(true), timeoutSeconds * 1000);
      inspect();
    } catch (error) { finish(error); }
  });
}

module.exports = { waitForResult };
