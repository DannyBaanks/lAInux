'use strict';

// Undo log: what the owner is about to change, and what was there before.
//
// The receipts (receipts.js) prove WHAT was decided and that it happened,
// but they never store file contents, so they cannot undo anything. This log
// is the operator's safety net for "approve everything for this turn":
//
//   - before files.write / files.mkdir act, `record()` stores the target's
//     previous state: existed or not, sha256, and a copy of the previous
//     content (files up to MAX_COPY_BYTES; larger files keep only the hash
//     and are reported as not reversible);
//   - shell.exec is logged as "ran" with its hash and preview but can never
//     be undone automatically: a command may do anything.
//
// Entries are keyed by the request digest (the same one in the receipts and
// in the approved dialog) and chained by hash like the receipts. Copies
// live next to the log, in the protected authority directory. `muse-node
// undo` reads this log; nothing reachable from the model can.

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256 } = require('./security');
const { redact } = require('./receipts');

const GENESIS = '0'.repeat(64);
const MAX_COPY_BYTES = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

class UndoLog {
  constructor({ directory, now = () => new Date() } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'undo.jsonl');
    this.copies = path.join(directory, 'undo');
    this.now = now;
    this.last = null;
  }

  tail() {
    if (this.last) return this.last;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n').filter(Boolean);
      const last = lines.length ? JSON.parse(lines.at(-1)) : null;
      this.last = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.last = { seq: 0, hash: GENESIS };
    }
    return this.last;
  }

  _append(kind, fields) {
    const previous = this.tail();
    const body = { v: 1, seq: previous.seq + 1, at: this.now().toISOString(), kind, ...fields, prev: previous.hash };
    const hash = sha256(canonicalJson(body));
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, `${JSON.stringify({ ...body, hash })}\n`, { mode: 0o600 });
    this.last = { seq: body.seq, hash };
    return { ...body, hash };
  }

  // Snapshot of the target BEFORE the owner acts. Returns the entry.
  record(request, { approval = null, invokeId = null } = {}) {
    const common = { digest: request.digest, action_id: request.actionId, target: request.target, approval, invoke_id: invokeId };
    if (request.actionId === 'workspace.command.run') {
      const command = String(request.parameters.command ?? '');
      return this._append('RAN', { ...common, reversible: false, command_sha256: sha256(command), command_preview: redact(command, 200), cwd: request.target });
    }
    let info;
    try { info = fs.lstatSync(request.target); } catch (error) { if (error.code !== 'ENOENT') throw error; info = null; }
    if (!info) return this._append('BEFORE', { ...common, reversible: true, existed: false });
    if (info.isSymbolicLink()) return this._append('BEFORE', { ...common, reversible: false, existed: true, target_kind: 'symlink', reason: 'target is a symlink; not touched by undo' });
    if (info.isDirectory()) {
      // The folder was already there: mkdir changes nothing, and undo must
      // never remove something the owner did not create.
      return this._append('BEFORE', { ...common, reversible: false, existed: true, target_kind: 'folder', reason: 'folder already existed before this action; nothing to undo' });
    }
    if (!info.isFile()) return this._append('BEFORE', { ...common, reversible: false, existed: true, target_kind: 'other' });
    const content = fs.readFileSync(request.target);
    const digest = sha256(content);
    if (content.length > MAX_COPY_BYTES) return this._append('BEFORE', { ...common, reversible: false, existed: true, target_kind: 'file', size: content.length, sha256: digest, reason: `larger than ${MAX_COPY_BYTES} bytes; previous content not kept` });
    fs.mkdirSync(this.copies, { recursive: true, mode: 0o700 });
    const copy = path.join(this.copies, `${request.digest}.before`);
    fs.writeFileSync(copy, content, { mode: 0o600, flag: 'wx' });
    return this._append('BEFORE', { ...common, reversible: true, existed: true, target_kind: 'file', size: content.length, sha256: digest, copy });
  }

  // The owner acted; mark the entry DONE so undo knows what to reverse.
  done(digest, { ok = true } = {}) {
    const entry = this.entries().find((item) => item.digest === digest && item.kind === 'BEFORE');
    if (!entry) return null;
    const plan = planFor(entry);
    // target/action/at are repeated here so `undo list` can describe a DONE
    // row without re-reading its BEFORE.
    return this._append('DONE', { digest, seq_before: entry.seq, ok, undo: plan, reversible: entry.reversible, target: entry.target, target_kind: entry.target_kind, action_id: entry.action_id, approval: entry.approval, invoke_id: entry.invoke_id });
  }

  entries() {
    let lines;
    try { lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return lines.map((line) => JSON.parse(line));
  }

  // Actions the operator can undo, newest first: DONE entries that are
  // reversible and not yet undone.
  undoable() {
    const undone = new Set(this.entries().filter((item) => item.kind === 'UNDO').map((item) => item.digest));
    return this.entries().filter((item) => item.kind === 'DONE' && item.reversible && item.ok && !undone.has(item.digest)).reverse();
  }

  // Reverse one DONE entry. Returns the UNDO receipt or throws.
  undo(seq, { dryRun = false } = {}) {
    const entry = this.entries().find((item) => item.kind === 'DONE' && item.seq === Number(seq));
    if (!entry) throw Object.assign(new Error(`no done action with seq ${seq}`), { code: 'no_such_action' });
    if (!entry.reversible || !entry.ok) throw Object.assign(new Error('this action cannot be undone automatically'), { code: 'not_reversible' });
    if (this.entries().some((item) => item.kind === 'UNDO' && item.digest === entry.digest)) throw Object.assign(new Error('already undone'), { code: 'already_undone' });
    const before = this.entries().find((item) => item.kind === 'BEFORE' && item.digest === entry.digest);
    if (!before) throw Object.assign(new Error('missing BEFORE entry'), { code: 'missing_before' });
    const plan = entry.undo ?? planFor(before);
    if (dryRun) return { dryRun: true, seq: entry.seq, plan };
    applyPlan(plan, before);
    return this._append('UNDO', { digest: entry.digest, seq_undone: entry.seq, plan });
  }
}

