'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configure } = require('../scripts/configure.cjs');
const { issuesFor } = require('../scripts/check-release.cjs');
const { dispatch } = require('../legacy/outputs/opencode-dispatch.cjs');
const { inspect } = require('../scripts/doctor.cjs');
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-config-'));
  const runtime = path.join(dir, 'runtime entry.cjs'); fs.writeFileSync(runtime, '');
  return { dir, runtime, output: path.join(dir, 'config.local.json') };
};
test('Generated DeepSeek config supports spaces, preserves exact routing and loads bundled observer', () => {
  const f = fixture();
  configure({ ...f, backend: 'deepseek-harness', provider: 'custom-provider', model: 'custom-model', effort: 'max' });
  const config = JSON.parse(fs.readFileSync(f.output)); const spec = config.backends['deepseek-harness'];
  assert.equal(spec.command, process.execPath); assert.equal(spec.args[0], f.runtime);
  assert.equal(spec.modelSelector, '["custom-provider","custom-model"]');
  assert.match(fs.readFileSync(spec.args.at(-1), 'utf8'), /deepseek-events\.mjs/);
  assert.deepEqual(spec.requiredEnv, ['DEEPSEEK_API_KEY']);
});
test('Adding a second backend preserves the first; reconfiguration refuses overwrite', () => {
  const f = fixture();
  configure({ ...f, backend: 'deepseek-harness', provider: 'test', model: 'flash', effort: 'max' });
  const before = JSON.parse(fs.readFileSync(f.output)).backends['deepseek-harness'];
  configure({ ...f, backend: 'grok-build', model: 'grok-test', effort: 'xhigh', 'base-url': 'https://example.com/v1', 'key-env': 'CUSTOM_KEY' });
  const config = JSON.parse(fs.readFileSync(f.output)); assert.deepEqual(config.backends['deepseek-harness'], before);
  assert.deepEqual(config.backends['grok-build'].requiredEnv, ['CUSTOM_KEY']);
  const saved = fs.readFileSync(f.output, 'utf8');
  assert.throws(() => configure({ ...f, backend: 'grok-build', model: 'other', effort: 'low' }), /already configured/);
  assert.equal(fs.readFileSync(f.output, 'utf8'), saved);
});
test('Invalid options and embedded URL credentials fail before writing config', () => {
  const f = fixture();
  assert.throws(() => configure({ ...f, backend: 'unknown', model: 'x', effort: 'x' }));
  assert.throws(() => configure({ ...f, backend: 'grok-build', model: 'x', effort: 'x', 'base-url': 'https://user:secret@example.com' }));
  assert.equal(fs.existsSync(f.output), false);
});
test('Release scan detects generated state, private paths and likely secrets without exposing values', () => {
  assert.ok(issuesFor('config.local.json', '{}').length);
  const personal = ['C:', 'Users', 'someone', 'Documents'].join('/');
  assert.ok(issuesFor('README.md', personal).length);
  const secret = 'sk-' + 'a'.repeat(36);
  assert.ok(issuesFor('example.json', secret).length);
  assert.deepEqual(issuesFor('example.json', '{"keyEnv":"DEEPSEEK_API_KEY"}'), []);
});
test('Legacy Send uses the configured provider/model/variant and refuses absent routing', async () => {
  let state = { codexThreadId: 'owner', sessionId: 'session', directory: 'E:/project', codeDirectory: 'E:/project', status: 'ready_to_dispatch', round: 0, maxRounds: 3, model: {providerID: 'different-provider', modelID: 'different-model'} };
  let messages = [], posted;
  const deps = { lock: () => () => {}, read: () => structuredClone(state), save: s => state = structuredClone(s), startListener: async () => {}, wait: async () => {}, api: async (route, s, body) => {
    if (body) { posted = body; messages = [{info: {id: 'user', role: 'user'}, parts: body.parts}]; return; }
    return route.endsWith('/message') ? messages : route === '/session/session' ? {directory:'E:/project'} : route === '/session/status' ? {} : [];
  }};
  const input = {action:'send',threadId:'owner',sessionId:'session',directory:'E:/project',prompt:'task',variant:'high'};
  await dispatch(input, deps);
  assert.deepEqual(posted.model, {providerID:'different-provider',modelID:'different-model'}); assert.equal(posted.variant, 'high');
  state = {...state, status:'ready_to_dispatch', model:null}; posted = null;
  await assert.rejects(dispatch(input, deps), /Configure cycle.model/); assert.equal(posted, null);
});
test('Doctor identifies missing runtime and missing credentials without disclosing supplied values', () => {
  const f = fixture();
  configure({ ...f, backend: 'deepseek-harness', provider: 'test', model: 'flash', effort: 'max' });
  const missing = inspect(f.output, {});
  assert.equal(missing.checks.find(c => c.name.endsWith(':credential:DEEPSEEK_API_KEY')).ok, false);
  const key = 'private-test-value';
  const present = inspect(f.output, {DEEPSEEK_API_KEY:key});
  assert.equal(present.checks.find(c => c.name.endsWith(':credential:DEEPSEEK_API_KEY')).ok, true);
  assert.equal(JSON.stringify(present).includes(key), false);
  fs.unlinkSync(f.runtime);
  assert.equal(inspect(f.output, {}).checks.find(c => c.name.endsWith(':runtime')).ok, false);
});
test('Routing changes during legacy preflight prevent any external submission', async () => {
  let state = { codexThreadId:'owner',sessionId:'s',directory:'E:/project',codeDirectory:'E:/project',status:'ready_to_dispatch',round:0,maxRounds:3,model:{providerID:'p',modelID:'m'} };
  let posts = 0;
  const deps = {lock:()=>()=>{},read:()=>structuredClone(state),save:s=>state=s,startListener:async()=>{},wait:async()=>{},api:async(route,s,body)=>{
    if(body)posts++;
    if(route==='/session/s'){state.model.modelID='switched';return {directory:'E:/project'};}
    return route==='/session/status'?{}:[];
  }};
  await assert.rejects(dispatch({action:'send',threadId:'owner',sessionId:'s',directory:'E:/project',prompt:'task',variant:'high'},deps),/changed during preflight/);
  assert.equal(posts,0);
});
