'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { concat } = require('../lib/bytes');
const { decodeFields, decodeNoiseFrame, encodeNoiseFrame, fieldBytes, fieldVarint, varint } = require('../lib/proto');

test('protobuf int64 chunk ids retain sign and skip unknown fields', () => {
  const encoded = concat(
    encodeNoiseFrame({ chunkId: -42n, chunkIndex: 0, totalChunks: 1, payload: Buffer.from('x') }),
    fieldVarint(99, 123456),
    fieldBytes(100, Buffer.from('future')),
  );
  const decoded = decodeNoiseFrame(encoded);
  assert.equal(decoded.chunkId, -42n);
  assert.equal(decoded.chunkIndex, 0);
  assert.equal(decoded.totalChunks, 1);
  assert.deepEqual(decoded.payload, Buffer.from('x'));
});

test('protobuf varints round-trip uint64 boundaries', () => {
  for (const value of [0n, 1n, 127n, 128n, 16384n, (1n << 63n) - 1n, (1n << 64n) - 1n]) {
    const bytes = varint(value);
    let result = null;
    // Read a bare varint through a synthetic field-one handler.
    const input = concat(Uint8Array.of(8), bytes);
    decodeFields(input, { 1: (reader) => { result = reader.readVarint(); } });
    assert.equal(result, value);
  }
});

test('truncated protobuf data is rejected', () => {
  assert.throws(() => decodeNoiseFrame(Buffer.from([0x22, 0x05, 0x01])), /Truncated/);
});
