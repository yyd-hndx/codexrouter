'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const folders = ['scripts', 'scripts/native-review/tests', 'legacy/tests/bridge', 'tests'];
const files = folders.flatMap(dir => fs.readdirSync(path.join(root, dir)).filter(f => /\.test\.(cjs|mjs)$/.test(f)).map(f => path.join(root, dir, f)));
// A dedicated temporary root keeps test evidence away from personal sessions.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-review-tests-'));
const env = { ...process.env, TEMP: temp, TMP: temp, NODE_OPTIONS: '' };
delete env.OPENCODE_REVIEW_URL;
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { stdio: 'inherit', cwd: root, env, windowsHide: true });
process.exitCode = result.status ?? 1;
if (result.error) console.error(result.error.message);
if (process.exitCode !== 0) console.error('Test artifacts retained at ' + temp);
else {
  if (path.dirname(temp) !== path.resolve(os.tmpdir()) || !path.basename(temp).startsWith('opencode-review-tests-')) throw Error('Unexpected cleanup path.');
  fs.rmSync(temp, { recursive: true, force: true });
}
