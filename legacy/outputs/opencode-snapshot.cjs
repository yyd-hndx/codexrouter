'use strict';
function isSummary(last) {return last?.info?.summary===true||last?.info?.mode==='compaction';}
function isCompleted(last) {
  return !isSummary(last)&&last?.info?.role==='assistant'&&!last.info.error&&Boolean(last.info.time?.completed)
    &&last.info.finish==='stop'&&!last.parts?.some(p=>p.type==='tool'&&['pending','running'].includes(p.state?.status));
}
function snapshotState({last,status,permissions=[],questions=[]}) {
  if(permissions.length||questions.length)return 'needs_attention';
  if(last?.info?.error)return 'error';
  if(['busy','retry'].includes(status?.type))return status.type;
  if(isSummary(last))return 'compacting';
  if(isCompleted(last))return 'completed';
  return last?.info?.role==='assistant'?'incomplete':'waiting';
}
module.exports={isSummary,isCompleted,snapshotState};
if(require.main===module)(async()=>{
  let raw='';for await(const chunk of process.stdin)raw+=chunk;
  console.log(snapshotState(JSON.parse(raw.replace(/^\uFEFF/,''))));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
