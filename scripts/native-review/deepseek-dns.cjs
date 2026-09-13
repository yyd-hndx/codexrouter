'use strict';

// Opt-in connection address selection. No HTTP request or tool call is replayed.
// Keep system addresses first; VPN/CDN changes can make either source unreachable.
function createDeepSeekLookup(dns, { mode = 'auto', timeoutMs = 2000 } = {}) {
  if (!['auto', 'fresh', 'system'].includes(mode)) throw Error('Invalid DeepSeek DNS mode');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw Error('Invalid DNS timeout');
  return function lookup(hostname, options, callback) {
    if (hostname !== 'api.deepseek.com' || mode === 'system') return dns.lookup(hostname, options, callback);
    const family = typeof options === 'number' ? options : options?.family || 0;
    const bounded = start => new Promise(resolve => {
      let done = false;
      const finish = (error, records = []) => {
        if (done) return;
        done = true; clearTimeout(timer); resolve({ error, records });
      };
      const timer = setTimeout(() => finish(Object.assign(Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), timeoutMs);
      try { start(finish); } catch (error) { finish(error); }
    });
    const queries = [];
    if (mode === 'auto') queries.push(bounded(done => dns.lookup(hostname, { all: true, family }, done)));
    if (family !== 6) queries.push(bounded(done => dns.resolve4(hostname, (e, a) => done(e, (a || []).map(address => ({ address, family: 4 }))))));
    if (family === 6) queries.push(bounded(done => dns.resolve6(hostname, (e, a) => done(e, (a || []).map(address => ({ address, family: 6 }))))));
    Promise.all(queries).then(results => {
      const seen = new Set();
      const addresses = results.flatMap(r => r.error ? [] : r.records).filter(r => {
        const key = `${r.family}:${r.address}`;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      if (!addresses.length) return callback(results.find(r => r.error)?.error || Object.assign(Error('No DeepSeek DNS records'), { code: 'ENOTFOUND' }));
      if (options?.all) return callback(null, addresses);
      callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function installDeepSeekDns({ dns, Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher, mode = 'auto' }) {
  const fallback = getGlobalDispatcher();
  const deepseek = new Agent({ connect: { lookup: createDeepSeekLookup(dns, { mode }), autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500, timeout: 10000 } });
  class DeepSeekDispatcher extends Dispatcher {
    dispatch(options, handler) {
      const origin = new URL(String(options.origin));
      return (origin.origin === 'https://api.deepseek.com' ? deepseek : fallback).dispatch(options, handler);
    }
    close(...args) { return deepseek.close(...args); }
    destroy(...args) { return deepseek.destroy(...args); }
  }
  const dispatcher = new DeepSeekDispatcher();
  setGlobalDispatcher(dispatcher);
  return dispatcher;
}

module.exports = { createDeepSeekLookup, installDeepSeekDns };
