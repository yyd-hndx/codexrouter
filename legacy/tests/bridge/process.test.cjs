const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { saveJson, readJson } = require('../../outputs/opencode-state.cjs');
const installation = path.resolve(__dirname, '../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (fn()) return; await delay(100); }
  throw Error('Timed out waiting for isolated bridge.');
}

for (const [failBindingWrite, compacted, direct] of [[false, false], [true, false], [false, true], [true, true], [false,true,true]]) test(`PowerShell/Node processes: Unicode, SSE, direct wait, dedupe, recovery, stop (binding write failure=${failBindingWrite}, compacted=${compacted}, direct=${!!direct})`, { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-process-test-with spaces-'));
  const out = path.join(dir, 'outputs'), work = path.join(dir, 'work/opencode-bridge');
  fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(work, { recursive: true });
  for (const file of ['opencode-bridge.ps1', 'opencode-events.ps1', 'opencode-events.cjs',
    'opencode-delivery.cjs', 'opencode-state.cjs', 'opencode-dispatch.cjs', 'opencode-wait.cjs', 'opencode-snapshot.cjs']) {
    fs.copyFileSync(path.join(installation, 'outputs', file), path.join(out, file));
  }
  // Defense in depth: even a broken mock can only execute Node, never Codex queue.
  const wrapperFile = path.join(out, 'opencode-events.ps1');
  fs.writeFileSync(wrapperFile, fs.readFileSync(wrapperFile, 'utf8').replace(
    '(Get-Command codex -ErrorAction Stop).Source', "'" + process.execPath.replace(/'/g, "''") + "'"));
  // Only the parser location is substituted in copied code; production is untouched.
  const eventFile = path.join(out, 'opencode-events.cjs');
  fs.writeFileSync(eventFile, fs.readFileSync(eventFile, 'utf8').replace(
    "require('eventsource-parser')",
    `require(${JSON.stringify(require.resolve('eventsource-parser'))})`));
  const stateFile = path.join(work, 'review-cycle.json'), runtimeFile = path.join(work, 'event-runtime.json');
  const queueFile = path.join(dir, 'mock-queue.jsonl');
  const codeDirectory = path.join(dir, '中文 project'); fs.mkdirSync(codeDirectory);
  saveJson(stateFile, { status: 'ready_to_dispatch', deliveryMode:direct?'direct':'events', model: {providerID: 'test-provider', modelID: 'grok-4.6'}, codexThreadId: 'mock-owner', sessionId: 'mock-session',
    directory: codeDirectory, codeDirectory, round: 0, maxRounds: 3, submittedMessageId: null,
    lastReviewedAssistantMessageId: null, scope: 'isolated mock integration' });
  let messages = [], posts = 0;
  const streams = new Set();
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/global/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n');
      streams.add(res); req.on('close', () => streams.delete(res)); return;
    }
    if (route.endsWith('/prompt_async')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); posts++;
      assert.equal(body.variant, 'xhigh'); assert.equal(body.model.modelID, 'grok-4.6');
      assert.ok(body.parts[0].text.startsWith('检查中文任务 '));
      messages = [{ info: { id: 'mock-user', role: 'user' }, parts: body.parts },
        { info: { id: 'mock-answer', parentID: 'mock-user', role: 'assistant', finish: 'stop',
          time: { completed: Date.now() } }, parts: [{ type: 'text', text: 'done' }] }];
      if (compacted) {
        messages[0].info.sessionID = 'mock-session';
        messages.splice(1, 0,
          { info: { id: 'compact', role: 'user', sessionID: 'mock-session' }, parts: [{ type: 'compaction', auto: true }] },
          { info: { id: 'summary', role: 'assistant', parentID: 'compact', sessionID: 'mock-session',
            summary: true, mode: 'compaction', agent: 'compaction', finish: 'stop', time: { completed: Date.now() } }, parts: [] },
          { info: { id: 'continuation', role: 'user', sessionID: 'mock-session' }, parts: [{ type: 'text', text: 'Continue', synthetic: true, metadata: { compaction_continue: true } }] });
        messages.at(-1).info.parentID = 'continuation';
        messages.at(-1).info.sessionID = 'mock-session';
      }
      res.writeHead(204); res.end();
      setTimeout(() => {
        for (const stream of streams) {
          stream.write('data: ' + JSON.stringify({ type: 'session.idle', properties: { sessionID: 'mock-session' } }) + '\n\n');
          stream.write('data: ' + JSON.stringify({ type: 'session.status', properties: { sessionID: 'mock-session', status: { type: 'idle' } } }) + '\n\n');
        }
      }, 100);
      return;
    }
    const data = route.endsWith('/message') ? messages : route === '/session/mock-session'
      ? { directory: codeDirectory } : route === '/session/status' ? {} : [];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const mockUrl = 'http://127.0.0.1:' + server.address().port;
  const preload = path.join(dir, 'mock-preload.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const cp = require('node:child_process');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (process.env.GROK_TEST_FAIL_BINDING === '1' && process.argv[1]?.endsWith('opencode-dispatch.cjs')
    && to.endsWith('review-cycle.json') && JSON.parse(fs.readFileSync(from, 'utf8')).status === 'waiting_for_grok') {
    throw Object.assign(Error('simulated binding write failure'), { code: 'EACCES' });
  }
  return rename(from, to);
};
const { promisify } = require('node:util');
const original = cp.execFile;
const originalExec = promisify(original);
cp.execFile = (...args) => original(...args);
cp.execFile[promisify.custom] = async (file, args, options) => {
  if (args[0] === 'queue') {
    fs.appendFileSync(${JSON.stringify(queueFile)}, JSON.stringify(args) + '\\n');
    return { stdout: 'Queued message mock-event for thread mock-owner.', stderr: '' };
  }
  return originalExec(file, args, options);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const base = process.env.OPENCODE_REVIEW_URL || 'http://127.0.0.1:4096';
  if (!String(url).startsWith(base + '/')) throw Error('Unexpected network target in test');
  return originalFetch(String(url).replace(base, ${JSON.stringify(mockUrl)}), options);
};
`);
  const credentialScript = path.join(dir, 'credential.ps1');
  fs.writeFileSync(credentialScript, "param([string]$Target)\n[PSCredential]::new('opencode', (ConvertTo-SecureString 'isolated-test-only' -AsPlainText -Force)) | Export-Clixml -LiteralPath $Target\n");
  const env = { ...process.env, CODEX_THREAD_ID: 'mock-owner', GROK_TEST_FAIL_BINDING: failBindingWrite ? '1' : '0',
    NODE_OPTIONS: `--require="${preload.replace(/\\/g, '/')}"` };
  if (direct) env.OPENCODE_REVIEW_URL = 'http://127.0.0.1:4097';
  const pwsh = process.env.OPENCODE_TEST_PWSH || 'pwsh.exe';
  let failure;
  try {
    await execFile(pwsh, ['-NoProfile', '-File', credentialScript, path.join(work, 'credential.xml')], { windowsHide: true });
    const sending = execFile(pwsh, ['-NoProfile', '-File', path.join(out, 'opencode-bridge.ps1'),
      '-Action', 'Send', '-SessionId', 'mock-session', '-Directory', codeDirectory, '-Variant', 'xhigh',
      '-Prompt', '检查中文任务 E:/任务.md'], { env, windowsHide: true, timeout: 25000 });
    if (failBindingWrite) await assert.rejects(sending, /simulated binding write failure/);
    else assert.equal(JSON.parse((await sending).stdout.trim()).submittedMessageId, 'mock-user');
    await until(() => direct ? readJson(path.join(work,'event-delivery.json'),{}).lastNotice : fs.existsSync(queueFile));
    await delay(600);
    assert.equal(posts, 1);
    if(direct)assert.equal(fs.existsSync(queueFile),false);
    else assert.equal(fs.readFileSync(queueFile, 'utf8').trim().split('\n').length, 1);
    assert.equal(readJson(stateFile).status, failBindingWrite ? 'dispatching' : 'waiting_for_grok');
    if (failBindingWrite) assert.match(fs.readFileSync(queueFile, 'utf8'), /binding_mismatch/);
    else if(!direct)assert.match(fs.readFileSync(queueFile, 'utf8'), /OPENCODE_EVENT completed/);
    const status = await execFile(pwsh, ['-NoProfile', '-File', path.join(out, 'opencode-events.ps1'), '-Action', 'Status'], { env, windowsHide: true });
    assert.equal(JSON.parse(status.stdout).status, 'connected');
    env.GROK_TEST_FAIL_BINDING = '0';
    const reconcile = await execFile(pwsh, ['-NoProfile', '-File', path.join(out, 'opencode-bridge.ps1'),
      '-Action', 'Reconcile', '-SessionId', 'mock-session', '-Directory', codeDirectory], { env, windowsHide: true });
    assert.equal(JSON.parse(reconcile.stdout).reconciled, true); assert.equal(posts, 1);
    assert.equal(readJson(stateFile).status, 'waiting_for_grok');
    assert.equal(readJson(stateFile).round, 1);
    assert.equal(readJson(stateFile).submittedMessageId, 'mock-user');
    if (compacted) assert.equal(readJson(stateFile).requestBinding.effectiveRequestId, 'continuation');
    const received=await execFile(pwsh,['-NoProfile','-File',path.join(out,'opencode-bridge.ps1'),'-Action','Wait','-SessionId','mock-session','-Directory',codeDirectory,'-DispatchId',readJson(stateFile).dispatch.id,'-TimeoutSeconds','5'],{env,windowsHide:true});
    const directResult=JSON.parse(received.stdout);assert.equal(directResult.completed,true);assert.equal(directResult.response,'done');assert.equal(directResult.requestBinding.originalRequestId,'mock-user');
    await delay(300);
    if(direct)assert.equal(fs.existsSync(queueFile),false);
    else assert.equal(fs.readFileSync(queueFile, 'utf8').trim().split('\n').length, 1);
    if(direct&&compacted) {
      const completeMessages=messages;
      messages=messages.slice(0,messages.findIndex(m=>m.info.summary===true)+1);
      // Snapshot uses PowerShell HTTP, which does not pass through the Node fetch mock.
      const snapshot=await execFile(pwsh,['-NoProfile','-File',path.join(out,'opencode-bridge.ps1'),'-Action','Snapshot','-SessionId','mock-session','-Directory',codeDirectory],{env:{...env,OPENCODE_REVIEW_URL:mockUrl},windowsHide:true});
      assert.equal(JSON.parse(snapshot.stdout).state,'compacting');
      messages=completeMessages;
    }
  } catch (error) {
    failure = error;
    for (const file of ['events.stdout.log', 'events.stderr.log']) {
      if (fs.existsSync(path.join(work, file))) error.message += '\n' + file + ': ' + fs.readFileSync(path.join(work, file), 'utf8');
    }
  } finally {
    saveJson(stateFile, { ...readJson(stateFile), status: 'complete' });
    try { await until(() => !fs.existsSync(path.join(work, 'listener.lock')), 10000); }
    catch (error) {
      failure ||= error;
      // Only this isolated test's recorded child may be stopped for cleanup.
      if (fs.existsSync(runtimeFile)) { try { process.kill(readJson(runtimeFile).pid); } catch {} }
      await delay(300);
    }
    for (const stream of streams) stream.end();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    // Node path operations remain in one runtime; verify before recursive cleanup.
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'grok-process-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failure) throw failure;
});
