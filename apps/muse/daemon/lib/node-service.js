'use strict';

const { JsonStreamParser } = require('./json-stream');

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
  constructor({ rpc, identity, registry, logger = console, heartbeatMs = 15000, version = require('../package.json').version }) {
    this.version = version;
    this.rpc = rpc;
    this.identity = identity;
    this.registry = registry;
    this.logger = logger;
    this.heartbeatMs = heartbeatMs;
    this.heartbeat = null;
    this.subscription = null;
    this.invocations = new Map();
  }

  async start() {
    const parser = new JsonStreamParser();
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
      onStreamError: (error) => this.logger.error(`[muse-node] subscription ended: ${error.message}`),
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
    this.capabilities = await this.registerCapabilities();
    await this.beat();
    this.heartbeat = setInterval(() => this.beat().catch((error) => this.logger.error(`[muse-node] heartbeat: ${error.message}`)), this.heartbeatMs);
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
    return this.rpc.requestJson({ method: 'POST', path: '/api/nodes/heartbeat', params: { node_id: this.identity.nodeId } });
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
    if (!invokeId || !commandId || this.invocations.has(invokeId)) return;
    if (process.env.MUSE_DEBUG_SUBSCRIPTION === '1') {
      this.logger.log(`[muse-node] client.invoke ${commandId} ${invokeId} payload_keys=${Object.keys(payload).join(',')}`);
    }
    const invocation = (async () => {
      let params = {};
      try { params = JSON.parse(payload.params_json ?? payload.payload_json ?? '{}') ?? {}; }
      catch (error) {
        await this.result(invokeId, { ok: false, error_code: 'invalid_params', message: error.message });
        return;
      }
      // /nodes/invoke-ack belongs to the node.register queue and requires a
      // request_id; client.invoke deliveries are acked by their result.
      if (payload.request_id) {
        try {
          await this.rpc.requestJson({ method: 'POST', path: '/nodes/invoke-ack', params: { invoke_id: invokeId, request_id: payload.request_id } });
        } catch (error) {
          this.logger.error(`[muse-node] invoke ack ${invokeId}: ${error.message}`);
        }
      }
      const result = await this.registry.invoke(commandId, params);
      await this.result(invokeId, result);
    })();
    this.invocations.set(invokeId, invocation);
    try { await invocation; } finally { this.invocations.delete(invokeId); }
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
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await Promise.allSettled([...this.invocations.values()]);
  }
}

module.exports = { MuseNodeService, deviceCommands, ARG_TYPES };
