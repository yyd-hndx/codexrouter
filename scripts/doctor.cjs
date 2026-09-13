'use strict';
const fs = require('node:fs');
const path = require('node:path');
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
      const runtime = spec.managedDeepseek?.runtime || (spec.args || []).find(arg => /(?:bin[\\/]grok|bin\.js)$/.test(arg)) || spec.args?.[0];
      check(name + ':runtime', typeof runtime === 'string' && fs.existsSync(runtime), 'Install the upstream runtime, then run configure.');
      for (const key of spec.requiredEnv || []) check(name + ':credential:' + key, Boolean(env[key]), 'Value is never printed. Set this variable before a live run.');
      if (name === 'deepseek-harness' && spec.managedDeepseek) {
        try {
          require('./native-review/deepseek-runtime.cjs').deepseekLaunch(spec, path.resolve('deepseek-acp.patch.yml'));
          check(name + ':observer', fs.existsSync(path.join(__dirname, 'native-review/deepseek-events.mjs')), 'Observer path is regenerated from this installation for each cycle.');
        } catch { check(name + ':observer', false, 'Invalid managed DeepSeek launch configuration.'); }
      } else {
        const patchIndex = (spec.args || []).indexOf('--patch');
        if (patchIndex >= 0) {
          const patch = spec.args[patchIndex + 1];
          check(name + ':patch', fs.existsSync(patch || ''), 'Observer patch must exist.');
          if (patch && fs.existsSync(patch)) {
            const text = fs.readFileSync(patch, 'utf8');
            const match = text.match(/name:\s*["']?([^\r\n"']*deepseek-events\.mjs)["']?/);
            if (match) check(name + ':observer', fs.existsSync(match[1].trim()), 'A renamed skill can leave a stale observer path; update this private patch.');
          }
        }
      }
    }
  }
  return { passed: checks.every(c => c.ok), scope: configPath ? 'Local runtime and credential presence; no network/model call.' : 'Development prerequisites only; executor configuration not checked.', checks };
}
if (require.main === module) {
  try { const o = options(process.argv.slice(2), ['config']); const r = inspect(o.config); console.log(JSON.stringify(r, null, 2)); if (!r.passed) process.exitCode = 1; }
  catch { console.error('Doctor could not read the configuration. Check the file and JSON syntax.'); process.exitCode = 1; }
}
module.exports = { inspect };
