'use strict';
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  fs.appendFileSync(process.env.MOCK_OWNER_LOG,JSON.stringify(request)+'\n');
  if(request.id===undefined)return;
  const result=request.method==='tools/list'?{tools:[{name:'send_message_to_thread'}]}:
    request.method==='tools/call'?{content:[{type:'text',text:JSON.stringify({threadId:request.params.arguments.threadId})}]}:{};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
