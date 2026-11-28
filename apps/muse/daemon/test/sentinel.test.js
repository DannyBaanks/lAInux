'use strict';

// Phase 1 gates (lAInux.mods COMPOSE §5). Negative tests use unique canary
// paths and check their absence independently of the command's own answer.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCommandRegistry, minimalEnv, OWNERS } = require('../lib/commands');
const { ActionRequest, IsySentinel, AuthorityDecision, canonicalJson } = require('../lib/security');
const { WorkspaceAuthority, ActionApprovalStore } = require('../lib/workspace-authority');
const { ReceiptLog } = require('../lib/receipts');

const quiet = { log() {}, error() {} };

function world(context) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-sentinel-')));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'home');
  fs.mkdirSync(path.join(root, 'Documents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Private'), { recursive: true });
  fs.mkdirSync(path.join(root, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(root, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  fs.writeFileSync(path.join(root, 'Documents', 'notes.txt'), 'hola');
  fs.writeFileSync(path.join(root, 'Private', 'diary.txt'), 'secret diary');
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'file.txt'), 'outside');
  const authority = new WorkspaceAuthority({ root, stateDirectory: path.join(base, 'state') });
  const receipts = new ReceiptLog({ file: path.join(base, 'state', 'receipts', 'r.jsonl') });
  const asked = [];
  let answer = false;
  const approve = async (request) => { asked.push(request); return answer; };
  const registry = createCommandRegistry({ approve, authority, receipts, logger: quiet });
  return { base, root, authority, receipts, registry, asked, setAnswer: (value) => { answer = value; } };
}

const canary = (dir) => path.join(dir, `canary-${crypto.randomBytes(6).toString('hex')}.txt`);

test('deny by default: ungranted read asks; a no is a denial with no effect', async (context) => {
  const w = world(context);
  const denied = await w.registry.invoke('files.read', { path: path.join(w.root, 'Documents', 'notes.txt') });
  assert.equal(denied.error_code, 'permission_denied');
  assert.equal(w.asked.length, 1, 'the operator was asked once');
});

test('granted folder reads are quiet; outside the granted folder asks again', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.read', { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  const ok = await w.registry.invoke('files.read', { path: path.join(w.root, 'Documents', 'notes.txt') });
  assert.equal(ok.content, 'hola');
  assert.equal(w.asked.length, 0, 'no dialog inside the grant');
  const other = await w.registry.invoke('files.read', { path: path.join(w.root, 'Private', 'diary.txt') });
  assert.equal(other.error_code, 'permission_denied');
  assert.equal(w.asked.length, 1);
});

test('authorized write produces the effect; rejected write produces none', async (context) => {
  const w = world(context);
  const yes = canary(path.join(w.root, 'Documents'));
  w.setAnswer(true);
  assert.equal((await w.registry.invoke('files.write', { path: yes, content: 'si' })).ok, true);
  assert.equal(fs.readFileSync(yes, 'utf8'), 'si');
  const no = canary(path.join(w.root, 'Documents'));
  w.setAnswer(false);
  const result = await w.registry.invoke('files.write', { path: no, content: 'no' });
  assert.equal(result.error_code, 'permission_denied');
  assert.equal(fs.existsSync(no), false, 'rejected canary must not exist');
});

test('grant + approvalRequired: a write grant alone never writes without a fresh approval', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  const target = canary(path.join(w.root, 'Documents'));
  assert.equal((await w.registry.invoke('files.write', { path: target, content: 'x' })).error_code, 'permission_denied');
  assert.equal(fs.existsSync(target), false);
  assert.equal(w.asked.length, 1);
});

test('expired approval does not authorize', (context) => {
  const w = world(context);
  let now = 1_000_000;
  const approvals = new ActionApprovalStore({ now: () => now });
  const request = new ActionRequest({ actionId: 'workspace.files.write', workspaceRoot: w.root, target: path.join(w.root, 'Documents', 'x'), executionOwner: OWNERS['workspace.files.write'] });
  const approval = approvals.issue(request, { ttlMs: 60000 });
  now += 61000;
  assert.equal(w.authority.evaluate(request, { approvals, approval }).allowed, false);
});

