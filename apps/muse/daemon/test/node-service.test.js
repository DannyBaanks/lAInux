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
    definitions: { ping: { description: 'ping', optional: { value: { type: 'integer', description: 'v' }, loud: { type: 'boolean', description: 'b' } }, permission_required: ['x'] } },
    invoke: async (command, params) => (command === 'ping' ? { ok: true, command, echo: params.value } : { ok: false, error_code: 'unknown', message: 'no such command' }),
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
  assert.deepEqual(rpc.subscription.params, { node_id: 'node-linux' });
  await service.handleInvoke({ invoke_id: 'invoke-1', command_id: 'ping', params_json: '{"value":42}' });
  await service.close();
  const registration = calls.find((call) => call.path === '/api/nodes/register');
  assert.equal(registration.params.node_id, 'node-linux');
  assert.equal(registration.params.platform, 'linux');
  assert.ok(!calls.some((call) => call.path === '/nodes/invoke-ack'), 'no request_id, no node-queue ack');
  const result = calls.find((call) => call.path === '/client/invoke-result');
  assert.equal(result.params.invoke_id, 'invoke-1');
  assert.equal(result.params.ok, true);
  assert.deepEqual(JSON.parse(result.params.payload_json), { ok: true, command: 'ping', echo: 42 });
  assert.ok(calls.some((call) => call.path === '/api/nodes/heartbeat'));
  await service.handleInvoke({ invoke_id: 'invoke-2', command_id: 'nope', params_json: '{}' });
  const failed = calls.filter((call) => call.path === '/client/invoke-result').at(-1);
  assert.deepEqual(failed.params, { invoke_id: 'invoke-2', ok: false, error: { code: 'unknown', message: 'no such command' } });
  const caps = calls.find((call) => call.path === '/client/register-capabilities');
  assert.equal(caps.params.client_id, 'node-linux');
  assert.equal(caps.params.platform, 'linux');
  const ping = caps.params.capabilities.device_commands.ping;
  assert.deepEqual(ping.optional.value, { type: 2, description: 'v', enum_values: [] });
  assert.equal(ping.optional.loud.type, 4);
  assert.deepEqual(ping.permissions, ['x']);
});
