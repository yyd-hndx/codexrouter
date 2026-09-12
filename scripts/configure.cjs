'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { options } = require('./options.cjs');
function configure(input) {
  const backend = input.backend;
  if (!['grok-build', 'deepseek-harness'].includes(backend)) throw Error('Choose grok-build or deepseek-harness.');
  for (const key of ['runtime', 'model', 'effort']) if (!input[key]) throw Error('Required: --' + key);
  if (backend === 'deepseek-harness' && !input.provider) throw Error('DeepSeek requires --provider matching the runtime model list.');
  const runtime = fs.realpathSync(path.resolve(input.runtime));
  if (!fs.statSync(runtime).isFile()) throw Error('Runtime must be the upstream JavaScript entry file.');
  const output = path.resolve(input.output || 'config.local.json');
  const directory = path.dirname(output);
  const home = path.resolve(input.home || path.join(directory, '.local', backend));
  const config = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, '')) : { version: 1, backends: {} };
  if (config.version !== 1 || !config.backends || config.backends[backend]) throw Error('Invalid configuration or backend already configured; inspect existing config instead of overwriting.');
  const spec = { command: process.execPath, args: [], env: {}, model: input.model, effort: input.effort };
  let auxiliary, contents;
  if (backend === 'deepseek-harness') {
    spec.provider = input.provider;
    spec.modelSelector = JSON.stringify([input.provider, input.model]);
    auxiliary = path.join(directory, '.local', 'deepseek-acp.patch.yml');
    contents = '- id: acp\n  config:\n    provider: ' + JSON.stringify(input.provider) + '\n    model: ' + JSON.stringify(input.model)
      + '\n- insert:\n  - id: codex-review-events\n    name: ' + JSON.stringify(path.join(__dirname, 'native-review/deepseek-events.mjs').replace(/\\/g, '/')) + '\n';
    spec.args = [runtime, '--profile', 'acp', '--patch', auxiliary];
    spec.env = { DSH_HOME: home };
    spec.requiredEnv = ['DEEPSEEK_API_KEY'];
  } else {
    const base = new URL(input['base-url'] || 'https://api.x.ai/v1');
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw Error('Base URL must be HTTP(S), without embedded credentials.');
    const keyEnv = input['key-env'] || 'XAI_API_KEY';
    const idleSeconds=Number(input['idle-timeout-seconds']??300);
    if(!Number.isInteger(idleSeconds)||idleSeconds<1||idleSeconds>86400)throw Error('Idle timeout must be an integer from 1 to 86400 seconds.');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)) throw Error('Invalid API key environment variable name.');
    spec.modelSelector = 'review-grok';
    auxiliary = path.join(home, 'config.toml');
    contents = '[models]\ndefault = "review-grok"\ndefault_reasoning_effort = ' + JSON.stringify(input.effort)
      + '\nsession_summary = "review-grok"\nweb_search = "review-grok"\n\n[model.review-grok]\nmodel = ' + JSON.stringify(input.model)
      + '\nname = "Review executor"\nbase_url = ' + JSON.stringify(base.href.replace(/\/$/, ''))
      + '\nenv_key = ' + JSON.stringify(keyEnv) + '\napi_backend = "chat_completions"\nsupports_reasoning_effort = true\nreasoning_effort = ' + JSON.stringify(input.effort)
      + '\nmax_retries = 1\ninference_idle_timeout_secs = '+idleSeconds+'\n\n[cli]\nauto_update = false\nuse_leader = false\n\n[marketplace]\ndefault_skills_installs_purged = true\n';
    spec.args = [runtime, 'agent', '--no-leader', '--model', spec.modelSelector, '--reasoning-effort', input.effort, 'stdio'];
    spec.env = { GROK_HOME: home, GROK_MODELS_BASE_URL: base.href.replace(/\/$/, ''), GROK_XAI_API_BASE_URL: base.href.replace(/\/$/, ''), GROK_DISABLE_AUTOUPDATER: '1', GROK_CLAUDE_MCPS_ENABLED: 'false', GROK_CURSOR_MCPS_ENABLED: 'false' };
    spec.requiredEnv = [keyEnv];
  }
  if (fs.existsSync(auxiliary)) throw Error('Generated runtime config already exists; inspect before replacing: ' + auxiliary);
  fs.mkdirSync(path.dirname(auxiliary), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(auxiliary, contents, { flag: 'wx' });
  config.backends[backend] = spec;
  require('./native-review/state.cjs').save(output, config);
  return { backend, config: output, home, note: 'Configuration only. No model request made; keys are read from the environment.' };
}
if (require.main === module) {
  try { console.log(JSON.stringify(configure(options(process.argv.slice(2), ['backend', 'runtime', 'model', 'effort', 'provider', 'home', 'output', 'base-url', 'key-env', 'idle-timeout-seconds'])), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { configure };
