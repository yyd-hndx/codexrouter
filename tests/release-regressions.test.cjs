'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync,execFileSync}=require('node:child_process');
const {snapshotState,isCompleted}=require('../legacy/outputs/opencode-snapshot.cjs');
const {configure}=require('../scripts/configure.cjs');
const root=path.resolve(__dirname,'..');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'release-regressions-'));
test('Snapshot and notice completion predicate reject summaries, unfinished tools and busy sessions',()=>{
 const last={info:{role:'assistant',finish:'stop',time:{completed:1}},parts:[]};
 assert.equal(snapshotState({last}),'completed');
 for(const extra of [{summary:true},{mode:'compaction'}]) {
  const summary={...last,info:{...last.info,...extra}};
  assert.equal(snapshotState({last:summary}),'compacting');assert.equal(isCompleted(summary),false);
 }
 assert.equal(snapshotState({last,status:{type:'busy'}}),'busy');
 assert.equal(snapshotState({last,permissions:[{id:'p'}]}),'needs_attention');
 assert.equal(isCompleted({...last,parts:[{type:'tool',state:{status:'running'}}]}),false);
});
test('PowerShell Send without an explicit variant fails before reading credentials or sending',()=>{
 const r=spawnSync('pwsh',['-NoProfile','-File',path.join(root,'legacy/outputs/opencode-bridge.ps1'),'-Action','Send','-SessionId','fake','-Prompt','task'],{encoding:'utf8',windowsHide:true});
 assert.notEqual(r.status,0);assert.match(r.stderr,/requires an explicit -Variant/);
});
test('Initializer records title and never overwrites a prior cycle',()=>{
 const directory=path.join(scratch,'init');fs.mkdirSync(directory);
 for(const name of ['scripts/init-opencode.cjs','scripts/options.cjs','legacy/outputs/opencode-state.cjs']) {
  const dest=path.join(directory,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,name),dest);
 }
 const task=path.join(directory,'task.md');fs.writeFileSync(task,'sample');
 const args=[path.join(directory,'scripts/init-opencode.cjs'),'--directory',directory,'--session','s','--owner','test','--provider','p','--model','m','--task',task,'--scope','test','--title','Selected title'];
 const env={...process.env,CODEX_THREAD_ID:'test'};
 execFileSync(process.execPath,args,{env,windowsHide:true});
 const file=path.join(directory,'legacy/work/opencode-bridge/review-cycle.json'),before=fs.readFileSync(file,'utf8');
 assert.equal(JSON.parse(before).sessionTitle,'Selected title');
 assert.equal(JSON.parse(before).deliveryMode,'async');
 assert.notEqual(spawnSync(process.execPath,args,{env,windowsHide:true}).status,0);assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('Grok idle timeout is configurable and rejects invalid bounds before writing config',()=>{
 for(const [name,value,expected] of [['default',undefined,300],['custom','600',600]]) {
  const dir=path.join(scratch,name);fs.mkdirSync(dir);const runtime=path.join(dir,'runtime.cjs');fs.writeFileSync(runtime,'');
  const r=configure({backend:'grok-build',runtime,model:'model',effort:'xhigh',output:path.join(dir,'config.local.json'),...(value?{'idle-timeout-seconds':value}:{})});
  assert.match(fs.readFileSync(path.join(r.home,'config.toml'),'utf8'),new RegExp('inference_idle_timeout_secs = '+expected));
 }
 const bad=path.join(scratch,'bad.json');
 assert.throws(()=>configure({backend:'grok-build',runtime:__filename,model:'model',effort:'xhigh',output:bad,'idle-timeout-seconds':'0'}),/Idle timeout/);assert.equal(fs.existsSync(bad),false);
});
test('Queued workflow target ships with the skill and resolves its local references',()=>{
 const file=path.join(root,'legacy/outputs/opencode-review-workflow.md');assert.equal(fs.existsSync(file),true);
 for(const m of fs.readFileSync(file,'utf8').matchAll(/\]\(([^)]+)\)/g))assert.equal(fs.existsSync(path.resolve(path.dirname(file),m[1])),true);
});
test('Release scan includes tracked ignored files and excludes ignored untracked runtime data',()=>{
 const dir=path.join(scratch,'git-scan');fs.mkdirSync(path.join(dir,'scripts'),{recursive:true});
 fs.copyFileSync(path.join(root,'scripts/check-release.cjs'),path.join(dir,'scripts/check-release.cjs'));
 fs.writeFileSync(path.join(dir,'.gitignore'),'.env\n');fs.writeFileSync(path.join(dir,'.env'),'TEST_ONLY=value\n');
 const git=(...args)=>execFileSync('git',args,{cwd:dir,windowsHide:true,stdio:'pipe'});git('init','--quiet');
 const scan=()=>JSON.parse(spawnSync(process.execPath,[path.join(dir,'scripts/check-release.cjs')],{encoding:'utf8',windowsHide:true}).stdout);
 assert.equal(scan().passed,true);git('add','-f','.env');const r=scan();assert.equal(r.passed,false);assert.equal(r.problems[0].file,'.env');
});
