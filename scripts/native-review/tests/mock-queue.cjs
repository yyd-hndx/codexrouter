const fs=require('node:fs');
fs.appendFileSync(process.argv[2],JSON.stringify(process.argv.slice(4))+'\n');
console.log(process.argv[3]==='ok'?'Queued message':'unknown acknowledgement');
