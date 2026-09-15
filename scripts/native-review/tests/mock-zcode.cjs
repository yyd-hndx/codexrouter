const readline=require('node:readline');
const sessionId='sess_mock_zcode';let route,workspace,turn=0,lastInput,content,stopped=false;
const write=m=>process.stdout.write(JSON.stringify(m)+'\n');
function snapshot(){
  return {protocol:{name:'ZCode Protocol',version:1},session:{sessionId,workspace},
    settings:{model:{current:route?.model},thoughtLevel:{current:route?.thoughtLevel}},
    projection:{turnCount:turn,status:'idle',activeToolCalls:[],pendingPermissions:[],backgroundJobs:[],...(turn?{currentTurnId:'turn_'+turn}:{})},runtime:{pendingRequestIds:[]},
    messages:turn?[
      {info:{role:'user',messageId:'user_'+turn,sessionId},parts:[{type:'text',text:content}]},
      {info:{role:'assistant',messageId:'assistant_'+turn,parentMessageId:'user_'+turn,sessionId,model:route.model,finish:'stop',time:{completed:1}},parts:[{type:'text',text:'Done '+turn}]}]:[]};
}
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.jsonrpc)throw Error('ZCode does not accept jsonrpc');
  const reply=result=>write({id:m.id,result});
  if(!m.method)return;
  if(m.method==='session/create'){route=m.params.runtimeModel;workspace=m.params.workspace;reply(snapshot());return;}
  if(m.method==='session/subscribe'){reply({sessionId,events:[],eventSeq:0});return;}
  if(m.method==='session/read'){reply(snapshot());return;}
  if(m.method==='session/stop'){stopped=true;reply({sessionId});return;}
  if(m.method==='session/close'){reply({sessionId});return;}
  if(m.method==='session/send'){
    lastInput=m.params.inputId;content=m.params.content;turn++;reply({accepted:true,sessionId});
    write({id:'prefs_'+turn,method:'session/requestRuntimePreferences',params:{sessionId}});
    if(content==='hang')return;
    setTimeout(()=>{if(stopped)return;write({method:'session/event',params:{sessionId,eventId:'event_'+turn,turnId:'turn_'+turn,
      type:content==='fail'?'turn.failed':'turn.completed',payload:{inputId:lastInput,resultType:content==='fail'?'error':'success',response:'Done '+turn}}});},25);return;
  }
  write({id:m.id,error:{message:'Unsupported method '+m.method}});
});
