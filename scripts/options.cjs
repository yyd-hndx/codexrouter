'use strict';
function options(argv, allowed) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--') || key in result) throw Error('Expected unique --name value options: ' + allowed.join(', '));
    result[key] = argv[i + 1];
  }
  return result;
}
module.exports = { options };
