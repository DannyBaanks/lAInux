'use strict';

// ProductActionGate equivalent: the only path from a model request to an
// effect on this computer.
//
//   1. Workspace Authority evaluates the immutable request (no approval).
//   2. If the only thing missing is consent (no grant / outside granted paths
//      / approval required), and the checks would pass, ask the
//      operator. A yes issues a single-use approval bound to the digest and
//      Authority is evaluated again with it. Revoked, locked, sensitive and
//      out-of-boundary requests are denied without asking.
//   3. IsySentinel aggregates Authority + checks: ALLOW or DENY.
//   4. Receipts: DENY, or EXECUTE now and RETURN after the owner acted.
//
// The model requests; the gate decides; the owner executes; the operator
// keeps authority. Nothing here can create or widen a grant.

const { AuthorityDecision, IsySentinel, WorkspaceBoundaryCheck, SensitivePathCheck, ExecutionOwnerCheck, sha256 } = require('./security');
const { ActionApprovalStore } = require('./workspace-authority');
const { redact } = require('./receipts');

const CONSENT_REASONS = new Set([
  'no explicit workspace grant',
  'filesystem target is outside granted paths',
  'fresh request-bound approval is required',
]);

const FLOW_REASON = 'fresh request-bound approval is required';

// approve() may answer a boolean (single channel) or the Approval Broker's
// { approved, channel }.
function normalizeAnswer(answer) {
  if (answer === true) return { approved: true, channel: null };
  if (answer && typeof answer === 'object' && answer.approved === true) return { approved: true, channel: typeof answer.channel === 'string' ? answer.channel : null };
  return { approved: false, channel: null };
}

class ActionGate {
  constructor({ authority, approve = async () => false, approvals = new ActionApprovalStore(), receipts = null, owners, home, flow = null, onFlow = null, logger = console }) {
    this.authority = authority;
    this.flow = flow;
    this.onFlow = onFlow;
    this.approve = approve;
    this.approvals = approvals;
    this.receipts = receipts;
    this.logger = logger;
    const protectedPaths = [authority.stateDirectory];
    if (receipts?.file) protectedPaths.push(require('node:path').dirname(receipts.file));
    this.sentinel = new IsySentinel([
      new WorkspaceBoundaryCheck(),
      new SensitivePathCheck({ home, protectedPaths }),
      new ExecutionOwnerCheck(owners),
    ]);
  }

  flowCovers(request) {
    try { return Boolean(this.flow?.covers(request.actionId)); } catch { return false; }
  }

  describeTarget(request) {
    if (request.actionId === 'workspace.command.run') {
      return { cwd: request.target, command_sha256: sha256(String(request.parameters.command)), command_preview: redact(request.parameters.command) };
    }
    return { target: request.target };
  }

  record(kind, request, fields) {
    if (!this.receipts || request.actionId === 'node.ping') return;
    try {
      this.receipts.append(kind, { action_id: request.actionId, digest: request.digest, ...this.describeTarget(request), ...fields });
    } catch (error) {
      this.logger.error(`[muse-node] receipt ${kind}: ${error.message}`);
    }
  }

  // -> { allowed, verdict, reason, approval }
  async authorize(request, { invokeId = null, commandId = null, params = {} } = {}) {
    let decision = this.authority.evaluate(request);
    let approval = null;
    if (!decision.allowed && CONSENT_REASONS.has(decision.reason)) {
      // Do not ask the operator about something the checks will deny
      // anyway (credential path, outside the boundary, wrong owner).
      const precheck = this.sentinel.evaluate(request, new AuthorityDecision(true, 'precheck', 'precheck', request.digest));
      if (precheck.allowed) {
        const ask = { command_id: commandId, params, action_id: request.actionId, target: request.target, digest: request.digest };
        let answer = { approved: false, channel: null };
        if (decision.reason === FLOW_REASON && this.flowCovers(request)) {
          // Flow answers only "granted here, but ask first"; never a missing grant.
          answer = { approved: true, channel: 'flow' };
        } else {
          try {
            answer = normalizeAnswer(await this.approve(ask));
          } catch (error) {
            this.logger.error(`[muse-node] approval dialog failed: ${error.message}`);
          }
        }
        if (answer.approved === true) {
          const flowed = answer.channel === 'flow';
          const token = this.approvals.issue(request, { ttlMs: 60000, mode: flowed ? 'delegated' : 'user' });
          decision = this.authority.evaluate(request, { approvals: this.approvals, approval: token });
          approval = flowed ? 'flow' : answer.channel ? `user:${answer.channel}` : 'user';
          if (flowed && decision.allowed) { try { this.onFlow?.(ask); } catch {} }
        } else {
          decision = new AuthorityDecision(false, '', 'the user did not approve this action', request.digest);
        }
      }
    }
    const verdict = this.sentinel.evaluate(request, decision);
    if (!verdict.allowed) {
      const failed = verdict.checks.filter((check) => !check.passed);
      this.record('DENY', request, { invoke_id: invokeId, command_id: commandId, failed: failed.map(({ name, reason }) => ({ name, reason })) });
      return { allowed: false, verdict, reason: failed.map((check) => `${check.name}: ${check.reason}`).join('; '), approval };
    }
    this.record('EXECUTE', request, { invoke_id: invokeId, command_id: commandId, grant: decision.grantId, approval });
    return { allowed: true, verdict, reason: decision.reason, approval };
  }

  returned(request, { invokeId = null, result }) {
    const ok = result?.ok !== false;
    const output = JSON.stringify(result ?? null);
    this.record('RETURN', request, {
      invoke_id: invokeId, ok, error_code: ok ? null : (result?.error_code ?? 'command_failed'), output_sha256: sha256(output), output_bytes: Buffer.byteLength(output),
    });
  }
}

module.exports = { ActionGate, CONSENT_REASONS, FLOW_REASON };
