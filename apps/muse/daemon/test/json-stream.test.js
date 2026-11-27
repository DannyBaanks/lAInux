'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonStreamParser } = require('../lib/json-stream');

test('subscription parser handles concatenated records and arbitrary UTF-8 splits', () => {
  const source = Buffer.from('{"event":"one","payload":{"text":"a}b"}}\n{"event":"dos","payload":{"emoji":"🦎"}}');
  const parser = new JsonStreamParser();
  const records = [];
  for (const byte of source) records.push(...parser.push(Buffer.from([byte])));
  assert.equal(records.length, 2);
  assert.equal(records[0].payload.text, 'a}b');
  assert.equal(records[1].payload.emoji, '🦎');
  parser.finish();
});

test('subscription parser rejects trailing garbage and oversized records', () => {
  const parser = new JsonStreamParser({ maxRecordBytes: 20 });
  assert.throws(() => parser.push(Buffer.from('{"a":"abcdefghijklmnopqrstuvwxyz"}')), /byte budget/);
  const malformed = new JsonStreamParser();
  assert.throws(() => malformed.push(Buffer.from('not json')), /expected a JSON object/);
});
