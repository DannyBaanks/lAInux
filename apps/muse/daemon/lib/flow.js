'use strict';

// Flow mode: a time-boxed operator decision to stop asking for consent on
// actions that are ALREADY granted for the target folder (write/shell with
// `muse-node grant write|shell <folder>`). It never widens a grant:
//   - it only answers "fresh request-bound approval is required";
//   - outside the granted folders, Flow still asks;
//   - credential and authority paths stay denied (SensitivePath);
//   - every action still leaves EXECUTE/RETURN receipts (approval: "flow").
// Scope: "write" (default) covers files.write/files.mkdir only. "all" also
// covers shell.exec, and then a flowed command runs with your full user
// power: it could even extend Flow itself. Use "all" only for short runs.
// It can only be switched on by the operator: the terminal
// (`muse-node flow on 30m`) or the paired private Telegram chat. The state
// file lives in the protected authority directory, out of reach of files.*.
// It expires on its own; a malformed file means "off".

const fs = require('node:fs');
const path = require('node:path');

const MAX_MINUTES = 8 * 60;

class FlowMode {
  constructor({ file, now = () => Date.now() }) {
    this.file = file;
    this.now = now;
  }

  status() {
    let value;
    try {
      const info = fs.lstatSync(this.file);
      if (!info.isFile() || info.size > 4096 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return { active: false };
      value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { active: false };
    }
    const until = Date.parse(value?.until);
    if (!Number.isFinite(until) || until <= this.now() || until - this.now() > MAX_MINUTES * 60000 + 60000) return { active: false };
    const scope = value.scope === 'all' ? 'all' : 'write';
    return { active: true, scope, until: new Date(until).toISOString(), setBy: String(value.set_by ?? ''), remainingMs: until - this.now() };
  }

  covers(actionId) {
    const state = this.status();
    if (!state.active) return false;
    if (actionId === 'workspace.files.write') return true;
    return actionId === 'workspace.command.run' && state.scope === 'all';
  }

  enable(minutes, setBy, scope = 'write') {
    if (!['write', 'all'].includes(scope)) throw new Error('Flow scope is write or all');
    const value = Math.round(Number(minutes));
    if (!Number.isFinite(value) || value < 1 || value > MAX_MINUTES) throw new Error(`Flow lasts 1..${MAX_MINUTES} minutes`);
    if (!['terminal', 'telegram'].includes(setBy)) throw new Error('Flow can only be enabled by the operator');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const until = new Date(this.now() + value * 60000).toISOString();
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ until, scope, set_by: setBy, set_at: new Date(this.now()).toISOString() }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    return this.status();
  }

  disable() {
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { active: false };
  }
}

function parseMinutes(text) {
  const match = /^(\d+)\s*(m|min|h)?$/i.exec(String(text ?? '30').trim());
  if (!match) throw new Error('usage: 30, 30m, 2h');
  return Number(match[1]) * (match[2]?.toLowerCase() === 'h' ? 60 : 1);
}

module.exports = { FlowMode, parseMinutes, MAX_MINUTES };
