'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { options } = require('./options.cjs');
function configure(input) {
  const backend = input.backend;
  if (backend==='zcode') {
    if(!input.runtime)throw Error('ZCode requires --runtime pointing to its installed resources/glm/zcode.cjs');
    const output=path.resolve(input.output||'config.local.json');
    const config=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{version:1,backends:{}};
    if(config.version!==1||!config.backends||config.backends.zcode)throw Error('Invalid configuration or ZCode already configured');
    if(Boolean(input.provider)!==Boolean(input.model))throw Error('Use both --provider and --model, or omit both');
    const runtime=fs.realpathSync(input.runtime),command=fs.realpathSync(input.executable||process.execPath);
    if(!fs.statSync(runtime).isFile()||!fs.statSync(command).isFile())throw Error('Runtime and executable must be files');
    config.backends.zcode={command,args:[runtime,'app-server','--stdio','--surface','desktop'],
      env:/zcode\.exe$/i.test(command)?{ELECTRON_RUN_AS_NODE:'1'}:{},
      ...(input.home?{zcodeHome:path.resolve(input.home)}:{}),
      ...(input.model?{provider:input.provider,model:input.model}:{}),...(input.effort?{effort:input.effort}:{})};
    require('./native-review/state.cjs').save(output,config);
    return {backend,config:output,note:'Reuses desktop configuration; no credential copied and no model request made.'};
  }
  if (!['grok-build', 'deepseek-harness'].includes(backend)) throw Error('Choose grok-build, deepseek-harness or zcode.');
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
    spec.managedDeepseek = { version: 1, runtime, dnsMode: input['dns-mode'] || 'system' };
    const launch = require('./native-review/deepseek-runtime.cjs').deepseekLaunch(spec, auxiliary);
    contents = launch.patch;
    spec.args = launch.args;
    spec.env = { DSH_HOME: home, ...launch.env };
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
  try { console.log(JSON.stringify(configure(options(process.argv.slice(2), ['backend', 'runtime', 'executable', 'model', 'effort', 'provider', 'home', 'output', 'base-url', 'key-env', 'idle-timeout-seconds', 'dns-mode'])), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { configure };
