'use strict';

// Turn approval: "approve everything for this turn".
//
// The operator taps it on the FIRST dialog of a burst of requests. From then
// on, for a short window that renews every time Muse asks again, requests
// that are ALREADY granted for the target folder (write/shell with
// `muse-node grant write|shell <folder>`) pass without a dialog.
//
// It never widens a grant. It answers only the consent question
// ("fresh request-bound approval is required"): the authority decides that
// the target is inside a granted folder, and the turn only supplies the
// missing "yes". Outside granted folders, Flow and this mode both keep
// asking. Credential and authority paths stay denied (SensitivePath).
// Every action still leaves EXECUTE/RETURN receipts (approval: "turn").
//
// Muse's invoke carries no turn id, so a "turn" is a quiet window: every
// covered request restarts the clock. When Muse stops asking, it lapses.
//
// The state file lives in the protected authority directory, out of reach
// of files.*; only the desktop dialog, the paired phone channel or the
// terminal (`muse-node turn on|off`) can switch it on. A malformed file
// means "off".

const fs = require('node:fs');
const path = require('node:path');

const CONSENT_REASON = 'fresh request-bound approval is required';
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
const MAX_WINDOW_MS = 30 * 60 * 1000;
const OPERATORS = new Set(['desktop', 'telegram', 'isytron-link', 'terminal']);

class TurnApproval {
  constructor({ file, windowMs = DEFAULT_WINDOW_MS, maxWindowMs = MAX_WINDOW_MS, now = () => Date.now() } = {}) {
    this.file = file;
    this.windowMs = Math.min(windowMs, maxWindowMs);
    this.maxWindowMs = maxWindowMs;
    this.now = now;
  }

  read() {
    let info;
    try { info = fs.lstatSync(this.file); } catch { return null; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return null;
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return null;
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  status() {
    const value = this.read();
    if (!value) return { active: false };
    const until = Date.parse(value?.until);
    if (!Number.isFinite(until) || until <= this.now() || until - this.now() > this.maxWindowMs + 60000) return { active: false };
    return { active: true, until: new Date(until).toISOString(), setBy: String(value.set_by ?? ''), actions: Number(value.actions ?? 0), remainingMs: until - this.now() };
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  enable(setBy, { windowMs = this.windowMs } = {}) {
    if (!OPERATORS.has(setBy)) throw new Error('a turn can only be approved by the operator');
    this.write({ until: new Date(this.now() + Math.min(windowMs, this.maxWindowMs)).toISOString(), set_by: setBy, set_at: new Date(this.now()).toISOString(), actions: 0 });
    return this.status();
  }

  // Every covered request restarts the quiet window (bounded by the
  // absolute maximum, so an idle turn cannot be kept alive by a stale file).
  touch() {
    const current = this.read();
    if (!current) return this.status();
    const value = { ...current, until: new Date(this.now() + this.windowMs).toISOString(), actions: Number(current.actions ?? 0) + 1 };
    this.write(value);
    return this.status();
  }

  disable() {
    try { fs.unlinkSync(this.file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { active: false };
  }

  // True when `authority` would allow this exact request with nothing but a
  // "yes": same evaluation the gate performs, without any approval token.
  // The request must sit inside a folder that is already granted; this only
  // answers the consent question, it never widens a grant.
  wouldCover(request, authority) {
    if (!['workspace.files.write', 'workspace.command.run'].includes(request.actionId)) return false;
    let decision;
    try { decision = authority.evaluate(request); } catch { return false; }
    return !decision.allowed && decision.reason === CONSENT_REASON;
  }

  // True when a turn is active AND it would cover this request.
  covers(request, authority) {
    if (!this.status().active) return false;
    return this.wouldCover(request, authority);
  }
}

module.exports = { TurnApproval, DEFAULT_WINDOW_MS, MAX_WINDOW_MS, CONSENT_REASON };
