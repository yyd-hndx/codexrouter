'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Rpc } = require('./native-review/rpc.cjs');

function localConfig() {
  const file = process.env.CODEX_OWNER_NOTIFY_CONFIG || path.join(__dirname, 'owner-notify.local.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  if (process.env.CODEX_OWNER_NOTIFY_CONFIG && !fs.existsSync(file)) throw Error('Explicit owner notification config is missing');
  const command = process.env.CODEX_MCP_NODE_PATH || config.node;
  const server = process.env.CODEX_APP_TOOLS_MCP_SERVER || config.server;
  if (!command || !server || !fs.existsSync(command) || !fs.existsSync(server)) throw Error('Codex app tools runtime unavailable; configure CODEX_MCP_NODE_PATH and CODEX_APP_TOOLS_MCP_SERVER or owner-notify.local.json');
  if (!process.env.CODEX_APP_TOOLS_PIPE_PATH) throw Error('Codex app tools pipe is unavailable in this process');
  return {command, server};
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

module.exports = {probeOwnerChannel, submitOwnerMessage};
if (require.main === module) {
  const action = process.argv[2];
  const run = action === 'probe' ? probeOwnerChannel() : Promise.reject(Error('Use probe; delivery is called only by an owned review cycle'));
  run.then(result => console.log(JSON.stringify(result))).catch(error => {console.error(error.message);process.exitCode=1;});
}