// What undo will do, derived from the BEFORE snapshot.
function planFor(before) {
  if (!before.reversible) return null;
  if (!before.existed) return { op: 'remove_created' };
  if (before.target_kind === 'folder') return { op: 'remove_folder_if_empty' };
  if (before.target_kind === 'file') return { op: 'restore_copy', copy: before.copy, sha256: before.sha256 };
  return null;
}

function applyPlan(plan, before) {
  if (!plan) throw Object.assign(new Error('nothing to undo'), { code: 'not_reversible' });
  if (plan.op === 'remove_created') {
    // Only remove what is still a plain file/folder; never follow a symlink.
    let info;
    try { info = fs.lstatSync(before.target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw Object.assign(new Error('target became a symlink; refusing'), { code: 'target_changed' });
    if (info.isDirectory()) fs.rmdirSync(before.target);
    else fs.unlinkSync(before.target);
    return;
  }
  if (plan.op === 'remove_folder_if_empty') {
    let info;
    try { info = fs.lstatSync(before.target); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isDirectory()) return;
    try { fs.rmdirSync(before.target); }
    catch (error) {
      if (error.code === 'ENOTEMPTY') throw Object.assign(new Error('folder is not empty; undo left it in place. List it with: ls -la <folder>'), { code: 'folder_not_empty', target: before.target });
      throw error;
    }
    return;
  }
  if (plan.op === 'restore_copy') {
    const content = fs.readFileSync(plan.copy);
    if (sha256(content) !== plan.sha256) throw Object.assign(new Error('saved copy does not match its hash; refusing'), { code: 'copy_corrupt' });
    let info;
    try { info = fs.lstatSync(before.target); } catch (error) { if (error.code !== 'ENOENT') throw error; info = null; }
    if (info?.isSymbolicLink()) throw Object.assign(new Error('target became a symlink; refusing'), { code: 'target_changed' });
    const fd = fs.openSync(before.target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
    return;
  }
  throw Object.assign(new Error(`unknown undo op ${plan.op}`), { code: 'unknown_op' });
}

module.exports = { UndoLog, planFor, MAX_COPY_BYTES, MAX_LOG_BYTES };
