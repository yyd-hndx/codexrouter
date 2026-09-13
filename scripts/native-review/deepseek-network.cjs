'use strict';
const path = require('node:path');
const dns = require('node:dns');
const { createRequire } = require('node:module');
const { installDeepSeekDns } = require('./deepseek-dns.cjs');

// Opt-in preload: node --require <this file> <installed DSH entry> ...
// Resolve undici from the selected runtime rather than a machine-specific folder.
if (!process.argv[1]) throw Error('DeepSeek DNS preload requires a runtime entrypoint');
const runtimeRequire = createRequire(path.resolve(process.argv[1]));
installDeepSeekDns({ dns, ...runtimeRequire('undici'), mode: process.env.CODEX_ROUTER_DEEPSEEK_DNS || 'auto' });
