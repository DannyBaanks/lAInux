'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EMPTY } = require('../lib/bytes');
const { NoiseFrameDecoder, NoiseTransport, chunkPayload, MAX_CHUNK_PAYLOAD } = require('../lib/transport');
const {
  decodeNoiseFrame,
  decodeServiceFrame,
  decodeServiceRequest,
  encodeNoiseFrame,
  encodeServiceFrame,
  encodeServiceRequest,
  encodeServiceResponse,
} = require('../lib/proto');
const { handshake } = require('./helpers');

function decodeServerRequest(receiveCipher, decoder, frames) {
  let envelope = null;
  for (const frame of frames) {
    const assembled = decoder.decode(receiveCipher.decryptWithAd(EMPTY, frame));
    if (assembled !== null) envelope = assembled;
  }
  assert.ok(envelope, 'request should be fully assembled');
  const serviceRequest = decodeServiceRequest(envelope);
  return { envelope: serviceRequest, frame: decodeServiceFrame(serviceRequest.payload, { allowRequest: true }) };
}

function serverResponse(sendCipher, streamId, body) {
  const serviceFrame = encodeServiceFrame({
    streamId,
    kind: { case: 'response', value: { status: 200, headers: [{ key: 'x-test', value: 'yes' }], body, endBody: true } },
  });
  return chunkPayload(encodeServiceResponse({ payload: serviceFrame }))
    .map((frame) => sendCipher.encryptWithAd(EMPTY, frame));
}

test('transport round-trips JSON HTTP request and multi-chunk response', async () => {
  const state = handshake({ message1: EMPTY, message2: EMPTY, message3: EMPTY });
  const client = new NoiseTransport(...state.initiatorKeys);
  const [serverSend, serverReceive] = state.responderKeys;
  const decoder = new NoiseFrameDecoder();
  const requestBody = Buffer.from(JSON.stringify({ node_id: 'linux-test', platform: 'linux' }));
  const { streamId, frames } = await client.encryptHttpRequest({
    service: 'daemon',
    httpMethod: 'POST',
    path: '/api/nodes/register',
    headers: [{ key: 'content-type', value: 'application/json' }],
    body: requestBody,
  });
  assert.equal(streamId, 1n);
  const received = decodeServerRequest(serverReceive, decoder, frames);
  assert.equal(received.envelope.service, 0);
  assert.equal(received.frame.streamId, streamId);
  assert.equal(received.frame.kind.case, 'request');
  assert.equal(received.frame.kind.value.verb, 'POST');
  assert.equal(received.frame.kind.value.path, '/api/nodes/register');
  assert.equal(received.frame.kind.value.endBody, true);
  assert.deepEqual(received.frame.kind.value.body, requestBody);

  // decodeServiceFrame intentionally rejects requests on a client transport;
  // inspect the request through its protobuf fields for this loopback test.
  const responseBody = cryptoRandom(140000);
  const responseFrames = serverResponse(serverSend, streamId, responseBody);
  assert.equal(responseFrames.length, 3);
  let response = null;
  for (const frame of responseFrames) response = (await client.decryptFrame(frame)) ?? response;
  assert.equal(response.case, 'response');
  assert.equal(response.streamId, streamId);
  assert.equal(response.response.status, 200);
  assert.equal(response.response.endBody, true);
  assert.deepEqual(response.response.headers, [{ key: 'x-test', value: 'yes' }]);
  assert.deepEqual(response.response.body, responseBody);
});

test('large requests are chunked at 65489 bytes and reassembled in order', async () => {
  const state = handshake({ message1: EMPTY, message2: EMPTY, message3: EMPTY });
  const client = new NoiseTransport(...state.initiatorKeys);
  const decoder = new NoiseFrameDecoder();
  const body = cryptoRandom(MAX_CHUNK_PAYLOAD * 2 + 17);
  const { frames } = await client.encryptHttpRequest({
    httpMethod: 'POST', path: '/upload', body, service: 'yolk',
  });
  assert.equal(frames.length, 3);
  const plaintextFrames = frames.map((frame) => state.responderKeys[1].decryptWithAd(EMPTY, frame));
  const decoded = plaintextFrames.map(decodeNoiseFrame);
  assert.deepEqual(decoded.map((frame) => frame.chunkIndex), [0, 1, 2]);
  assert.ok(decoded.every((frame) => frame.chunkId === decoded[0].chunkId));
  assert.ok(decoded.every((frame) => frame.totalChunks === 3));
  // Deliberately reorder encrypted frames: Noise nonce order must reject this.
  assert.throws(() => decoder.decode(state.responderKeys[1].decryptWithAd(EMPTY, frames[1])));
});

test('stream requests, body chunks and resets preserve stream ids', async () => {
  const state = handshake({ message1: EMPTY, message2: EMPTY, message3: EMPTY });
  const client = new NoiseTransport(...state.initiatorKeys);
  const decoder = new NoiseFrameDecoder();
  const { streamId, frames } = await client.startStreamRequest({ httpMethod: 'POST', path: '/stream' });
  const start = decodeServerRequest(state.responderKeys[1], decoder, frames);
  assert.equal(start.frame.kind.value.endBody, false);
  assert.equal(start.frame.kind.value.body.length, 0);
  const chunks = await client.encryptBodyChunk({ streamId, data: Buffer.from('chunk'), endBody: true });
  const body = decodeServerRequest(state.responderKeys[1], decoder, chunks);
  assert.equal(body.frame.kind.case, 'bodyChunk');
  assert.deepEqual(body.frame.kind.value.data, Buffer.from('chunk'));
  assert.equal(body.frame.kind.value.endBody, true);
  const resetFrames = await client.encryptReset({ streamId, reason: 'cancelled by test' });
  const reset = decodeServerRequest(state.responderKeys[1], decoder, resetFrames);
  assert.equal(reset.frame.kind.case, 'reset');
  assert.equal(reset.frame.kind.value.code, 1);
  assert.equal(reset.frame.kind.value.reason, 'cancelled by test');
});

test('frame decoder enforces chunk limits and poisons after malformed input', () => {
  const decoder = new NoiseFrameDecoder();
  assert.throws(() => decoder.decode(encodeNoiseFrame({ chunkId: 1n, chunkIndex: 2, totalChunks: 1, payload: EMPTY })), /out of range/);
  assert.throws(() => decoder.decode(encodeNoiseFrame({ chunkId: 1n, chunkIndex: 0, totalChunks: 1, payload: EMPTY })), /poisoned/);
});

function cryptoRandom(length) {
  return require('node:crypto').randomBytes(length);
}
