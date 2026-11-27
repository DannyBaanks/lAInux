'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { brokerRequest, readBrokerConfig, startCredentialBroker } = require('../../client/broker');

test('local shell broker authenticates requests and returns structured errors', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-broker-test-'));
  const socketPath = `\0muse-broker-test-${process.pid}-${Date.now()}`;
  const broker = await startCredentialBroker({
    profile,
    socketPath,
    handler: async (method, params) => {
      if (method === 'session.status') return { ready: true, echo: params.value };
      throw new Error('unknown test method');
    },
  });
  try {
    assert.deepEqual(await brokerRequest(profile, 'session.status', { value: 7 }), { ready: true, echo: 7 });
    await assert.rejects(brokerRequest(profile, 'bad.method'), /unknown test method/);
    const config = readBrokerConfig(profile);
    assert.equal(config.socket, socketPath);
    assert.equal(config.token.length, 43);
    assert.equal(fs.statSync(path.join(profile, 'broker.json')).mode & 0o777, 0o600);
  } finally {
    await broker.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
