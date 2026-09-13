'use strict';
const path = require('node:path');

// Generated configs retain machine-specific runtime/home paths, while bundled
// observer/preload paths are resolved from the currently installed skill.
function deepseekLaunch(spec, patchFile) {
  const managed = spec.managedDeepseek;
  if (managed?.version !== 1 || !path.isAbsolute(managed.runtime || '')) throw Error('Invalid managed DeepSeek runtime');
  const mode = managed.dnsMode || 'system';
  if (!['system', 'auto', 'fresh'].includes(mode)) throw Error('Invalid DeepSeek DNS mode');
  const args = [managed.runtime, '--profile', 'acp', '--patch', patchFile];
  if (mode !== 'system') args.unshift('--require', path.join(__dirname, 'deepseek-network.cjs'));
  const patch = '- id: acp\n  config:\n    provider: ' + JSON.stringify(spec.provider)
    + '\n    model: ' + JSON.stringify(spec.model)
    + '\n- insert:\n  - id: codex-review-events\n    name: '
    + JSON.stringify(path.join(__dirname, 'deepseek-events.mjs').replace(/\\/g, '/')) + '\n';
  return { args, patch, env: { CODEX_ROUTER_DEEPSEEK_DNS: mode } };
}
module.exports = { deepseekLaunch };
