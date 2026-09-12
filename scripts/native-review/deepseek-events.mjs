// Observer only: expose original session identities and terminal facts over the
// ACP stdio channel. Never changes prompts, tools, permissions, or model output.
export const inject = ['session'];
export default function apply(ctx) {
  ctx.on('session/created', session => {
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'review.session',params:{sessionId:String(session.id),header:session.header,eventCount:session.seq}})+'\n');
  });
  ctx.on('session/event', (session, event) => {
    const selected = new Set(['session/header', 'user/message', 'turn/start', 'turn/end', 'tool/call', 'tool/result', 'assistant/message', 'agent/inbox/spliced', 'compaction/start', 'compaction/summary', 'compaction/end']);
    if (!selected.has(event.type)) return;
    let data = event.data;
    const invalid = () => process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'review.event',params:{sessionId:String(session.id),event:{type:'protocol/error',seq:event.seq,time:event.time,data:{sourceType:event.type}}}})+'\n');
    if(!data || typeof data!=='object')return invalid();
    if(event.type==='assistant/message' && (!data.message || typeof data.message.id!=='string'
      || typeof data.message.source?.provider!=='string' || typeof data.message.source?.model!=='string'
      || !Array.isArray(data.message.content) || data.message.content.some(p=>!p || (p.type==='text' && typeof p.text!=='string'))))return invalid();
    if(event.type==='tool/result' && (!Array.isArray(data.message?.content)
      || typeof data.message.content[0]?.toolCallId!=='string'))return invalid();
    if(event.type==='tool/call' && typeof data.callId!=='string')return invalid();
    // Only lifecycle/progress facts cross the bridge; the private summary is not needed.
    if (event.type.startsWith('compaction/')) data = {compactionId:data.compactionId,turn:data.turn,error:!!data.error};
    if (event.type === 'assistant/message') data = { turn: data.turn, step: data.step, id: data.message.id, source: {provider:data.message.source.provider,model:data.message.source.model}, interrupted: data.interrupted, text: data.message.content.filter(p => p.type === 'text').map(p => p.text).join('') };
    if (event.type === 'tool/call') data = { callId: data.callId, name: data.name };
    if (event.type === 'tool/result') data = { message: { toolCallId: data.message.content[0].toolCallId }, error: data.error };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'review.event', params: { sessionId: String(session.id), event: { type: event.type, seq: event.seq, time: event.time, data } } }) + '\n');
  });
}
