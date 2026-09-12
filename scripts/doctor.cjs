'use strict';
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { options } = require('./options.cjs');
function inspect(configPath, env = process.env) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  check('node', Number(process.versions.node.split('.')[0]) >= 24, 'Requires Node.js 24 or newer.');
  check('platform', process.platform === 'win32', 'This release supports Windows; other platforms are not verified.');
  const ps = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8', windowsHide: true });
  check('powershell', ps.status === 0 && Number(ps.stdout.trim()) >= 7, 'Requires PowerShell 7 on PATH.');
  try { require('eventsource-parser'); check('dependencies', true, 'Installed.'); }
  catch { check('dependencies', false, 'Run npm ci --ignore-scripts.'); }
  if (configPath) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    check('config', config.version === 1 && Object.keys(config.backends || {}).length > 0, 'Requires version 1 and at least one backend.');
    for (const [name, spec] of Object.entries(config.backends || {})) {
      check(name + ':routing', ['grok-build', 'deepseek-harness'].includes(name) && spec.model && spec.effort && spec.modelSelector && (name !== 'deepseek-harness' || spec.provider), 'Explicit model/effort and runtime selection required.');
      check(name + ':node', typeof spec.command === 'string' && fs.existsSync(spec.command), 'Configured Node executable must exist.');
      check(name + ':runtime', Array.isArray(spec.args) && fs.existsSync(spec.args[0] || ''), 'Install the upstream runtime, then run configure.');
      for (const key of spec.requiredEnv || []) check(name + ':credential:' + key, Boolean(env[key]), 'Value is never printed. Set this variable before a live run.');
      const patchIndex = (spec.args || []).indexOf('--patch');
      if (patchIndex >= 0) check(name + ':patch', fs.existsSync(spec.args[patchIndex + 1] || ''), 'Generated observer patch must exist.');
    }
  }
  return { passed: checks.every(c => c.ok), scope: configPath ? 'Local runtime and credential presence; no network/model call.' : 'Development prerequisites only; executor configuration not checked.', checks };
}
if (require.main === module) {
  try { const o = options(process.argv.slice(2), ['config']); const r = inspect(o.config); console.log(JSON.stringify(r, null, 2)); if (!r.passed) process.exitCode = 1; }
  catch { console.error('Doctor could not read the configuration. Check the file and JSON syntax.'); process.exitCode = 1; }
}
module.exports = { inspect };
