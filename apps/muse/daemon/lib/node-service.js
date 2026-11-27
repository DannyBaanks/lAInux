'use strict';

const { JsonStreamParser } = require('./json-stream');

class MuseNodeService {
  constructor({ rpc, identity, registry, logger = console, heartbeatMs = 15000 }) {
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
      params: {},
      onBodyChunk: async (data) => {
        for (const event of parser.push(data)) {
          if (event.event === 'client.invoke') await this.handleInvoke(event.payload);
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
    await this.beat();
    this.heartbeat = setInterval(() => this.beat().catch((error) => this.logger.error(`[muse-node] heartbeat: ${error.message}`)), this.heartbeatMs);
    return { subscription: this.subscription, registration: response.json };
  }

  async beat() {
    return this.rpc.requestJson({ method: 'POST', path: '/api/nodes/heartbeat', params: { node_id: this.identity.nodeId } });
  }

  async handleInvoke(payload) {
    const invokeId = payload?.invoke_id;
    const commandId = payload?.command_id;
    if (!invokeId || !commandId || this.invocations.has(invokeId)) return;
    const invocation = (async () => {
      let params = {};
      try { params = JSON.parse(payload.params_json ?? payload.payload_json ?? '{}'); }
      catch (error) {
        await this.result(invokeId, { ok: false, error_code: 'invalid_params', message: error.message });
        return;
      }
      try {
        await this.rpc.requestJson({ method: 'POST', path: '/nodes/invoke-ack', params: { invoke_id: invokeId } });
      } catch (error) {
        this.logger.error(`[muse-node] invoke ack ${invokeId}: ${error.message}`);
      }
      const result = await this.registry.invoke(commandId, params);
      await this.result(invokeId, result);
    })();
    this.invocations.set(invokeId, invocation);
    try { await invocation; } finally { this.invocations.delete(invokeId); }
  }

  async result(invokeId, result) {
    const response = await this.rpc.requestJson({
      method: 'POST',
      path: '/nodes/invoke-result',
      params: {
        invoke_id: invokeId,
        ok: result.ok !== false,
        payload_json: JSON.stringify(result),
      },
    });
    this.logger.log(`[muse-node] invoke ${invokeId}: ok=${result.ok !== false} HTTP ${response.status}`);
  }

  async close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    await Promise.allSettled([...this.invocations.values()]);
  }
}

module.exports = { MuseNodeService };
