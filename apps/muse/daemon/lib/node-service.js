'use strict';

const { JsonStreamParser } = require('./json-stream');
const { InvokeLedger } = require('./invoke-ledger');

// NodeArgType wire codes for client.register_capabilities. string=1 and
// integer=2 are confirmed from the web client's own specs; 3..6 are accepted by
// the gateway (99 is rejected) and follow the usual number/boolean/object/array
// order, inferred, not yet confirmed from a client spec.
const ARG_TYPES = { string: 1, integer: 2, number: 3, boolean: 4, object: 5, array: 6 };

function deviceArgs(args = {}) {
  return Object.fromEntries(Object.entries(args).map(([name, arg]) => [name, {
    type: ARG_TYPES[arg.type] ?? ARG_TYPES.string,
    description: arg.description ?? '',
    enum_values: arg.enum_values ?? [],
  }]));
}

function deviceCommands(definitions) {
  return Object.fromEntries(Object.entries(definitions).map(([id, spec]) => [id, {
    description: spec.description,
    required: deviceArgs(spec.required),
    optional: deviceArgs(spec.optional),
    permissions: spec.permission_required ?? spec.permissions ?? [],
    datatype: spec.datatype ?? 'application/json',
    timeout_ms: spec.timeout_ms ?? 10000,
  }]));
}

class MuseNodeService {
  constructor({
    rpc, identity, registry, logger = console, heartbeatMs = 15000, maxHeartbeatFailures = 3,
    ledger = new InvokeLedger(), status = null, version = require('../package.json').version,
  }) {
    this.version = version;
    this.rpc = rpc;
    this.identity = identity;
    this.registry = registry;
    this.logger = logger;
    this.heartbeatMs = heartbeatMs;
    this.maxHeartbeatFailures = maxHeartbeatFailures;
    this.heartbeatFailures = 0;
    this.heartbeat = null;
    this.subscription = null;
    this.ledger = ledger;
    this.status = status;
    this.closed = false;
    // Resolves (never rejects) with a reason string when this session can no
    // longer receive invokes; the daemon loop then tears it down and reconnects.
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
    this.lostReason = null;
  }

  markLost(reason) {
    if (this.lostReason || this.closed) return;
    this.lostReason = reason;
    this.logger.error(`[muse-node] session lost: ${reason}`);
    this.status?.error(reason);
    this.status?.transition('DEGRADED', reason);
    this.resolveLost(reason);
  }

  async start() {
    const parser = new JsonStreamParser();
    this.status?.transition('CONNECTING', 'gateway session open');
    this.subscription = await this.rpc.subscribe({
      method: 'POST',
      path: '/chat/subscribe',
      params: { node_id: this.identity.nodeId },
      onBodyChunk: async (data) => {
        for (const event of parser.push(data)) {
          if (process.env.MUSE_DEBUG_SUBSCRIPTION === '1') {
            this.logger.log(`[muse-node] event ${event.event ?? event.type ?? '?'} keys=${Object.keys(event).join(',')}`);
          }
          if (event.event === 'client.invoke') this.dispatchInvoke(event.payload);
        }
      },
      // The subscription stream is the only path invokes arrive on: if it ends
      // for any reason (reset or a clean end of body) the node is deaf even
      // though the socket and heartbeats still look healthy.
      onStreamError: (error) => this.markLost(`subscription ended: ${error.message}`),
      onStreamEnd: () => this.markLost('subscription ended by gateway (clean end of stream)'),
    });
    const response = await this.rpc.requestJson({
      method: 'POST',
      path: '/api/nodes/register',
      params: {
        node_id: this.identity.nodeId,
        display_name: this.identity.displayName,
        platform: 'linux',
        commands_v2: this.registry.definitions,
      },
    });
    this.status?.transition('REGISTERED', 'node.register ok');
    this.capabilities = await this.registerCapabilities();
    const expected = Object.keys(this.registry.definitions).length;
    const accepted = this.capabilities?.accepted_device_commands;
    if (accepted === expected && !(this.capabilities?.rejected_ids ?? []).length) {
      this.status?.transition('READY', `${accepted}/${expected} device commands accepted`);
    } else {
      // Visible but unable to receive invokes: say so instead of pretending.
      this.markLost(`capabilities not fully accepted (${accepted ?? 'none'}/${expected}, rejected=${JSON.stringify(this.capabilities?.rejected_ids ?? null)})`);
    }
    await this.beat();
    this.heartbeat = setInterval(() => this.beat().catch(() => {}), this.heartbeatMs);
    return { subscription: this.subscription, registration: response.json };
  }

