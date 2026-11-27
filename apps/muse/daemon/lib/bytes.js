'use strict';

const { timingSafeEqual } = require('node:crypto');

const EMPTY = new Uint8Array(0);

function u8(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError('Expected bytes');
}

function concat(...values) {
  return Buffer.concat(values.map((value) => Buffer.from(u8(value))));
}

function copy(value) {
  return new Uint8Array(u8(value));
}

function equal(left, right) {
  const a = u8(left);
  const b = u8(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

module.exports = { EMPTY, u8, concat, copy, equal };
