'use strict';

const { EMPTY, concat, u8 } = require('./bytes');

const MAX_VARINT_BYTES = 10;

function varint(value) {
  let remaining = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Uint8Array.from(bytes);
}

function tag(field, wireType) {
  return varint((field << 3) | wireType);
}

function fieldVarint(field, value) {
  if (value === undefined || value === null) return EMPTY;
  return concat(tag(field, 0), varint(value));
}

function fieldBytes(field, value) {
  if (value === undefined || value === null) return EMPTY;
  const bytes = u8(value);
  return concat(tag(field, 2), varint(bytes.length), bytes);
}

function fieldString(field, value) {
  if (value === undefined || value === null) return EMPTY;
  return fieldBytes(field, Buffer.from(String(value), 'utf8'));
}

class Reader {
  constructor(bytes) {
    this.bytes = u8(bytes);
    this.offset = 0;
  }

  readVarint() {
    let result = 0n;
    for (let index = 0; index < MAX_VARINT_BYTES; index += 1) {
      if (this.offset >= this.bytes.length) throw new Error('Truncated protobuf varint');
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << BigInt(7 * index);
      if (!(byte & 0x80)) {
        if (index === 9 && byte > 1) throw new Error('Protobuf varint exceeds uint64');
        return result;
      }
    }
    throw new Error('Malformed protobuf varint');
  }

  readKey() {
    if (this.offset >= this.bytes.length) return null;
    const key = Number(this.readVarint());
    return { field: key >>> 3, wireType: key & 7 };
  }

  readBytes() {
    const length = Number(this.readVarint());
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error('Truncated protobuf bytes field');
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(wireType) {
    if (wireType === 0) return void this.readVarint();
    if (wireType === 1) return void (this.offset += 8);
    if (wireType === 2) return void this.readBytes();
    if (wireType === 5) return void (this.offset += 4);
    throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }

  assertInBounds() {
    if (this.offset > this.bytes.length) throw new Error('Truncated protobuf field');
  }
}

function decodeFields(bytes, handlers) {
  const reader = new Reader(bytes);
  while (reader.offset < reader.bytes.length) {
    const key = reader.readKey();
    if (!key || key.field === 0) throw new Error('Invalid protobuf field key');
    const handler = handlers[key.field];
    if (handler) handler(reader, key.wireType);
    else reader.skip(key.wireType);
    reader.assertInBounds();
  }
}

function expectWire(actual, expected, name) {
  if (actual !== expected) throw new Error(`${name}: expected wire type ${expected}, got ${actual}`);
}

function encodeHeader(header) {
  return concat(fieldString(1, header.key ?? ''), fieldString(2, header.value ?? ''));
}

function decodeHeader(bytes) {
  const header = { key: '', value: '' };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 2, 'Header.key'); header.key = Buffer.from(reader.readBytes()).toString('utf8'); },
    2: (reader, wire) => { expectWire(wire, 2, 'Header.value'); header.value = Buffer.from(reader.readBytes()).toString('utf8'); },
  });
  return header;
}

function encodeNoiseFrame({ chunkId = 0n, chunkIndex = 0, totalChunks = 1, payload = EMPTY }) {
  return concat(
    fieldVarint(1, chunkId),
    fieldVarint(2, chunkIndex),
    fieldVarint(3, totalChunks),
    fieldBytes(4, payload),
  );
}

function decodeNoiseFrame(bytes) {
  const frame = { chunkId: 0n, chunkIndex: 0, totalChunks: 1, payload: EMPTY };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 0, 'chunk_id'); frame.chunkId = BigInt.asIntN(64, reader.readVarint()); },
    2: (reader, wire) => { expectWire(wire, 0, 'chunk_index'); frame.chunkIndex = Number(reader.readVarint()); },
    3: (reader, wire) => { expectWire(wire, 0, 'total_chunks'); frame.totalChunks = Number(reader.readVarint()); },
    4: (reader, wire) => { expectWire(wire, 2, 'payload'); frame.payload = reader.readBytes(); },
  });
  return frame;
}

const SERVICES = Object.freeze({
  daemon: 0,
  sentinel: 1,
  vault: 2,
  authd: 3,
  ssh_access: 4,
  yolk: 5,
});

function encodeServiceRequest({ service = 0, payload = EMPTY }) {
  const serviceNumber = typeof service === 'string' ? SERVICES[service] : service;
  if (!Number.isInteger(serviceNumber)) throw new Error(`Unknown Noise service: ${service}`);
  return concat(fieldVarint(1, serviceNumber), fieldBytes(2, payload));
}

function decodeServiceRequest(bytes) {
  const request = { service: 0, payload: EMPTY };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 0, 'service'); request.service = Number(reader.readVarint()); },
    2: (reader, wire) => { expectWire(wire, 2, 'payload'); request.payload = reader.readBytes(); },
  });
  return request;
}

function encodeApplicationRequest(request) {
  const headers = (request.headers ?? []).map((header) => fieldBytes(3, encodeHeader(header)));
  return concat(
    fieldString(1, request.verb ?? ''),
    fieldString(2, request.path ?? ''),
    ...headers,
    fieldBytes(4, request.body ?? EMPTY),
    fieldVarint(5, request.endBody ? 1 : 0),
  );
}

