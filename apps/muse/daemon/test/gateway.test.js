'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EMPTY } = require('../lib/bytes');
const { connectNoiseGateway } = require('../lib/gateway');
const { NoiseRpcClient, queryPath } = require('../lib/rpc');
const { NoiseXXResponder } = require('../lib/noise');
const { NoiseFrameDecoder, chunkPayload } = require('../lib/transport');
const { decodeServiceFrame, decodeServiceRequest, encodeServiceFrame, encodeServiceResponse } = require('../lib/proto');

class FakeSocket {
  constructor() {
    this.readyState = 0;
    this.listeners = new Map();
    this.peer = null;
    this.sent = [];
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('fake socket is not open');
    const bytes = Buffer.from(data);
    this.sent.push(bytes);
    queueMicrotask(() => this.peer?.emit('message', { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close', { code, reason });
    if (this.peer && this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer.emit('close', { code, reason });
    }
  }
}

async function fakeGateway({ message2 = Buffer.from('attestation'), onRequest } = {}) {
  const clientSocket = new FakeSocket();
  const serverSocket = new FakeSocket();
  clientSocket.peer = serverSocket;
  serverSocket.peer = clientSocket;
  const responder = new NoiseXXResponder();
  responder.initialize();
  let serverSend;
  let serverReceive;
  const decoder = new NoiseFrameDecoder();
  let expectedMessage1;
  const ready = new Promise((resolve) => { expectedMessage1 = resolve; });
  serverSocket.addEventListener('message', ({ data }) => {
    const bytes = Buffer.from(data);
    if (responder.phase === 'initialized') {
      const firstPayload = responder.readMessage1(bytes);
      expectedMessage1(firstPayload);
      serverSocket.send(responder.writeMessage2(message2));
    } else if (responder.phase === 'message2') {
      responder.readMessage3(bytes);
      [serverSend, serverReceive] = responder.split();
    } else {
      const assembled = decoder.decode(serverReceive.decryptWithAd(EMPTY, bytes));
      if (assembled === null) return;
      const envelope = decodeServiceRequest(assembled);
      const request = decodeServiceFrame(envelope.payload, { allowRequest: true });
      const send = (body, status = 200) => {
        const serviceFrame = encodeServiceFrame({
          streamId: request.streamId,
          kind: { case: 'response', value: { status, headers: [], body, endBody: true } },
        });
        for (const frame of chunkPayload(encodeServiceResponse({ payload: serviceFrame }))) {
          serverSocket.send(serverSend.encryptWithAd(EMPTY, frame));
        }
      };
      onRequest?.(request, send);
    }
  });
  queueMicrotask(() => { clientSocket.open(); serverSocket.open(); });
  return { clientSocket, serverSocket, ready };
}

test('gateway performs Noise handshake over a WebSocket and RPC correlates responses', async () => {
  const seen = [];
  const fake = await fakeGateway({
    onRequest(request, send) {
      seen.push(request);
      send(Buffer.from(JSON.stringify({ ok: true, path: request.kind.value.path })));
    },
  });
  const connection = await connectNoiseGateway({
    url: 'wss://gateway.invalid/?vm_id=test',
    createWebSocket: () => fake.clientSocket,
    message1Payload: Buffer.from('fresh-client-nonce'),
    buildMessage3: async (context) => {
      assert.deepEqual(context.message2Payload, Buffer.from('attestation'));
      assert.equal(context.serverStaticPublicKey.length, 32);
      return Buffer.from('rv-client-proof');
    },
  });
  assert.deepEqual(await fake.ready, Buffer.from('fresh-client-nonce'));
  const rpc = new NoiseRpcClient(connection, { appId: 'muse-test' });
  const response = await rpc.requestJson({ method: 'POST', path: '/api/nodes/register', params: { node_id: 'linux', platform: 'linux' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { ok: true, path: '/api/nodes/register' });
  assert.equal(seen.length, 1);
  const request = seen[0].kind.value;
  assert.equal(request.verb, 'POST');
  assert.deepEqual(JSON.parse(Buffer.from(request.body).toString('utf8')), { node_id: 'linux', platform: 'linux' });
  assert.ok(request.headers.some((header) => header.key === 'x-app-id' && header.value === 'muse-test'));
  rpc.close();
  connection.close();
});

test('gateway rejects oversized or modified handshake messages', async () => {
  const fake = await fakeGateway({ message2: Buffer.alloc(20) });
  await assert.rejects(connectNoiseGateway({
    url: 'wss://gateway.invalid/',
    createWebSocket: () => fake.clientSocket,
    maxMessageBytes: 10,
  }), /message too large/);
});

test('RPC surfaces HTTP errors and GET query encoding', async () => {
  const fake = await fakeGateway({ onRequest: (_request, send) => send(Buffer.from('{"error":"denied"}'), 403) });
  const connection = await connectNoiseGateway({ url: 'wss://gateway.invalid/', createWebSocket: () => fake.clientSocket });
  const rpc = new NoiseRpcClient(connection);
  await assert.rejects(rpc.requestJson({ method: 'GET', path: '/api/nodes/list', params: { limit: 2 } }), (error) => {
    assert.equal(error.status, 403);
    assert.deepEqual(error.response, { error: 'denied' });
    return true;
  });
  assert.equal(queryPath('/api/nodes/list', { limit: 2, filter: { online: true } }), '/api/nodes/list?limit=2&filter=%7B%22online%22%3Atrue%7D');
  rpc.close();
  connection.close();
});
