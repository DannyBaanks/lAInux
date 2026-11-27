'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGatewayUrl, vmIdFromGatewayUrl } = require('../lib/gateway-url');

test('primary gateway uses fixed shared ingress and exact query fields', () => {
  const url = new URL(buildGatewayUrl({
    gatewayUrl: 'https://vm-test/', authToken: 'auth', notaryToken: 'notary',
    requestId: 'request', appId: 'hatch-web',
  }));
  assert.equal(url.origin, 'wss://hatch.metaaivm.com');
  assert.equal(url.pathname, '/v1/noise');
  assert.deepEqual([...url.searchParams.keys()], ['vm_id', 'auth_token', 'notary_token', 'app_id', 'app_version', 'request_id']);
  assert.equal(url.searchParams.get('vm_id'), 'vm-test');
  assert.equal(url.searchParams.get('auth_token'), 'auth');
  assert.equal(url.searchParams.get('notary_token'), 'notary');
  assert.equal(url.searchParams.get('app_version'), '2');
});

test('vm identity validates host, vm_id and vmName agreement', () => {
  assert.equal(vmIdFromGatewayUrl('https://vm-test/?vm_id=vm-test', 'vm-test'), 'vm-test');
  assert.throws(() => vmIdFromGatewayUrl('https://vm-test/?vm_id=other', 'vm-test'), /does not match/);
  assert.throws(() => vmIdFromGatewayUrl('https://vm-test/?other=1'), /unexpected query/);
  assert.throws(() => vmIdFromGatewayUrl('not a url'), /Invalid/);
});