function decodeApplicationRequest(bytes) {
  const request = { verb: '', path: '', headers: [], body: EMPTY, endBody: false };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 2, 'verb'); request.verb = Buffer.from(reader.readBytes()).toString('utf8'); },
    2: (reader, wire) => { expectWire(wire, 2, 'path'); request.path = Buffer.from(reader.readBytes()).toString('utf8'); },
    3: (reader, wire) => { expectWire(wire, 2, 'headers'); request.headers.push(decodeHeader(reader.readBytes())); },
    4: (reader, wire) => { expectWire(wire, 2, 'body'); request.body = reader.readBytes(); },
    5: (reader, wire) => { expectWire(wire, 0, 'end_body'); request.endBody = reader.readVarint() !== 0n; },
  });
  return request;
}

function decodeApplicationResponse(bytes) {
  const response = { status: 0, headers: [], body: EMPTY, endBody: false };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 0, 'status'); response.status = Number(BigInt.asIntN(32, reader.readVarint())); },
    2: (reader, wire) => { expectWire(wire, 2, 'headers'); response.headers.push(decodeHeader(reader.readBytes())); },
    3: (reader, wire) => { expectWire(wire, 2, 'body'); response.body = reader.readBytes(); },
    4: (reader, wire) => { expectWire(wire, 0, 'end_body'); response.endBody = reader.readVarint() !== 0n; },
  });
  return response;
}

function encodeApplicationResponse(response) {
  return concat(
    fieldVarint(1, response.status ?? 0),
    ...(response.headers ?? []).map((header) => fieldBytes(2, encodeHeader(header))),
    fieldBytes(3, response.body ?? EMPTY),
    fieldVarint(4, response.endBody ? 1 : 0),
  );
}

function encodeBodyChunk(chunk) {
  return concat(fieldBytes(1, chunk.data ?? EMPTY), fieldVarint(2, chunk.endBody ? 1 : 0));
}

function decodeBodyChunk(bytes) {
  const chunk = { data: EMPTY, endBody: false };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 2, 'data'); chunk.data = reader.readBytes(); },
    2: (reader, wire) => { expectWire(wire, 0, 'end_body'); chunk.endBody = reader.readVarint() !== 0n; },
  });
  return chunk;
}

function encodeReset(reset) {
  return concat(fieldVarint(1, reset.code ?? 0), fieldString(2, reset.reason ?? ''));
}

function decodeReset(bytes) {
  const reset = { code: 0, reason: '' };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 0, 'code'); reset.code = Number(reader.readVarint()); },
    2: (reader, wire) => { expectWire(wire, 2, 'reason'); reset.reason = Buffer.from(reader.readBytes()).toString('utf8'); },
  });
  return reset;
}

function encodeServiceFrame(frame) {
  const kind = frame.kind;
  let encodedKind = EMPTY;
  if (kind) {
    if (kind.case === 'request') encodedKind = fieldBytes(2, encodeApplicationRequest(kind.value));
    else if (kind.case === 'response') encodedKind = fieldBytes(3, encodeApplicationResponse(kind.value));
    else if (kind.case === 'bodyChunk') encodedKind = fieldBytes(4, encodeBodyChunk(kind.value));
    else if (kind.case === 'reset') encodedKind = fieldBytes(5, encodeReset(kind.value));
    else throw new Error(`Unknown ServiceFrame kind: ${kind.case}`);
  }
  return concat(fieldVarint(1, frame.streamId ?? 0n), encodedKind);
}

function decodeServiceFrame(bytes, { allowRequest = false } = {}) {
  const frame = { streamId: 0n, kind: { case: undefined, value: undefined } };
  decodeFields(bytes, {
    1: (reader, wire) => { expectWire(wire, 0, 'stream_id'); frame.streamId = BigInt.asIntN(64, reader.readVarint()); },
    2: (reader, wire) => {
      expectWire(wire, 2, 'request');
      if (!allowRequest) throw new Error('NoiseTransport: unexpected request frame from server');
      frame.kind = { case: 'request', value: decodeApplicationRequest(reader.readBytes()) };
    },
    3: (reader, wire) => { expectWire(wire, 2, 'response'); frame.kind = { case: 'response', value: decodeApplicationResponse(reader.readBytes()) }; },
    4: (reader, wire) => { expectWire(wire, 2, 'body_chunk'); frame.kind = { case: 'bodyChunk', value: decodeBodyChunk(reader.readBytes()) }; },
    5: (reader, wire) => { expectWire(wire, 2, 'reset'); frame.kind = { case: 'reset', value: decodeReset(reader.readBytes()) }; },
  });
  return frame;
}

module.exports = {
  Reader,
  varint,
  fieldVarint,
  fieldBytes,
  fieldString,
  decodeFields,
  encodeNoiseFrame,
  decodeNoiseFrame,
  encodeServiceRequest,
  decodeServiceRequest,
  encodeServiceFrame,
  decodeServiceFrame,
  decodeApplicationRequest,
  decodeApplicationResponse,
  encodeApplicationResponse,
  SERVICES,
};
