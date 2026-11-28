'use strict';

// Workspace Authority + approval vault, mirroring ISyCode's
// workspace_authority.py and approvals.py.
//
// - The workspace root ($HOME by default) is the maximum boundary; it grants
//   nothing. Grants are explicit, per action, narrowed to path prefixes, and
//   live in private state outside any checkout:
//     $XDG_STATE_HOME/lainux-mods/workspace-authority/grants-<sha256(root)[:32]>.json
// - Missing policy = no grants. Malformed, oversized, shared, linked or
//   foreign-owned policy = DENY everything.
// - The policy is re-read on every evaluation: a revoke or lock is immediate.
// - "locked": true is the operator's panic switch: everything but node.ping
//   is denied.
// - An approval is a short-lived (1..120 s), single-use token bound to one
//   request digest. It never becomes a persistent grant.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ACTIONS, ActionRequest, AuthorityDecision, contains, realTarget } = require('./security');

const VERSION = 1;
const MAX_POLICY_BYTES = 256 * 1024;

class WorkspaceAuthorityError extends Error {}

function defaultStateDirectory() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'lainux-mods');
}

// Human-friendly grant groups for the CLI.
const GRANT_ALIASES = Object.freeze({
  read: ['workspace.files.list', 'workspace.files.read', 'workspace.files.search'],
  write: ['workspace.files.write'],
  shell: ['workspace.command.run'],
  which: ['node.system.which'],
});

class ActionApprovalStore {
  constructor({ now = () => Date.now(), maxPending = 1024 } = {}) {
    this.now = now;
    this.maxPending = maxPending;
    this.tokens = new Map();
  }

  issue(request, { ttlMs = 60000, mode = 'user' } = {}) {
    if (!(request instanceof ActionRequest)) throw new TypeError('Approval requires an immutable ActionRequest.');
    if (!['user', 'delegated'].includes(mode)) throw new Error("Approval mode must be 'user' or 'delegated'.");
    if (!Number.isFinite(ttlMs)) throw new Error('Approval lifetime must be finite.');
    const lifetime = Math.max(1000, Math.min(ttlMs, 120000));
    const now = this.now();
    for (const [token, value] of this.tokens) if (value.expiresAt < now) this.tokens.delete(token);
    if (this.tokens.size >= this.maxPending) throw new Error('Too many pending approvals; wait for existing approvals to expire.');
    const approval = Object.freeze({ token: crypto.randomBytes(32).toString('base64url'), requestDigest: request.digest, expiresAt: now + lifetime, mode });
    this.tokens.set(approval.token, approval);
    return approval;
  }

  consume(request, approval) {
    if (!(request instanceof ActionRequest) || !approval?.token) return false;
    const stored = this.tokens.get(approval.token);
    if (!stored || stored !== approval) return false;
    if (stored.expiresAt < this.now()) { this.tokens.delete(approval.token); return false; }
    if (stored.requestDigest !== request.digest) return false;
    this.tokens.delete(approval.token);
    return true;
  }
}

class WorkspaceAuthority {
  constructor({ root = os.homedir(), stateDirectory = defaultStateDirectory() } = {}) {
    try { this.root = fs.realpathSync(root); } catch { throw new WorkspaceAuthorityError('Workspace root cannot be resolved safely.'); }
    if (!fs.statSync(this.root).isDirectory()) throw new WorkspaceAuthorityError('Workspace root must be a directory.');
    this.stateDirectory = path.join(stateDirectory, 'workspace-authority');
    this.rootId = crypto.createHash('sha256').update(this.root).digest('hex').slice(0, 32);
    this.policyPath = path.join(this.stateDirectory, `grants-${this.rootId}.json`);
  }

