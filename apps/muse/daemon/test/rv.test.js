'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { concat } = require('../lib/bytes');
const { fieldBytes, fieldString } = require('../lib/proto');
const { createClientHello, decodeRvChallenge, encodeRvChallenge, buildRvMessage3, STANDARD_CLIENT_HELLO } = require('../lib/rv');

const M = Buffer.alloc(32, 0x11);
const P = Buffer.alloc(32, 0x22);
const nonce = Buffer.alloc(32, 0x33);
const vmNonce = Buffer.alloc(32, 0x44);
const rvKey = Buffer.alloc(32, 0x55);
const mac = (key, ...parts) => crypto.createHmac('sha256', key).update(concat(...parts)).digest();

function vmProof() {
  const key = mac(rvKey, Buffer.from('hatch.noise-auth.key.v1'), Buffer.from('vm-proof-key'));
  return mac(key, Buffer.from('hatch.noise-auth.vm-proof.v1'), M, nonce, vmNonce);
}

test('RV msg1 is exactly 0a 20 + 32-byte nonce and standard fallback is field 2 = 1', () => {
  const hello = createClientHello();
  assert.equal(hello.clientNonce.length, 32);
  assert.equal(hello.payload.length, 34);
  assert.deepEqual(hello.payload.subarray(0, 2), Buffer.from([0x0a, 0x20]));
  assert.deepEqual(hello.payload.subarray(2), hello.clientNonce);
  assert.deepEqual(STANDARD_CLIENT_HELLO, Buffer.from([0x10, 0x01]));
});

test('RV challenge decodes unprovisioned/provisioned and rejects invalid shapes', () => {
  const unprovisioned = { attestation: Buffer.from('report'), state: 'unprovisioned', vmNonce };
  const decoded = decodeRvChallenge(encodeRvChallenge(unprovisioned));
  assert.equal(decoded.state, 'unprovisioned');
  assert.deepEqual(decoded.attestation, Buffer.from('report'));
  assert.deepEqual(decoded.vmNonce, vmNonce);
  assert.equal(decoded.vmProof, null);
  const provisioned = { ...unprovisioned, state: 'provisioned', vmProof: vmProof() };
  assert.equal(decodeRvChallenge(encodeRvChallenge(provisioned)).state, 'provisioned');
  assert.equal(decodeRvChallenge(Buffer.from('raw attestation')), null);
  assert.equal(decodeRvChallenge(encodeRvChallenge({ ...unprovisioned, vmNonce: Buffer.alloc(31) })), null);
  assert.equal(decodeRvChallenge(encodeRvChallenge({ ...unprovisioned, vmProof: Buffer.alloc(32) })), null);
});

test('unprovisioned msg3 reveals fresh rvKey only with chip+host verdict', () => {
  const challenge = decodeRvChallenge(encodeRvChallenge({ attestation: Buffer.from('r'), state: 'unprovisioned', vmNonce }));
  const message = buildRvMessage3({
    challenge, rvKey, notaryToken: ' token ', clientNonce: nonce,
    message1HandshakeHash: M, handshakeHash: P,
    attestationVerdict: 'accepted_chip_and_host_data_bound',
  });
  assert.deepEqual(message, concat(fieldString(1, 'token'), fieldBytes(2, rvKey)));
  assert.throws(() => buildRvMessage3({
    challenge, rvKey, notaryToken: 'token', clientNonce: nonce,
    message1HandshakeHash: M, handshakeHash: P,
    attestationVerdict: 'accepted_host_data_bound',
  }), /accepted_chip_and_host_data_bound/);
  assert.throws(() => buildRvMessage3({
    challenge, rvKey, notaryToken: 'token', clientNonce: nonce,
    message1HandshakeHash: M, handshakeHash: P,
  }), /attestation verdict/);
});

test('provisioned msg3 verifies VM proof and emits client proof with reversed nonce order', () => {
  const challenge = decodeRvChallenge(encodeRvChallenge({
    attestation: Buffer.from('r'), state: 'provisioned', vmNonce, vmProof: vmProof(),
  }));
  const message = buildRvMessage3({
    challenge, rvKey, notaryToken: 'token', clientNonce: nonce,
    message1HandshakeHash: M, handshakeHash: P,
    attestationVerdict: 'accepted_host_data_bound',
  });
  const clientKey = mac(rvKey, Buffer.from('hatch.noise-auth.key.v1'), Buffer.from('client-proof-key'));
  const expected = mac(clientKey, Buffer.from('hatch.noise-auth.client-proof.v1'), P, vmNonce, nonce);
  assert.deepEqual(message, concat(fieldString(1, 'token'), fieldBytes(3, expected)));
  const bad = decodeRvChallenge(encodeRvChallenge({
    attestation: Buffer.from('r'), state: 'provisioned', vmNonce, vmProof: Buffer.alloc(32),
  }));
  assert.throws(() => buildRvMessage3({
    challenge: bad, rvKey, notaryToken: 'token', clientNonce: nonce,
    message1HandshakeHash: M, handshakeHash: P,
    attestationVerdict: 'accepted_host_data_bound',
  }), /VM proof/);
});
