'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const short of [false, true]) test(`Native wait receives atomic updates through a Windows ${short ? 'short' : 'long'} path without crashing`, {
  skip: process.platform !== 'win32',
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-watch-long-directory-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  // GitHub's Windows runner supplies a RUNNER~1 temp path. Keep that alias
  // intact for the regression, and exercise the long path on every Windows host.
  const watchPath = short ? directory : fs.realpathSync.native(directory);
  if (short && !/~\d/.test(watchPath)) return t.skip('The temporary directory does not use an 8.3 alias');

  // Isolate the watcher: a libuv assertion aborts the process, bypassing try/catch.
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const { waitForResult } = require('./scripts/native-review/wait.cjs');
    const { save } = require('./scripts/native-review/state.cjs');
    const cycle = process.argv[1];
    const stateFile = path.join(cycle, 'state.json');
    const state = { owner: 'mock-owner', status: 'running', dispatch: { id: 'one' } };
    save(stateFile, state);
    const pending = waitForResult(cycle, { owner: 'mock-owner', 'dispatch-id': 'one', 'timeout-seconds': 5 });
    setTimeout(() => {
      const responseFile = path.join(cycle, 'response.txt');
      fs.writeFileSync(responseFile, 'Final response');
      save(stateFile, { ...state, status: 'awaiting_review', lastResponseFile: responseFile });
    }, 100);
    pending.then(result => console.log(JSON.stringify(result)), error => {
      console.error(error.message); process.exitCode = 1;
    });
  `, watchPath], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.pending, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.response, 'Final response');
  assert.equal(result.state.dispatch.id, 'one');
});