  ensureStateDirectory() {
    fs.mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(this.stateDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new WorkspaceAuthorityError('Authority state directory must be a real directory.');
    fs.chmodSync(this.stateDirectory, 0o700);
  }

  emptyPolicy() { return { version: VERSION, workspace_root: this.root, locked: false, grants: {} }; }

  policy() {
    let info;
    try { info = fs.lstatSync(this.policyPath); }
    catch (error) {
      if (error.code === 'ENOENT') return this.emptyPolicy();
      throw new WorkspaceAuthorityError('Workspace grant policy cannot be inspected.');
    }
    const safe = info.isFile() && info.nlink === 1 && info.uid === process.getuid() && (info.mode & 0o077) === 0 && info.size <= MAX_POLICY_BYTES;
    if (!safe) throw new WorkspaceAuthorityError('Workspace grant policy is not a bounded private regular file.');
    let value;
    try { value = JSON.parse(fs.readFileSync(this.policyPath, 'utf8')); }
    catch { throw new WorkspaceAuthorityError('Workspace grant policy is malformed.'); }
    if (value?.version !== VERSION || value.workspace_root !== this.root || typeof value.grants !== 'object' || value.grants === null) {
      throw new WorkspaceAuthorityError('Workspace grant policy belongs to another version or workspace.');
    }
    return value;
  }

  canonicalPath(value) {
    const expanded = typeof value === 'string' && value.startsWith('~')
      ? path.join(os.homedir(), value.slice(1)) : value;
    const real = realTarget(path.resolve(this.root, String(expanded)));
    if (!contains(this.root, real)) throw new WorkspaceAuthorityError('path is outside the workspace boundary');
    return real;
  }

  // Persist one explicit grant. Only the operator's CLI calls this; no
  // command reachable from the model can (the state directory is a protected
  // path for files.*).
  setGrant(actionId, { enabled, pathPrefixes } = {}) {
    if (!ACTIONS[actionId] || typeof enabled !== 'boolean') throw new Error('Unknown action or invalid enabled value.');
    const policy = this.policy();
    const current = { ...(policy.grants[actionId] ?? {}), enabled };
    if (pathPrefixes !== undefined) current.path_prefixes = [...new Set(pathPrefixes.map((item) => this.canonicalPath(item)))].sort();
    policy.grants = { ...policy.grants, [actionId]: current };
    this.write(policy);
    return current;
  }

  setLocked(locked) {
    const policy = this.policy();
    policy.locked = Boolean(locked);
    this.write(policy);
  }

  write(value) {
    this.ensureStateDirectory();
    const temporary = `${this.policyPath}.${process.pid}.tmp`;
    fs.rmSync(temporary, { force: true });
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, this.policyPath);
  }

  // approval: a token from ActionApprovalStore.issue for this exact request.
  // Without a matching grant, a consumed approval is a one-shot authority for
  // this request only (ISyCode OneShotActionAuthority). With a grant, actions
  // marked approvalRequired still need the consumed approval.
  evaluate(request, { approvals = null, approval = null } = {}) {
    if (!(request instanceof ActionRequest)) return new AuthorityDecision(false, '', 'invalid action request', '');
    const digest = request.digest;
    const deny = (reason) => new AuthorityDecision(false, '', reason, digest);
    if (request.workspaceRoot !== this.root) return deny('request belongs to another workspace');
    const spec = ACTIONS[request.actionId];
    if (!spec) return deny('unknown action is denied');
    let policy;
    try { policy = this.policy(); } catch { return deny('workspace grant policy unavailable or invalid'); }
    if (request.actionId === 'node.ping') return new AuthorityDecision(true, 'builtin:liveness', 'liveness check needs no grant', digest);
    if (policy.locked) return deny('node locked by the operator');
    const grant = policy.grants[request.actionId] ?? {};
    if (grant.enabled === false) return deny('action explicitly revoked');

    let granted = grant.enabled === true;
    if (granted && spec.pathTarget) {
      let roots;
      try { roots = (grant.path_prefixes ?? []).map((item) => this.canonicalPath(item)); }
      catch { return deny('granted path prefixes are invalid'); }
      if (!roots.some((root) => contains(root, request.target))) granted = false;
    }

    const consumeApproval = () => Boolean(approvals && approval && approvals.consume(request, approval));
    if (!granted) {
      if (consumeApproval()) return new AuthorityDecision(true, 'user-approved-once', 'one exact request approved by the user', digest);
      return deny(spec.pathTarget && grant.enabled ? 'filesystem target is outside granted paths' : 'no explicit workspace grant');
    }
    if (spec.approvalRequired && !consumeApproval()) return deny('fresh request-bound approval is required');
    return new AuthorityDecision(true, `grant:${request.actionId}`, 'explicit workspace grant matched', digest);
  }
}

module.exports = { WorkspaceAuthority, WorkspaceAuthorityError, ActionApprovalStore, GRANT_ALIASES, defaultStateDirectory };