test('an approval is single-use', (context) => {
  const w = world(context);
  const approvals = new ActionApprovalStore();
  const request = new ActionRequest({ actionId: 'workspace.files.write', workspaceRoot: w.root, target: path.join(w.root, 'Documents', 'x'), executionOwner: OWNERS['workspace.files.write'] });
  const approval = approvals.issue(request);
  assert.equal(w.authority.evaluate(request, { approvals, approval }).allowed, true);
  assert.equal(w.authority.evaluate(request, { approvals, approval }).allowed, false, 'reuse rejected');
});

test('changing the arguments after approval is rejected (digest binding)', (context) => {
  const w = world(context);
  const approvals = new ActionApprovalStore();
  const owner = OWNERS['workspace.command.run'];
  const approved = new ActionRequest({ actionId: 'workspace.command.run', workspaceRoot: w.root, target: w.root, parameters: { command: 'ls' }, executionOwner: owner });
  const approval = approvals.issue(approved);
  const tampered = new ActionRequest({ actionId: 'workspace.command.run', workspaceRoot: w.root, target: w.root, parameters: { command: 'ls; rm -rf ~' }, executionOwner: owner });
  assert.notEqual(approved.digest, tampered.digest);
  assert.equal(w.authority.evaluate(tampered, { approvals, approval }).allowed, false);
});

test('file changed between approval and execution => refused, no overwrite', async (context) => {
  const w = world(context);
  const target = path.join(w.root, 'Documents', 'notes.txt');
  w.registry.gate.approve = async () => { fs.writeFileSync(target, 'edited by the user meanwhile'); return true; };
  const result = await w.registry.invoke('files.write', { path: target, content: 'model content' });
  assert.equal(result.error_code, 'target_changed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'edited by the user meanwhile');
});

test('outside the workspace boundary is denied without asking', async (context) => {
  const w = world(context);
  w.setAnswer(true);
  const read = await w.registry.invoke('files.read', { path: path.join(w.base, 'outside', 'file.txt') });
  assert.equal(read.error_code, 'permission_denied');
  const target = canary(path.join(w.base, 'outside'));
  await w.registry.invoke('files.write', { path: target, content: 'x' });
  await w.registry.invoke('files.write', { path: path.join(w.root, '..', 'outside', path.basename(target)), content: 'x' });
  assert.equal(fs.existsSync(target), false);
  assert.equal(w.asked.length, 0);
});

test('credentials through a symlink are denied, even approved and even inside a grant', async (context) => {
  const w = world(context);
  for (const actionId of ['workspace.files.read', 'workspace.files.search']) {
    w.authority.setGrant(actionId, { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  }
  fs.symlinkSync(path.join(w.root, '.ssh', 'id_ed25519'), path.join(w.root, 'Documents', 'innocent.txt'));
  fs.symlinkSync(path.join(w.root, '.ssh'), path.join(w.root, 'Documents', 'keys'));
  w.setAnswer(true);
  for (const target of ['innocent.txt', 'keys/id_ed25519']) {
    const result = await w.registry.invoke('files.read', { path: path.join(w.root, 'Documents', target) });
    assert.equal(result.error_code, 'permission_denied', target);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE KEY/);
  }
  const search = await w.registry.invoke('files.search', { path: path.join(w.root, 'Documents'), query: 'id_ed25519' });
  assert.equal(search.entries.length, 0, 'search does not follow a symlinked folder into ~/.ssh');
  assert.equal(w.asked.length, 0, 'never asked about a credential path');
});

test('the model cannot grant itself: authority state is a protected path', async (context) => {
  const w = world(context);
  w.setAnswer(true);
  const result = await w.registry.invoke('files.write', { path: w.authority.policyPath, content: '{"grants":{}}' });
  assert.equal(result.error_code, 'permission_denied');
  assert.equal(fs.existsSync(w.authority.policyPath), false);
});

test('revoke is immediate and denies without asking; lock denies everything but ping', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.read', { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  const file = path.join(w.root, 'Documents', 'notes.txt');
  assert.equal((await w.registry.invoke('files.read', { path: file })).ok, true);
  w.authority.setGrant('workspace.files.read', { enabled: false, pathPrefixes: [] });
  w.setAnswer(true);
  assert.equal((await w.registry.invoke('files.read', { path: file })).error_code, 'permission_denied');
  assert.equal(w.asked.length, 0, 'an explicit revoke is not re-asked');
  w.authority.setLocked(true);
  assert.equal((await w.registry.invoke('files.list', { path: path.join(w.root, 'Documents') })).error_code, 'permission_denied');
  assert.equal((await w.registry.invoke('ping', {})).ok, true);
});

test('an insecure policy file denies everything (fail closed)', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.read', { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  fs.chmodSync(w.authority.policyPath, 0o644);
  w.setAnswer(true);
  assert.equal((await w.registry.invoke('files.read', { path: path.join(w.root, 'Documents', 'notes.txt') })).error_code, 'permission_denied');
});

