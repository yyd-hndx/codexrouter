'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {main}=require('../scripts/native-review/bridge.cjs');
const notifier=require('../scripts/owner-notify.cjs');
const {save,read}=require('../scripts/native-review/state.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'async process '));
const keys=['CODEX_OWNER_NOTIFY_CONFIG','CODEX_MCP_NODE_PATH','CODEX_APP_TOOLS_MCP_SERVER','CODEX_APP_TOOLS_PIPE_PATH','MOCK_OWNER_LOG'];
async function environment(fn) {
  const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  const log=path.join(root,'mcp.jsonl');
  delete process.env.CODEX_OWNER_NOTIFY_CONFIG;
  Object.assign(process.env,{CODEX_MCP_NODE_PATH:process.execPath,CODEX_APP_TOOLS_MCP_SERVER:path.join(__dirname,'mock-owner-mcp.cjs'),CODEX_APP_TOOLS_PIPE_PATH:'mock-only',MOCK_OWNER_LOG:log});
  try {await fn(log);}finally{for(const k of keys)prior[k]===undefined?delete process.env[k]:process.env[k]=prior[k];}
}
test('Default native init probes without submission; detached worker submits one bound callback',async()=>environment(async log=>{
  const config=path.join(root,'config.json');
  save(config,{version:1,backends:{'deepseek-harness':{command:process.execPath,args:[path.resolve(__dirname,'../scripts/native-review/tests/mock-acp.cjs'),'deepseek-harness'],modelSelector:'mock',provider:'mock',model:'mock',effort:'max'}}});
  const initial=await main({action:'init',config,backend:'deepseek-harness',directory:root,owner:'mock-owner'});
  assert.equal(initial.notify,'async');assert.equal(initial.status,'ready');
  const records=()=>fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records().some(r=>r.method==='tools/call'),false);
  const base={cycle:initial.cycle,owner:'mock-owner'};
  try {
    const dispatch=await main({action:'send',...base,prompt:'Test async delivery'});
    let state;
    for(let i=0;i<200;i++) {
      state=read(path.join(initial.cycle,'state.json'));
      if(state.delivery?.status==='submitted')break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(state.status,'awaiting_review');assert.equal(state.delivery.status,'submitted');
    const calls=records().filter(r=>r.method==='tools/call');assert.equal(calls.length,1);
    assert.equal(calls[0].params.arguments.threadId,'mock-owner');
    assert.ok(calls[0].params.arguments.prompt.includes(dispatch.dispatchId));
    assert.ok(calls[0].params.arguments.prompt.includes(state.responseId));
    assert.deepEqual(Object.keys(calls[0].params.arguments).sort(),['prompt','threadId']);
    assert.equal((await main({action:'reconcile',...base})).proof.ready,true);
  } finally {await main({action:'stop',...base});}
}));
test('Missing explicit callback config is rejected before connecting',async()=>environment(async()=>{
  process.env.CODEX_OWNER_NOTIFY_CONFIG=path.join(root,'absent.json');
  await assert.rejects(notifier.probeOwnerChannel(),/config is missing/);
}));
