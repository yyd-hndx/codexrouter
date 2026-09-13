'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Rpc } = require('./native-review/rpc.cjs');

function localConfig(env = process.env) {
  const codexHome = path.resolve(env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const privateFile = path.join(codexHome, 'codexRouter', 'owner-notify.json');
  const legacyFile = path.join(__dirname, 'owner-notify.local.json');
  const file = env.CODEX_OWNER_NOTIFY_CONFIG || (fs.existsSync(privateFile) ? privateFile : legacyFile);
  let config = {};
  if (env.CODEX_OWNER_NOTIFY_CONFIG || fs.existsSync(file)) {
    try {
      config = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error();
      for (const key of ['node', 'server']) if (config[key] !== undefined &&
        (typeof config[key] !== 'string' || !config[key].trim())) throw Error();
    } catch { throw Error('Owner notification configuration is missing or invalid'); }
  }
  const resolveConfigPath = value => typeof value === 'string' && value
    ? path.resolve(path.dirname(path.resolve(file)), value) : null;
  const command = env.CODEX_MCP_NODE_PATH || resolveConfigPath(config.node) || process.execPath;
  let server = env.CODEX_APP_TOOLS_MCP_SERVER || resolveConfigPath(config.server);
  if (!server) {
    // Only inspect the known app-tools plugin cache, never scan unrelated files.
    const base = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
    let versions = [];
    try { versions = fs.readdirSync(base, {withFileTypes:true}).filter(entry => entry.isDirectory())
      .map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, {numeric:true})); } catch {}
    server = versions.map(version => path.join(base, version, 'server.mjs')).find(isFile);
  }
  if (!isFile(command) || !isFile(server)) throw Error('Codex app tools runtime unavailable; configure CODEX_MCP_NODE_PATH and CODEX_APP_TOOLS_MCP_SERVER, or CODEX_OWNER_NOTIFY_CONFIG');
  if (!env.CODEX_APP_TOOLS_PIPE_PATH) throw Error('Codex app tools pipe is unavailable in this process');
  return {command, server};
}
function isFile(file) {
  try { return typeof file === 'string' && fs.statSync(file).isFile(); } catch { return false; }
}

async function withAppTools(fn, options = {}) {
  const config = options.config || localConfig();
  const rpc = options.rpc || new Rpc(config.command, [config.server], {env:process.env});
  try {
    await rpc.request('initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'authorized-agent-review-callback',version:'1.0.0'}}, 10000);
    rpc.notify('notifications/initialized', {});
    const catalog = await rpc.request('tools/list', {}, 10000);
    const tool = catalog.tools?.find(item => item.name === 'send_message_to_thread');
    if (!tool) throw Error('Codex app tools do not expose send_message_to_thread');
    return await fn(rpc, tool);
  } finally { await rpc.close(); }
}

async function probeOwnerChannel(options) {
  return withAppTools(async () => ({available:true, transport:'codex-app-tools-mcp', tool:'send_message_to_thread'}), options);
}

async function submitOwnerMessage(threadId, message, eventId, options) {
  if (typeof threadId !== 'string' || !threadId || typeof message !== 'string' || !message || typeof eventId !== 'string' || !eventId) throw Error('Explicit owner, message and event ID required');
  return withAppTools(async rpc => {
    const result = await rpc.request('tools/call', {
      name:'send_message_to_thread', arguments:{threadId,prompt:message},
      _meta:{codexThreadId:threadId,callId:'agent-review-'+eventId},
    }, 30000);
    if (!result || result.isError || !Array.isArray(result.content) || !result.content.length) throw Error('Owner submission acknowledgement missing or rejected');
    const acknowledgedOwner = result.content.some(item => {
      if (item.type !== 'text') return false;
      try { return JSON.parse(item.text).threadId === threadId; } catch { return false; }
    });
    if (!acknowledgedOwner) throw Error('Owner submission acknowledgement has no matching thread ID');
    return {submitted:true, threadId, eventId, transport:'codex-app-tools-mcp', acknowledgement:result};
  }, options);
}

module.exports = {probeOwnerChannel, submitOwnerMessage, localConfig};
if (require.main === module) {
  const action = process.argv[2];
  const run = action === 'probe' ? probeOwnerChannel() : Promise.reject(Error('Use probe; delivery is called only by an owned review cycle'));
  run.then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message);process.exitCode=1;});
}
