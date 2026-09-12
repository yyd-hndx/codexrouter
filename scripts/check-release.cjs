'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const excluded = new Set(['.git', 'node_modules', '.runtime', '.local', '.agent-work', 'test-results', 'coverage']);
function walk(dir = root) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name), rel = path.relative(root, full).replace(/\\/g, '/');
    if (excluded.has(e.name) || rel === 'legacy/work' || e.name.endsWith('.local.json') || e.name.startsWith('.env')) return [];
    return e.isDirectory() ? walk(full) : [rel];
  });
}
function issuesFor(name, text) {
  const issues = [];
  if (/\.local\.json$/.test(name)) issues.push('private local configuration');
  if (/(^|\/)(credential\.xml|\.credentials\.yaml|\.env(?:\..*)?|config\.local\.json)$/.test(name) || /(^|\/)(\.agent-work|node_modules|\.runtime|\.local)\//.test(name) || name.startsWith('legacy/work/')) issues.push('private/generated file');
  if (/[A-Z]:[\\/]+Users[\\/]+(?!example(?:[\\/]|$))[^\\/\s]+/i.test(text)) issues.push('personal home path');
  if (/\b(?:sk|xai)-[A-Za-z0-9_-]{24,}\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push('possible credential');
  if (/(?:api[_-]?key|token|password)\s*[=:]\s*["'][A-Za-z0-9_+/=-]{32,}["']/i.test(text)) issues.push('possible embedded credential');
  return issues;
}
function check() {
  let files = walk();
  // Include tracked ignored files too: .gitignore does not untrack a leaked file.
  if (fs.existsSync(path.join(root, '.git'))) {
    const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true });
    files = [...new Set(listed.split('\0').filter(Boolean))];
  }
  const problems = [];
  for (const name of files) {
    const full = path.join(root, name);
    if (!fs.existsSync(full)) continue;
    if (fs.lstatSync(full).isSymbolicLink()) { problems.push({ file: name, issues: ['symlinks require manual review'] }); continue; }
    const text = fs.readFileSync(full, 'utf8');
    const issues = issuesFor(name, text);
    if (name.endsWith('.md')) {
      for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const link = match[1];
        if (/^(?:https?:|#|mailto:)/.test(link)) continue;
        const target = path.resolve(path.dirname(full), decodeURIComponent(link.split('#')[0]));
        if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) issues.push('broken or external local documentation link');
      }
    }
    if (issues.length) problems.push({ file: name, issues });
  }
  return { passed: problems.length === 0, scannedFiles: files.length, problems, limitation: 'Heuristic scan of release files, not a guarantee or a scan of all prior Git history.' };
}
if (require.main === module) { const r = check(); console.log(JSON.stringify(r, null, 2)); if (!r.passed) process.exitCode = 1; }
module.exports = { issuesFor, check };
