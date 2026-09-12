const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const notifier=require('./owner-notify.cjs');
const {notify}=require('./native-review/bridge.cjs');

function mockRpc(result) {
  const calls=[];
  return {calls,closed:false,
    request:async(method,params)=>{calls.push({method,params});
      if(method==='tools/list')return {tools:[{name:'send_message_to_thread'}]};
      if(method==='tools/call')return result;
      return {};
    },
    notify:()=>{},close:async function(){this.closed=true;}
  };
}

test('Owner callback submits one new input with exact owner and no model override',async()=>{
  const rpc=mockRpc({content:[{type:'text',text:'{"threadId":"owner"}'}],isError:false});
  const result=await notifier.submitOwnerMessage('owner','Review this result','event',{rpc,config:{}});
  assert.equal(result.submitted,true);assert.equal(rpc.closed,true);
  const call=rpc.calls.find(c=>c.method==='tools/call');
  assert.deepEqual(call.params.arguments,{threadId:'owner',prompt:'Review this result'});
  assert.equal(call.params._meta.codexThreadId,'owner');
  assert.equal(call.params.name,'send_message_to_thread');
  assert.equal(rpc.calls.filter(c=>c.method==='tools/call').length,1);
});

test('Rejected, missing, or wrong-owner acknowledgements are not successful delivery',async()=>{
  for(const result of [{isError:true,content:[{type:'text',text:'denied'}]}, {content:[]},
    {content:[{type:'text',text:'{"threadId":"other"}'}]}, {content:[{type:'text',text:'ok'}]}]) {
    const rpc=mockRpc(result);
    await assert.rejects(notifier.submitOwnerMessage('owner','Review','event',{rpc,config:{}}));
    assert.equal(rpc.closed,true);
    assert.equal(rpc.calls.filter(c=>c.method==='tools/call').length,1);
  }
});

test('Read-only channel probe never sends a user message',async()=>{
  const rpc=mockRpc({});
  assert.equal((await notifier.probeOwnerChannel({rpc,config:{}})).available,true);
  assert.equal(rpc.calls.some(c=>c.method==='tools/call'),false);
});

test('Native async/default callback submits once and records durable acknowledgement',async()=>{
  const original=notifier.submitOwnerMessage;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-async-notify-'));
  try {
    for(const mode of [undefined,'async']) {
      const state={id:'cycle',dispatch:{id:'dispatch'},owner:'owner',backend:'grok-build',status:'awaiting_review',notify:mode};
      let calls=0;
      notifier.submitOwnerMessage=async(threadId,message,eventId)=>{calls++;assert.match(message,/preserve any other active user task/);return {submitted:true,threadId,eventId,transport:'test'}};
      const file=path.join(root,String(mode)+'.json');
      await notify({},state,file);await notify({},state,file);
      assert.equal(calls,1);assert.equal(state.delivery.status,'submitted');
      assert.equal(JSON.parse(fs.readFileSync(file)).delivery.autoSubmitted,true);
    }
  } finally {notifier.submitOwnerMessage=original;}
});

test('Native lost callback receipt stays uncertain and never retries',async()=>{
  const original=notifier.submitOwnerMessage;
  const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'native-async-uncertain-')),'state.json');
  const state={id:'cycle',dispatch:{id:'dispatch'},owner:'owner',notify:'async',status:'awaiting_review'};
  let calls=0;
  try {
    notifier.submitOwnerMessage=async()=>{calls++;throw Error('receipt lost')};
    await notify({},state,file);await notify({},state,file);
    assert.equal(calls,1);assert.equal(state.delivery.status,'uncertain');
  } finally {notifier.submitOwnerMessage=original;}
});
