'use strict';

// JS mirror of ISyCode's security contract (ISyCode src/isycode/security.py,
// workspace_authority.py, approvals.py; design: docs/design/
// isysentinel-security-boundaries.md). Same request path, same names:
//
//   intent -> immutable ActionRequest -> Workspace Authority
//          -> read-only checks -> IsySentinel ALLOW/DENY
//          -> execution owner performs the effect -> receipt
//
// IsySentinel only aggregates. It never prompts, consumes approvals, writes
// receipts or executes. An empty check set, a failed check, a thrown check or
// an unknown action is DENY. The request digest is the same canonical
// SHA-256 as ISyCode's ActionRequest.digest.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Action catalog. Ids reuse ISyCode's where the semantics match; node.* are
// specific to a computer node. effect/approvalRequired mirror ActionSpec.
const ACTIONS = Object.freeze({
  'node.ping': { effect: 'none', approvalRequired: false, pathTarget: false },
  'node.system.which': { effect: 'read', approvalRequired: false, pathTarget: false },
  'workspace.files.list': { effect: 'read', approvalRequired: false, pathTarget: true },
  'workspace.files.read': { effect: 'read', approvalRequired: false, pathTarget: true },
  'workspace.files.search': { effect: 'read', approvalRequired: false, pathTarget: true },
  'workspace.files.write': { effect: 'write', approvalRequired: true, pathTarget: true },
  'workspace.command.run': { effect: 'process', approvalRequired: true, pathTarget: true },
});

// Credential stores and our own authority state. Never readable or writable
// through files.*, whatever the grants or approvals say: a model must not be
// able to read secrets or grant itself permissions.
const SENSITIVE_PARTS = new Set(['.ssh', '.gnupg', '.aws', '.password-store', '.kube', '.docker', '.pki', '.Trash', '.mozilla']);
const SENSITIVE_RELATIVE = [
  '.config/muse-desktop', '.config/gh', '.config/google-chrome', '.config/BraveSoftware', '.config/chromium',
  '.local/share/keyrings', '.netrc', '.git-credentials', '.claude/bridge_sessions', '.claude/.credentials.json',
  '.local/state/isyco/bridge-leases', '.config/lainux-mods', '.local/state/lainux-mods',
];

function freeze(value, depth = 0) {
  if (depth > 12) throw new Error('Action parameters exceed the maximum nesting depth.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Action parameters must not contain non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024) throw new Error('Action parameter lists exceed the size limit.');
    return Object.freeze(value.map((item) => freeze(item, depth + 1)));
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 256) throw new Error('Action parameter maps must have bounded string keys.');
    const out = {};
    for (const key of keys) if (value[key] !== undefined) out[key] = freeze(value[key], depth + 1);
    return Object.freeze(out);
  }
  throw new Error('Action parameters must contain JSON-compatible values.');
}

// json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

class ActionRequest {
  constructor({ actionId, workspaceRoot, target = '', parameters = {}, executionOwner = '' }) {
    if (typeof actionId !== 'string' || !actionId || actionId.length > 160) throw new Error('Action request requires a bounded action identifier.');
    let root;
    try { root = fs.realpathSync(workspaceRoot); } catch { throw new Error('Workspace root must resolve to a real directory.'); }
    if (!fs.statSync(root).isDirectory()) throw new Error('Workspace root must resolve to a real directory.');
    if (typeof target !== 'string' || target.length > 4096) throw new Error('Action target must be a bounded string.');
    if (typeof executionOwner !== 'string' || executionOwner.length > 120) throw new Error('Action request execution-owner identity must be bounded text.');
    const frozen = freeze(parameters ?? {});
    if (Buffer.byteLength(canonicalJson(frozen)) > 64 * 1024) throw new Error('Action parameters exceed the 64 KiB limit.');
    this.actionId = actionId;
    this.workspaceRoot = root;
    this.target = target;
    this.parameters = frozen;
    this.executionOwner = executionOwner;
    this.digest = sha256(canonicalJson({
      action_id: actionId, workspace_root: root, target, parameters: frozen, execution_owner: executionOwner,
    }));
    Object.freeze(this);
  }
}

class AuthorityDecision {
  constructor(allowed, grantId, reason, requestDigest) {
    Object.assign(this, { allowed, grantId, reason, requestDigest });
    Object.freeze(this);
  }
}