  // The gateway routes client.invoke only to connections that declared their
  // device_commands through client.register_capabilities (web + Mac clients do
  // this after node.register); node.register alone leaves the node visible but
  // deaf. Failure is logged, not fatal, so the node still appears online.
  async registerCapabilities() {
    try {
      const response = await this.rpc.requestJson({
        method: 'POST',
        path: '/client/register-capabilities',
        params: {
          client_id: this.identity.nodeId,
          platform: 'linux',
          display_name: this.identity.displayName,
          version: this.version,
          capabilities: {
            data_sources: {},
            device_commands: deviceCommands(this.registry.definitions),
            hatch_app_commands: {},
          },
        },
      });
      const ack = response.json ?? {};
      this.logger.log(`[muse-node] capabilities HTTP ${response.status}: ${JSON.stringify(ack)}`);
      return ack;
    } catch (error) {
      this.logger.error(`[muse-node] client.register_capabilities: ${error.message}`);
      return null;
    }
  }

  async beat() {
    try {
      const response = await this.rpc.requestJson({ method: 'POST', path: '/api/nodes/heartbeat', params: { node_id: this.identity.nodeId } });
      this.heartbeatFailures = 0;
      this.status?.heartbeatOk();
      return response;
    } catch (error) {
      this.heartbeatFailures += 1;
      this.logger.error(`[muse-node] heartbeat ${this.heartbeatFailures}/${this.maxHeartbeatFailures}: ${error.message}`);
      if (this.heartbeatFailures >= this.maxHeartbeatFailures) this.markLost(`${this.heartbeatFailures} consecutive heartbeat failures: ${error.message}`);
      throw error;
    }
  }

  // Called from the subscription stream: never await the command there (a slow
  // command would stall every later event) and never let a failure escape into
  // the stream handler.
  dispatchInvoke(payload) {
    this.handleInvoke(payload).catch((error) => this.logger.error(`[muse-node] invoke ${payload?.invoke_id}: ${error.message}`));
  }

  async handleInvoke(payload) {
    const invokeId = payload?.invoke_id;
    const commandId = typeof payload?.command_id === 'string' ? payload.command_id.trim() : '';
    if (!invokeId || !commandId) return;
    if (process.env.MUSE_DEBUG_SUBSCRIPTION === '1') {
      this.logger.log(`[muse-node] client.invoke ${commandId} ${invokeId} payload_keys=${Object.keys(payload).join(',')}`);
    }
    const { result, replayed } = await this.ledger.run(invokeId, async () => {
      let params = {};
      try { params = JSON.parse(payload.params_json ?? payload.payload_json ?? '{}') ?? {}; }
      catch (error) { return { ok: false, error_code: 'invalid_params', message: error.message }; }
      // /nodes/invoke-ack belongs to the node.register queue and requires a
      // request_id; client.invoke deliveries are acked by their result.
      if (payload.request_id) {
        try {
          await this.rpc.requestJson({ method: 'POST', path: '/nodes/invoke-ack', params: { invoke_id: invokeId, request_id: payload.request_id } });
        } catch (error) {
          this.logger.error(`[muse-node] invoke ack ${invokeId}: ${error.message}`);
        }
      }
      return this.registry.invoke(commandId, params);
    });
    if (replayed) this.logger.log(`[muse-node] invoke ${invokeId}: redelivered, replaying stored result (not executed again)`);
    await this.result(invokeId, result);
  }

  // client.invoke.result, shaped like the web client's: success carries
  // payload_json, failure carries {code, message}.
  async result(invokeId, result) {
    const ok = result.ok !== false;
    const params = ok
      ? { invoke_id: invokeId, ok: true, payload_json: JSON.stringify(result) }
      : { invoke_id: invokeId, ok: false, error: { code: result.error_code ?? 'command_failed', message: result.message ?? 'Linux node command failed' } };
    const response = await this.rpc.requestJson({ method: 'POST', path: '/client/invoke-result', params });
    this.logger.log(`[muse-node] invoke ${invokeId}: ok=${ok} HTTP ${response.status}`);
    this.status?.invokeOk(invokeId);
  }

  // Does not wait for running commands: they belong to the shared ledger and
  // finish (or replay on redelivery) in the next session. Waiting here used to
  // hold the reconnect hostage to a 110 s approval dialog.
  async close() {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.resolveLost('closed');
  }
}

module.exports = { MuseNodeService, deviceCommands, ARG_TYPES };
