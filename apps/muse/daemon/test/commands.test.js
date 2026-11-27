'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommandRegistry, listFiles, readFile, searchFiles } = require('../lib/commands');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-commands-'));
  fs.writeFileSync(path.join(root, 'large.txt'), 'one\ntwo\nthree\nfour\n');
  fs.writeFileSync(path.join(root, 'small.md'), '# hello\n');
  fs.mkdirSync(path.join(root, 'folder'));
  fs.writeFileSync(path.join(root, 'folder', 'nested.txt'), 'nested');
  fs.writeFileSync(path.join(root, '.hidden'), 'secret');
  return root;
}

test('files.list paginates and files.read follows next_offset', (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const listed = listFiles({ path: root, sort: 'name', limit: 2, offset: 0 });
  assert.equal(listed.entries.length, 2);
  assert.equal(listed.total_count, 4);
  assert.equal(listed.next_offset, 2);
  assert.throws(() => listFiles({ path: root, query: 'bad' }), /Unknown parameter/);
  const first = readFile({ path: path.join(root, 'large.txt'), offset: 1, limit: 2 });
  assert.equal(first.content, 'one\ntwo');
  assert.equal(first.next_offset, 3);
  const second = readFile({ path: path.join(root, 'large.txt'), offset: first.next_offset, limit: 2 });
  assert.equal(second.content, 'three\nfour');
  assert.equal(second.next_offset, 5);
});

test('files.search recurses, filters and skips hidden files', (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = searchFiles({ path: root, query: '*.txt', recursive: true });
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.every((entry) => !entry.name.startsWith('.')));
  const shallow = searchFiles({ path: root, query: 'nested', recursive: false });
  assert.equal(shallow.entries.length, 0);
});

test('write and shell commands require explicit approval', async (context) => {
  const root = fixture();
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const denied = createCommandRegistry();
  const target = path.join(root, 'new.txt');
  assert.equal((await denied.invoke('files.write', { path: target, content: 'x' })).error_code, 'permission_denied');
  assert.equal(fs.existsSync(target), false);
  const approved = createCommandRegistry({ approve: async () => true });
  assert.equal((await approved.invoke('files.write', { path: target, content: 'x' })).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'x');
  const execution = await approved.invoke('shell.exec', { command: 'printf linux-node', cwd: root });
  assert.equal(execution.ok, true);
  assert.equal(execution.stdout, 'linux-node');
});

test('registry advertises Mac-compatible files.* command names', () => {
  const registry = createCommandRegistry();
  for (const command of ['files.list', 'files.search', 'files.read', 'files.write', 'files.mkdir', 'system.which', 'ping']) {
    assert.ok(registry.definitions[command], command);
  }
});
