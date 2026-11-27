'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MuseNodeService } = require('../lib/node-service');

test('node service registers commands, heartbeats and returns invoke results', async () => {
  const calls = [];
  const rpc = {
    async subscribe(options) { this.subscription = options; return { status: 200, streamId: 1n }; },
    async requestJson(options) {
      calls.push(options);
      if (options.path === '/api/nodes/register') return { status: 200, json: { status: 'registered' } };
      return { status: 200, json: { ok: true } };
    },
  };
  const registry = {
    definitions: { ping: { description: 'ping' } },
    invoke: async (command, params) => ({ ok: true, command, echo: params.value }),
  };
  const logger = { log() {}, error() {} };
  const service = new MuseNodeService({
    rpc,
    identity: { nodeId: 'node-linux', displayName: 'Linux Test' },
    registry,
    logger,
    heartbeatMs: 60000,
  });
  await service.start();
  await service.handleInvoke({ invoke_id: 'invoke-1', command_id: 'ping', params_json: '{"value":42}' });
  await service.close();
  const registration = calls.find((call) => call.path === '/api/nodes/register');
  assert.equal(registration.params.node_id, 'node-linux');
  assert.equal(registration.params.platform, 'linux');
  assert.ok(calls.some((call) => call.path === '/nodes/invoke-ack' && call.params.invoke_id === 'invoke-1'));
  const result = calls.find((call) => call.path === '/nodes/invoke-result');
  assert.equal(result.params.invoke_id, 'invoke-1');
  assert.equal(result.params.ok, true);
  assert.deepEqual(JSON.parse(result.params.payload_json), { ok: true, command: 'ping', echo: 42 });
  assert.ok(calls.some((call) => call.path === '/api/nodes/heartbeat'));
});