test('Sentinel denies on empty check set, foreign digest and throwing checks', (context) => {
  const w = world(context);
  const request = new ActionRequest({ actionId: 'node.ping', workspaceRoot: w.root, executionOwner: OWNERS['node.ping'] });
  const ok = new AuthorityDecision(true, 'g', 'r', request.digest);
  assert.equal(new IsySentinel([]).evaluate(request, ok).status, 'DENY');
  assert.equal(new IsySentinel([{ name: 'x', evaluate: () => ({ name: 'x', passed: true, reason: '' }) }]).evaluate(request, new AuthorityDecision(true, 'g', 'r', 'other')).status, 'DENY');
  assert.equal(new IsySentinel([{ name: 'boom', evaluate: () => { throw new Error('secret'); } }]).evaluate(request, ok).status, 'DENY');
  assert.equal(new IsySentinel([{ name: 'x', evaluate: () => ({ name: 'x', passed: true, reason: '' }) }]).evaluate(request, ok).status, 'ALLOW');
});

test('digest matches ISyCode canonical form', () => {
  assert.equal(canonicalJson({ b: [1, { d: 'ñ', c: null }], a: true }), '{"a":true,"b":[1,{"c":null,"d":"ñ"}]}');
});

test('shell.exec gets a minimal environment with no inherited secrets', async (context) => {
  const w = world(context);
  process.env.MUSE_TEST_SECRET_TOKEN = 'sk-should-not-leak';
  context.after(() => { delete process.env.MUSE_TEST_SECRET_TOKEN; });
  assert.equal(minimalEnv().MUSE_TEST_SECRET_TOKEN, undefined);
  w.setAnswer(true);
  const result = await w.registry.invoke('shell.exec', { command: 'env', cwd: w.root });
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.stdout, /sk-should-not-leak/);
});

test('receipts: DENY / EXECUTE / RETURN, hash-chained, no file content stored', async (context) => {
  const w = world(context);
  w.setAnswer(false);
  await w.registry.invoke('files.write', { path: canary(path.join(w.root, 'Documents')), content: 'TOP-SECRET-CONTENT' }, { invokeId: 'i-1' });
  w.setAnswer(true);
  await w.registry.invoke('files.write', { path: canary(path.join(w.root, 'Documents')), content: 'TOP-SECRET-CONTENT' }, { invokeId: 'i-2' });
  const raw = fs.readFileSync(w.receipts.file, 'utf8');
  const kinds = raw.trim().split('\n').map((line) => JSON.parse(line).kind);
  assert.deepEqual(kinds, ['DENY', 'EXECUTE', 'RETURN']);
  assert.doesNotMatch(raw, /TOP-SECRET-CONTENT/);
  assert.equal(ReceiptLog.verify(w.receipts.file).ok, true);
  const lines = raw.trim().split('\n');
  const edited = JSON.parse(lines[0]);
  edited.kind = 'EXECUTE';
  fs.writeFileSync(w.receipts.file, [JSON.stringify(edited), ...lines.slice(1)].join('\n') + '\n');
  assert.equal(ReceiptLog.verify(w.receipts.file).ok, false, 'tampering breaks the chain');
});
