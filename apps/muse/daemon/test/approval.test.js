'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createZenityApprover, describe } = require('../lib/approval');

const quiet = { log() {}, error() {} };

function fakeSpawn(exitCode, calls) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    setImmediate(() => child.emit('exit', exitCode));
    return child;
  };
}

test('zenity OK approves, cancel and timeout deny', async () => {
  for (const [code, expected] of [[0, true], [1, false], [5, false]]) {
    const calls = [];
    const approve = createZenityApprover({ spawnImpl: fakeSpawn(code, calls), env: { DISPLAY: ':0' }, logger: quiet });
    assert.equal(await approve({ command_id: 'shell.exec', params: { command: 'echo hi' } }), expected);
    assert.equal(calls[0].command, 'zenity');
    assert.ok(calls[0].args.includes('--no-markup'));
    assert.ok(calls[0].args.some((arg) => arg.includes('echo hi')));
  }
});

test('no display or spawn error denies without asking', async () => {
  const calls = [];
  assert.equal(await createZenityApprover({ spawnImpl: fakeSpawn(0, calls), env: {}, logger: quiet })({ command_id: 'files.mkdir', params: { path: '/x' } }), false);
  assert.equal(calls.length, 0);
  const broken = () => { const child = new EventEmitter(); setImmediate(() => child.emit('error', new Error('ENOENT'))); return child; };
  assert.equal(await createZenityApprover({ spawnImpl: broken, env: { DISPLAY: ':0' }, logger: quiet })({ command_id: 'files.mkdir', params: { path: '/x' } }), false);
});

test('write preview is bounded and shows size', () => {
  const { body } = describe({ command_id: 'files.write', params: { path: '/tmp/a', content: 'x'.repeat(5000) } });
  assert.match(body, /5000 bytes/);
  assert.ok(body.length < 1000);
});
