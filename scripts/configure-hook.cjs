'use strict';
// Print registration only. Installing/trusting a host hook requires user approval.
const path = require('node:path');
function registration(script = path.join(__dirname, 'resume-review.cjs')) {
  const absolute = path.resolve(script).replace(/\\/g, '/');
  if (/[\r\n\x00]/.test(absolute)) throw Error('Invalid hook script path');
  const posix = "node '" + absolute.replace(/'/g, "'\"'\"'") + "'";
  const windows = "node '" + absolute.replace(/'/g, "''") + "'";
  return '# Merge once into your Codex config.toml; do not overwrite existing settings.\n'
    + '# Requires SessionStart/compact and additionalContext support; trust after review.\n'
    + '[[hooks.SessionStart]]\nmatcher = "compact"\n\n[[hooks.SessionStart.hooks]]\n'
    + 'type = "command"\ncommand = ' + JSON.stringify(posix) + '\n'
    + 'commandWindows = ' + JSON.stringify(windows) + '\ntimeout = 5\n';
}
module.exports = {registration};
if (require.main === module) process.stdout.write(registration());