function contains(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Real path of `value`, or of its nearest existing ancestor joined with the
// missing tail (for files that are about to be created). Symlinks in the
// existing part are resolved, so a link pointing at ~/.ssh is seen as ~/.ssh.
function realTarget(value) {
  const lexical = path.resolve(value);
  let cursor = lexical;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(cursor), ...tail.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function sensitiveReason(candidate, { home, extra = [] } = {}) {
  const parts = candidate.split(path.sep);
  const part = parts.find((item) => SENSITIVE_PARTS.has(item));
  if (part) return `${part} is a credential store`;
  if (home) {
    for (const relative of SENSITIVE_RELATIVE) {
      if (contains(path.join(home, relative), candidate)) return `${relative} is protected`;
    }
  }
  for (const protectedPath of extra) if (contains(protectedPath, candidate)) return 'authority state is protected';
  return null;
}

// ---- checks: read-only checks, one verdict each -------------------

function result(name, passed, reason) { return Object.freeze({ name, passed, reason }); }

class WorkspaceBoundaryCheck {
  constructor() { this.name = 'WorkspaceBoundary'; }
  evaluate(request) {
    const spec = ACTIONS[request.actionId];
    if (!spec?.pathTarget) return result(this.name, true, 'action has no filesystem target');
    if (!path.isAbsolute(request.target)) return result(this.name, false, 'target must be a canonical absolute path');
    let real;
    try { real = realTarget(request.target); } catch { return result(this.name, false, 'target cannot be resolved safely'); }
    if (real !== request.target) return result(this.name, false, 'target is not canonical (symlink or relative component)');
    if (!contains(request.workspaceRoot, real)) return result(this.name, false, 'target resolves outside the workspace boundary');
    return result(this.name, true, 'target inside the workspace boundary');
  }
}

class SensitivePathCheck {
  constructor({ home, protectedPaths = [] } = {}) { this.name = 'SensitivePath'; this.home = home; this.protectedPaths = protectedPaths; }
  evaluate(request) {
    const spec = ACTIONS[request.actionId];
    if (!spec?.pathTarget) return result(this.name, true, 'action has no filesystem target');
    let real;
    try { real = realTarget(request.target); } catch { return result(this.name, false, 'target cannot be resolved safely'); }
    const reason = sensitiveReason(real, { home: this.home, extra: this.protectedPaths });
    return reason ? result(this.name, false, reason) : result(this.name, true, 'no credential or authority path involved');
  }
}

class ExecutionOwnerCheck {
  constructor(owners) { this.name = 'ExecutionOwner'; this.owners = owners; }
  evaluate(request) {
    const expected = this.owners[request.actionId];
    return expected && request.executionOwner === expected
      ? result(this.name, true, `owner ${expected} verified`)
      : result(this.name, false, 'execution owner is not the registered owner for this action');
  }
}

class IsySentinel {
  constructor(guards) { this.guards = Object.freeze([...guards]); }

  evaluate(request, authority) {
    const checks = [];
    if (!(request instanceof ActionRequest)) {
      return decision('invalid', '', [
        result('KnownAction', false, 'invalid action request is denied'),
        result('Authority', false, 'Workspace Authority result is unavailable'),
      ]);
    }
    const spec = ACTIONS[request.actionId];
    checks.push(result('KnownAction', Boolean(spec), spec ? 'action is registered' : 'unknown action is denied'));
    const authorityValid = authority instanceof AuthorityDecision && authority.allowed
      && Boolean(authority.grantId) && authority.requestDigest === request.digest;
    let authorityReason;
    if (!(authority instanceof AuthorityDecision)) authorityReason = 'Workspace Authority result is unavailable';
    else if (authority.requestDigest !== request.digest) authorityReason = 'Workspace Authority result is bound to another request';
    else authorityReason = authority.reason ? authority.reason.slice(0, 500) : 'explicit grant required';
    checks.push(result('Authority', authorityValid, authorityReason));
    checks.push(result('CheckSet', this.guards.length > 0,
      this.guards.length ? 'applicable checks configured' : 'no checks configured'));
    // Every check runs even after a failure so the decision explains the
    // whole gate. Exceptions become a non-sensitive reason.
    for (const guard of this.guards) {
      const name = String(guard?.name ?? 'anonymous').slice(0, 120);
      try {
        const verdict = guard.evaluate(request, authority);
        if (!verdict || verdict.name !== name || typeof verdict.passed !== 'boolean') {
          checks.push(result(name, false, 'invalid Check result'));
          continue;
        }
        checks.push(result(name, verdict.passed, String(verdict.reason).slice(0, 500)));
      } catch {
        checks.push(result(name, false, 'Check evaluation failed'));
      }
    }
    return decision(request.actionId, request.digest, checks);
  }
}

function decision(actionId, requestDigest, checks) {
  const allowed = checks.length > 0 && checks.every((check) => check.passed);
  return Object.freeze({ actionId, requestDigest, checks: Object.freeze(checks), allowed, status: allowed ? 'ALLOW' : 'DENY' });
}

module.exports = {
  ACTIONS, ActionRequest, AuthorityDecision, IsySentinel, canonicalJson, sha256, realTarget, contains, sensitiveReason,
  WorkspaceBoundaryCheck, SensitivePathCheck, ExecutionOwnerCheck, SENSITIVE_PARTS, SENSITIVE_RELATIVE,
};
