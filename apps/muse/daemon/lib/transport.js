'use strict';

const crypto = require('node:crypto');
const { EMPTY, concat } = require('./bytes');
const {
  decodeNoiseFrame,
  decodeServiceFrame,
  decodeServiceResponse,
  encodeNoiseFrame,
  encodeServiceFrame,
  encodeServiceRequest,
} = require('./proto');

const MAX_CHUNK_PAYLOAD = 65489;
const MAX_CHUNKS = 256;
const MAX_ASSEMBLIES = 16;
const MAX_ASSEMBLY_BYTES = 0x1000000;

class NoiseFrameDecoder {
  constructor() {
    this.pending = new Map();
    this.poisoned = false;
  }

  decode(bytes) {
    if (this.poisoned) throw new Error('NoiseFrameDecoder: poisoned after prior failure');
    try {
      const { chunkId, chunkIndex, totalChunks, payload } = decodeNoiseFrame(bytes);
      if (chunkId < -(1n << 63n) || chunkId > (1n << 63n) - 1n) {
        throw new Error(`chunkId outside int64 range: ${chunkId}`);
      }
      if (totalChunks < 1 || totalChunks > MAX_CHUNKS) throw new Error(`invalid totalChunks: ${totalChunks}`);
      if (chunkIndex < 0 || chunkIndex >= totalChunks) {
        throw new Error(`chunkIndex ${chunkIndex} out of range [0, ${totalChunks})`);
      }
      if (payload.length > MAX_CHUNK_PAYLOAD) {
        throw new Error(`payload too large for noise frame (${payload.length} bytes)`);
      }
      const key = chunkId.toString();
      if (!this.pending.has(key)) {
        if (this.pending.size >= MAX_ASSEMBLIES) throw new Error('too many pending noise frame assemblies');
        this.pending.set(key, { chunks: new Map(), total: totalChunks, totalBytes: 0 });
      }
      const assembly = this.pending.get(key);
      if (assembly.total !== totalChunks) {
        this.pending.delete(key);
        throw new Error(`inconsistent totalChunks for chunkId: expected ${assembly.total}, got ${totalChunks}`);
      }
      if (assembly.chunks.has(chunkIndex)) {
        this.pending.delete(key);
        throw new Error(`duplicate chunkIndex ${chunkIndex}`);
      }
      assembly.totalBytes += payload.length;
      if (assembly.totalBytes > MAX_ASSEMBLY_BYTES) {
        this.pending.delete(key);
        throw new Error('assembly exceeded byte budget');
      }
      assembly.chunks.set(chunkIndex, payload);
      if (assembly.chunks.size < assembly.total) return null;
      this.pending.delete(key);
      if (assembly.total === 1) return assembly.chunks.get(0);
      const ordered = [];
      for (let index = 0; index < assembly.total; index += 1) {
        const chunk = assembly.chunks.get(index);
        if (!chunk) throw new Error(`missing chunk ${index}/${assembly.total}`);
        ordered.push(chunk);
      }
      return concat(...ordered);
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }
}

function chunkPayload(payload) {
  const chunkId = crypto.randomBytes(8).readBigInt64LE(0);
  const totalChunks = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_PAYLOAD));
  if (totalChunks > MAX_CHUNKS) {
    throw new Error(`payload too large for noise framing (${payload.length} bytes, ${totalChunks} chunks > ${MAX_CHUNKS})`);
  }
  if (payload.length === 0) return [encodeNoiseFrame({ chunkId, chunkIndex: 0, totalChunks: 1, payload: EMPTY })];
  const frames = [];
  for (let index = 0; index < totalChunks; index += 1) {
    const start = MAX_CHUNK_PAYLOAD * index;
    frames.push(encodeNoiseFrame({
      chunkId,
      chunkIndex: index,
      totalChunks,
      payload: payload.subarray(start, Math.min(start + MAX_CHUNK_PAYLOAD, payload.length)),
    }));
  }
  return frames;
}

class NoiseTransport {
  constructor(sendCipher, receiveCipher) {
    this.sendCipher = sendCipher;
    this.receiveCipher = receiveCipher;
    this.decoder = new NoiseFrameDecoder();
    this.nextStreamId = 1n;
    this.dead = false;
  }

  assertLive() {
    if (this.dead) throw new Error('NoiseTransport: dead after prior failure');
  }

  async encryptHttpRequest(request) {
    return this.encryptRequest({ ...request, endBody: true });
  }

  async startStreamRequest(request) {
    return this.encryptRequest({ ...request, body: EMPTY, endBody: false });
  }

  async encryptRequest(request) {
    this.assertLive();
    try {
      const streamId = this.nextStreamId++;
      const frame = encodeServiceFrame({
        streamId,
        kind: {
          case: 'request',
          value: {
            verb: request.httpMethod,
            path: request.path,
            headers: request.headers ?? [],
            body: request.body ?? EMPTY,
            endBody: request.endBody,
          },
        },
      });
      const frames = await this.encryptEnvelope(request.service ?? 'daemon', frame);
      return { streamId, frames };
    } catch (error) {
      this.dead = true;
      throw error;
    }
  }

  async encryptBodyChunk({ streamId, data, endBody = false, service = 'daemon' }) {
    this.assertLive();
    try {
      return await this.encryptEnvelope(service, encodeServiceFrame({
        streamId,
        kind: { case: 'bodyChunk', value: { data, endBody } },
      }));
    } catch (error) {
      this.dead = true;
      throw error;
    }
  }

  async encryptReset({ streamId, reason = '', service = 'daemon' }) {
    this.assertLive();
    try {
      return await this.encryptEnvelope(service, encodeServiceFrame({
        streamId,
        kind: { case: 'reset', value: { code: 1, reason } },
      }));
    } catch (error) {
      this.dead = true;
      throw error;
    }
  }

  async encryptEnvelope(service, serviceFrame) {
    const envelope = encodeServiceRequest({ service, payload: serviceFrame });
    const frames = chunkPayload(envelope);
    const encrypted = [];
    for (const frame of frames) encrypted.push(this.sendCipher.encryptWithAd(EMPTY, frame));
    return encrypted;
  }

  async decryptFrame(encryptedFrame) {
    this.assertLive();
    try {
      const plaintext = this.receiveCipher.decryptWithAd(EMPTY, encryptedFrame);
      const assembled = this.decoder.decode(plaintext);
      if (assembled === null) return null;
      const envelope = decodeServiceResponse(assembled);
      if (envelope.payload.length === 0) throw new Error('empty ServiceResponse payload');
      const frame = decodeServiceFrame(envelope.payload);
      if (frame.kind.case === 'response') {
        return { case: 'response', streamId: frame.streamId, response: frame.kind.value };
      }
      if (frame.kind.case === 'bodyChunk') {
        return {
          case: 'bodyChunk',
          streamId: frame.streamId,
          data: frame.kind.value.data,
          endBody: frame.kind.value.endBody,
        };
      }
      if (frame.kind.case === 'reset') {
        return { case: 'reset', streamId: frame.streamId, reset: frame.kind.value };
      }
      return null;
    } catch (error) {
      this.dead = true;
      throw error;
    }
  }
}

module.exports = {
  MAX_CHUNK_PAYLOAD,
  NoiseFrameDecoder,
  NoiseTransport,
  chunkPayload,
};
