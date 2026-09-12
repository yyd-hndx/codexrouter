'use strict';
const { spawn, execFile } = require('node:child_process');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
class Rpc extends EventEmitter {
  constructor(command, args, options) {
    super(); this.seq = 0; this.pending = new Map(); this.closed = false;
    this.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exit = new Promise(resolve => { this.resolveExit = resolve; });
    this.child.stderr.on('data', data => this.emit('diagnostic', data));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('error', error => { this.fail(error); this.resolveExit(); });
    this.child.on('close', (code, signal) => { this.closed = true; this.fail(Error(`Runtime exited (${code}, ${signal})`)); this.resolveExit(); this.emit('closed', code); });
    readline.createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { this.emit('invalid', 'Non-JSON runtime stdout'); return; }
      this.emit('frame', message);
      if (message.method && message.id !== undefined) { this.emit('request', message); return; }
      if (message.id !== undefined) {
        const p = this.pending.get(message.id); if (!p) return;
        this.pending.delete(message.id); clearTimeout(p.timer);
        message.error ? p.reject(Error(message.error.message || 'RPC error')) : p.resolve(message.result); return;
      }
      if (message.method) this.emit('notification', message);
    });
  }
  write(message) { if (this.closed) throw Error('Runtime closed'); this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  request(method, params, timeout = 45000, suppliedId) {
    const id = suppliedId || `rpc-${++this.seq}`;
    const result = new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, timeout) : undefined;
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
    return result;
  }
  notify(method, params) { this.write({ method, params }); }
  fail(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const ended = await Promise.race([this.exit.then(() => true), new Promise(r => setTimeout(() => r(false), 2500))]);
    if (!ended) {
      if (process.platform === 'win32') await new Promise((resolve, reject) => execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, timeout:5000 }, error => this.closed || !error ? resolve() : reject(error)));
      else this.child.kill('SIGKILL');
      await Promise.race([this.exit, new Promise((_, reject) => setTimeout(() => reject(Error('Runtime exit unverified')), 5000))]);
    }
  }
}
module.exports = { Rpc };
