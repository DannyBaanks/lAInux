'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reserveColdLease, coldLeaseSession, noiseToken } = require('../lib/credentials');

const vmId = '123e4567-e89b-42d3-a456-426614174000';

function response(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
}

test('cold lease reservation and session validate exact server shapes', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return response({ ok: true, vmId, created: true });
    return response({ ok: true, session: {
      vmId, vmName: vmId, gatewayUrl: `https://${vmId}/`,
      authToken: ' auth ', noiseNotaryToken: ' notary ', notaryTokenExpirationTs: null,
    } });
  };
  assert.deepEqual(await reserveColdLease(fetchImpl, 'idem'), { vmId, created: true });
  const session = await coldLeaseSession(fetchImpl, vmId);
  assert.equal(session.authToken, 'auth');
  assert.equal(session.noiseNotaryToken, 'notary');
  assert.equal(calls[1].url, `https://muse.ai/api/hatch/cold-lease-cvm?vmId=${vmId}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { idempotencyKey: 'idem' });
});

test('cold lease rejects identity mismatches and missing tokens', async () => {
  const mismatch = async () => response({ ok: true, session: {
    vmId, vmName: vmId, gatewayUrl: 'https://other/', authToken: 'a', noiseNotaryToken: 'n', notaryTokenExpirationTs: null,
  } });
  await assert.rejects(coldLeaseSession(mismatch, vmId), /identity|does not match/);
  const missing = async () => response({ ok: true, session: {
    vmId, vmName: vmId, gatewayUrl: `https://${vmId}/`, authToken: '', noiseNotaryToken: 'n', notaryTokenExpirationTs: null,
  } });
  await assert.rejects(coldLeaseSession(missing, vmId), /authToken/);
});

test('noise token posts vmAddress and force_refresh', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return response({ token: ' token ', notary_token: ' notary ' });
  };
  assert.deepEqual(await noiseToken(fetchImpl, { gatewayUrl: 'https://vm/', vmName: 'vm', forceRefresh: true }), {
    authToken: 'token', noiseNotaryToken: 'notary',
  });
  assert.deepEqual(JSON.parse(request.options.body), { vmAddress: 'https://vm/', vmName: 'vm', force_refresh: true });
});
