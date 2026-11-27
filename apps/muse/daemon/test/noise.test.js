'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hkdf, NoiseXXInitiator, NoiseXXResponder, deriveRvKey, nonce64 } = require('../lib/noise');
const { handshake } = require('./helpers');

test('Noise XX completes with exact payloads, server static key and bidirectional transport', () => {
  const state = handshake();
  assert.deepEqual(state.firstPayload, Buffer.from('client hello'));
  assert.deepEqual(state.secondPayload, Buffer.from('server proof'));
  assert.deepEqual(state.thirdPayload, Buffer.from('client proof'));
  assert.deepEqual(state.initiator.remoteStaticPublicKey(), state.responder.staticPublicKey());
  assert.equal(state.first.length, 32 + Buffer.byteLength('client hello'));
  assert.equal(state.second.length, 96 + Buffer.byteLength('server proof'));
  assert.equal(state.third.length, 48 + Buffer.byteLength('client proof') + 16);

  const [clientSend, clientReceive] = state.initiatorKeys;
  const [serverSend, serverReceive] = state.responderKeys;
  const request = clientSend.encryptWithAd(Buffer.alloc(0), Buffer.from('ping'));
  assert.deepEqual(serverReceive.decryptWithAd(Buffer.alloc(0), request), Buffer.from('ping'));
  const response = serverSend.encryptWithAd(Buffer.alloc(0), Buffer.from('pong'));
  assert.deepEqual(clientReceive.decryptWithAd(Buffer.alloc(0), response), Buffer.from('pong'));
});

test('handshake rejects modified ciphertext and wrong message ordering', () => {
  const initiator = new NoiseXXInitiator();
  const responder = new NoiseXXResponder();
  initiator.initialize();
  responder.initialize();
  const first = initiator.writeMessage1();
  responder.readMessage1(first);
  const second = responder.writeMessage2(Buffer.from('attestation'));
  second[second.length - 1] ^= 1;
  assert.throws(() => initiator.readMessage2(second), /authenticate|auth|Unsupported state/i);
  assert.throws(() => initiator.writeMessage3(), /dead handshake/);
});

test('AES-GCM nonces match Muse uint64 big-endian convention', () => {
  assert.deepEqual(nonce64(0), Buffer.alloc(12));
  assert.deepEqual(nonce64(1), Buffer.from('000000000000000000000001', 'hex'));
  assert.deepEqual(nonce64(0x0102030405060708n), Buffer.from('000000000102030405060708', 'hex'));
});

test('Noise HKDF emits independent deterministic outputs', () => {
  const [one, two, three] = hkdf(Buffer.alloc(32, 1), Buffer.alloc(32, 2), 3);
  assert.equal(one.length, 32);
  assert.equal(two.length, 32);
  assert.equal(three.length, 32);
  assert.notDeepEqual(one, two);
  assert.notDeepEqual(two, three);
  assert.deepEqual(hkdf(Buffer.alloc(32, 1), Buffer.alloc(32, 2), 2), [one, two]);
});

test('rvKey derivation uses hatch:rv-luks:v1 and validates its inputs', () => {
  const key = deriveRvKey(Buffer.alloc(32, 7), 'vm-test');
  assert.equal(key.length, 32);
  assert.deepEqual(key, deriveRvKey(Buffer.alloc(32, 7), 'vm-test'));
  assert.notDeepEqual(key, deriveRvKey(Buffer.alloc(32, 7), 'vm-other'));
  assert.throws(() => deriveRvKey(Buffer.alloc(31), 'vm-test'), /exactly 32 bytes/);
  assert.throws(() => deriveRvKey(Buffer.alloc(32), ' vm-test '), /VM id/);
});
