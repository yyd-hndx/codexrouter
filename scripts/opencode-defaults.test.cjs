const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const {spawnSync} = require('node:child_process');
const {dispatch} = require('../legacy/outputs/opencode-dispatch.cjs');

function fixture(model, variant) {
  const directory=path.resolve('test-project');
  let cycle={codexThreadId:'owner',sessionId:'session',directory,codeDirectory:directory,
    status:'ready_to_dispatch',round:0,maxRounds:4,deliveryMode:'direct',...(model?{model}:{})};
  let body, posts=0;
  const input={threadId:'owner',sessionId:'session',directory,action:'send',prompt:'Implement the scoped change',...(variant!==undefined?{variant}:{})};
  const deps={lock:()=>()=>{},read:()=>structuredClone(cycle),save:s=>{cycle=structuredClone(s);},
    startListener:async()=>{},wait:async()=>{},api:async(route,state,payload)=>{
      if(payload){body=payload;posts++;return null;}
      if(route==='/session/session')return {directory};
      if(route==='/session/status')return {};
      if(route==='/session/session/message')return body?[{info:{id:'request',role:'user',sessionID:'session'},parts:body.parts}]:[];
      return [];
    }};
  return {run:()=>dispatch(input,deps),body:()=>body,posts:()=>posts};
}
test('default routing sends no model or effort override and binds the request',async()=>{
  const f=fixture();const result=await f.run();assert.equal(result.submitted,true);
  assert.equal(result.submittedMessageId,'request');assert.equal(f.posts(),1);
  assert.equal(Object.hasOwn(f.body(),'model'),false);assert.equal(Object.hasOwn(f.body(),'variant'),false);
});
test('explicit model and effort are passed unchanged',async()=>{
  const model={providerID:'configured-provider',modelID:'configured-model'};
  const f=fixture(model,'high');await f.run();assert.deepEqual(f.body().model,model);assert.equal(f.body().variant,'high');
});
test('partial model and empty effort fail before dispatch',async()=>{
  for(const f of [fixture({modelID:'incomplete'}),fixture(undefined,'')]) {
    await assert.rejects(f.run());assert.equal(f.posts(),0);
  }
});
test('PowerShell PromptFile reaches the dispatcher without an effort override', {skip:process.platform!=='win32'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'codexrouter-prompt-'));
  try {
    fs.mkdirSync(path.join(root,'outputs'));
    fs.mkdirSync(path.join(root,'work','opencode-bridge'),{recursive:true});
    fs.copyFileSync(path.join(__dirname,'../legacy/outputs/opencode-bridge.ps1'),path.join(root,'outputs','opencode-bridge.ps1'));
    fs.writeFileSync(path.join(root,'prompt.txt'),'Scoped prompt from file.');
    fs.writeFileSync(path.join(root,'outputs','opencode-dispatch.cjs'),
      "let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{const x=JSON.parse(raw);if(x.prompt!=='Scoped prompt from file.'||Object.hasOwn(x,'variant'))process.exitCode=1;else console.log('PROMPT_FILE_OK');});");
    const result=spawnSync('pwsh',['-NoProfile','-Command',`
      $ErrorActionPreference = 'Stop'
      $credential = [PSCredential]::new('opencode', (ConvertTo-SecureString 'fixture-only' -AsPlainText -Force))
      $credential | Export-Clixml -LiteralPath (Join-Path $env:CODEX_ROUTER_TEST_ROOT 'work/opencode-bridge/credential.xml')
      & (Join-Path $env:CODEX_ROUTER_TEST_ROOT 'outputs/opencode-bridge.ps1') -Action Send -SessionId fixture -Directory $env:CODEX_ROUTER_TEST_ROOT -PromptFile (Join-Path $env:CODEX_ROUTER_TEST_ROOT 'prompt.txt')
    `],{encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,CODEX_ROUTER_TEST_ROOT:root,CODEX_THREAD_ID:'fixture-owner',OPENCODE_REVIEW_URL:'http://127.0.0.1:4096'}});
    assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PROMPT_FILE_OK/);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
