'use strict';
// Attempt all cleanup stages, always release the worker lock, preserve failures.
async function cleanup({ close, notifications, persist, unlock }) {
  const errors=[];
  try {
    for(const action of [close, notifications, persist]) {
      try { await action(); } catch(error) { errors.push(error); }
    }
  } finally {
    try { unlock(); } catch(error) { errors.push(error); }
  }
  if(errors.length)throw new AggregateError(errors,'Worker cleanup incomplete: '+errors.map(e=>e.message).join('; '));
}
module.exports={cleanup};
