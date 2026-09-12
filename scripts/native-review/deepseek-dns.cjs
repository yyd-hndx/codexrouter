'use strict';

// Windows getaddrinfo retained unreachable CDN A records in this installation.
// Query the configured DNS resolver for each new DeepSeek connection instead.
// No fixed IP, endpoint substitution, credential access, or TLS override.
function createDeepSeekLookup(dns) {
  return function lookup(hostname, options, callback) {
    if (hostname !== 'api.deepseek.com') return dns.lookup(hostname, options, callback);
    dns.resolve4(hostname, (error, addresses) => {
      if (error) return callback(error);
      if (!addresses.length) return callback(Object.assign(new Error('No IPv4 records for DeepSeek'), { code: 'ENOTFOUND' }));
      if (options?.all) return callback(null, addresses.map(address => ({ address, family: 4 })));
      callback(null, addresses[0], 4);
    });
  };
}

function installDeepSeekDns({ dns, Agent, Dispatcher, getGlobalDispatcher, setGlobalDispatcher }) {
  const fallback = getGlobalDispatcher();
  const deepseek = new Agent({ connect: { lookup: createDeepSeekLookup(dns), autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 500 } });
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
