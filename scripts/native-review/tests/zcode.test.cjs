const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {DatabaseSync}=require('node:sqlite');
const {main}=require('../bridge.cjs');
const zcode=require('../zcode.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'zcode-bridge-test-'));
const home=path.join(root,'home');fs.mkdirSync(path.join(home,'v2'),{recursive:true});
const provider={kind:'openai-compatible',options:{baseURL:'http://localhost',apiKey:'fixture-only'},models:{first:{reasoning:{enabled:true,variants:['low','max'],defaultVariant:'max'}},second:{}}};
fs.writeFileSync(path.join(home,'v2','config.json'),JSON.stringify({provider:{configured:provider}}));
const db=new DatabaseSync(path.join(home,'v2','tasks-index.sqlite'));
db.exec('CREATE TABLE tasks (model TEXT,workspace_path TEXT,meta_json TEXT,deleted INTEGER,archived INTEGER,provider TEXT,updated_at INTEGER)');
db.prepare('INSERT INTO tasks VALUES (?,?,?,0,0,?,1)').run('configured/first',root,JSON.stringify({thoughtLevel:'max'}),'glm');db.close();
const spec={command:process.execPath,args:[path.join(__dirname,'mock-zcode.cjs')],zcodeHome:home};
const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({version:1,backends:{zcode:spec}}));
const owner=process.env.CODEX_THREAD_ID||'owner';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function done(cycle){
  for(let i=0;i<150;i++){const s=JSON.parse(fs.readFileSync(path.join(cycle,'state.json')));if(s.status!=='running'&&s.status!=='dispatching')return s;await pause(50);}
  throw Error('Mock did not settle');
}
async function exited(cycle){for(let i=0;i<100&&fs.existsSync(path.join(cycle,'worker.lock'));i++)await pause(50);assert.equal(fs.existsSync(path.join(cycle,'worker.lock')),false);}
test('desktop selection is inherited, explicit override wins, secrets are redacted',()=>{
  const r=zcode.resolveRoute(spec,root);assert.equal(r.selectionSource,'desktop-project-task');assert.equal(r.model,'first');assert.equal(r.effort,'max');
  assert.equal(zcode.resolveRoute({...spec,provider:'configured',model:'second'},root).model,'second');
  assert.throws(()=>zcode.resolveRoute({...spec,effort:'unsupported'},root));
  assert.equal(JSON.stringify(zcode.redact(r.runtimeModel)).includes('fixture-only'),false);
});
test('allow-once is session bound and rejects duplicate permission requests',()=>{
  const s={sessionId:'s',permission:'allow_once'},a={id:'dispatch'};
  const m={id:'p',method:'interaction/requestPermission',params:{sessionId:'s',options:[{optionId:'once',kind:'allow_once',response:{decision:'allow'}}]}};
  assert.equal(zcode.reply(m,a,s).result.decision,'allow');assert.equal(zcode.reply(m,a,s).result.decision,'deny');
  assert.equal(zcode.reply({...m,id:'q',params:{...m.params,sessionId:'foreign'}},a,s).result.decision,'deny');
});
test('bridge dispatch, response binding, same-session repair and cap',async()=>{
  const directory=path.join(root,'repair');fs.mkdirSync(directory);
  const init=await main({action:'init',config,backend:'zcode',directory,owner,notify:'manual','max-rounds':'2'});
  const cycle=init.cycle;assert.equal(init.status,'ready');
  try {
    await assert.rejects(main({action:'send',cycle,owner:'foreign',prompt:'task'}),/owner/i);
    await main({action:'send',cycle,owner,prompt:'task'});let state=await done(cycle);assert.equal(state.status,'awaiting_review');
    const proof=await main({action:'reconcile',cycle,owner});assert.equal(proof.proof.ready,true,JSON.stringify(proof.proof));
    const records=fs.readFileSync(path.join(cycle,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    for(const mutate of [
      entries=>{entries.find(e=>e.message.method==='zcode/settled').message.params.snapshot.messages.at(-1).info.parentMessageId='foreign';},
      entries=>{entries.find(e=>e.message.method==='zcode/settled').message.params.snapshot.projection.activeToolCalls.push({id:'pending'});},
      entries=>{entries.find(e=>e.message.params?.type==='turn.completed').message.params.payload.inputId='foreign';},
      entries=>{entries.find(e=>e.message.method==='zcode/settled').message.params.snapshot.settings.model.current.modelId='fallback';},
    ]) {const changed=structuredClone(records);mutate(changed);assert.equal(zcode.evidence(state,changed).ready,false);}
    const report=path.join(directory,'review.md');fs.writeFileSync(report,'Changes requested after independent verification.');
    await assert.rejects(main({action:'review',cycle,owner,'response-id':'stale',report,outcome:'complete'}),/match/);
    await main({action:'review',cycle,owner,'response-id':state.responseId,report,outcome:'changes_requested'});
    const repair=await main({action:'send',cycle,owner,prompt:'repair'});assert.equal(repair.sessionId,init.sessionId);
    state=await done(cycle);assert.equal(state.status,'awaiting_review');assert.equal(state.round,2);
    await main({action:'review',cycle,owner,'response-id':state.responseId,report,outcome:'changes_requested'});
    await exited(cycle);state=JSON.parse(fs.readFileSync(path.join(cycle,'state.json')));assert.equal(state.status,'paused_round_limit');assert.equal(state.runtimeExited,true);
    await assert.rejects(main({action:'send',cycle,owner,prompt:'extra'}));
  }finally{if(fs.existsSync(path.join(cycle,'worker.lock')))await main({action:'stop',cycle,owner});}
});
test('provider failure is not reviewable and stop terminates a hanging turn',async()=>{
  for(const prompt of ['fail','hang']){
    const directory=path.join(root,prompt);fs.mkdirSync(directory);
    const init=await main({action:'init',config,backend:'zcode',directory,owner,notify:'manual'});const cycle=init.cycle;
    try{
      await main({action:'send',cycle,owner,prompt});
      if(prompt==='fail'){const s=await done(cycle);assert.equal(s.status,'paused_attention');assert.equal(s.responseId,null);}
      await main({action:'stop',cycle,owner});await exited(cycle);
      const s=JSON.parse(fs.readFileSync(path.join(cycle,'state.json')));assert.equal(s.status,'paused_stopped');assert.equal(s.runtimeExited,true);
    }finally{if(fs.existsSync(path.join(cycle,'worker.lock')))await main({action:'stop',cycle,owner});}
  }
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
