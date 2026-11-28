'use strict';

// Turn approval ("Aprobar todo este turno") + undo log.
// Everything runs in a temp home with an isolated authority directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createZenityChannel } = require('../lib/approval');
const { TurnApproval, CONSENT_REASON } = require('../lib/turn-approval');
const { UndoLog, planFor } = require('../lib/undo-log');
const { createCommandRegistry } = require('../lib/commands');
const { WorkspaceAuthority } = require('../lib/workspace-authority');
const { ReceiptLog } = require('../lib/receipts');

const quiet = { log() {}, error() {} };
const canary = (dir) => path.join(dir, `canary-${crypto.randomBytes(6).toString('hex')}.txt`);

function world(context, { approveImpl = async () => false, withTurn = true, withUndo = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-turn-')));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'home');
  for (const dir of ['Documents', 'Private', '.ssh']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const state = path.join(base, 'state');
  const authority = new WorkspaceAuthority({ root, stateDirectory: state });
  const receipts = new ReceiptLog({ file: path.join(state, 'receipts', 'r.jsonl') });
  const turn = withTurn ? new TurnApproval({ file: path.join(state, 'turn.json'), now: () => Date.now() }) : null;
  const undoLog = withUndo ? new UndoLog({ directory: path.join(state, 'undo') }) : null;
  const asked = [];
  const turned = [];
  const approve = async (request) => { asked.push(request); return approveImpl(request); };
  const registry = createCommandRegistry({ approve, authority, receipts, turn, onTurn: (ask) => turned.push(ask), undoLog, logger: quiet });
  const lines = () => { try { return fs.readFileSync(receipts.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; } };
  return { base, root, state, authority, receipts, turn, undoLog, registry, asked, turned, lines };
}

function pathOf(file) { return file; }

// ---- TurnApproval state ---------------------------------------------------

test('turn: off by default, on only by an operator, expires, malformed = off', (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-turn-state-'));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let now = Date.parse('2026-11-27T22:00:00Z');
  const turn = new TurnApproval({ file: path.join(base, 'turn.json'), now: () => now });
  assert.equal(turn.status().active, false);
  assert.throws(() => turn.enable('muse'), /operator/);
  const state = turn.enable('desktop');
  assert.equal(state.active, true);
  assert.equal(state.setBy, 'desktop');
  now += 10 * 60000 + 1;
  assert.equal(turn.status().active, false, 'expired');
  turn.enable('terminal', { windowMs: 5 * 60000 });
  now += 2 * 60000;
  const touched = turn.touch();
  assert.equal(touched.active, true);
  assert.equal(touched.actions, 1);
  now += 10 * 60000 + 1;
  assert.equal(turn.status().active, false, 'lapses when Muse stops asking');
  fs.writeFileSync(path.join(base, 'turn.json'), '{"until":"never"');
  assert.equal(turn.status().active, false, 'malformed = off');
  fs.writeFileSync(path.join(base, 'turn.json'), JSON.stringify({ until: new Date(now + 365 * 86400000).toISOString() }));
  assert.equal(turn.status().active, false, 'a hand-edited year-long turn is rejected');
  assert.equal(turn.disable().active, false);
});

// ---- Dialog: the extra button ---------------------------------------------

function fakeSpawn(exitCode, stdout, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = options?.stdio?.[1] === 'pipe' ? new (require('node:stream').PassThrough)() : null;
    setImmediate(() => { if (child.stdout && stdout) child.stdout.write(stdout); child.emit('exit', exitCode); });
    return child;
  };
}

test('zenity: the turn button is detected by its stdout label, not by the exit code', async () => {
  const request = { command_id: 'shell.exec', params: { command: 'echo hi' }, turnOffered: true, digest: 'a'.repeat(64) };
  // zenity 4: exit 1 + label on stdout => turn
  let calls = [];
  let answer = await createZenityChannel({ spawnImpl: fakeSpawn(1, 'Aprobar todo este turno\n', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: false }).ask(request);
  assert.deepEqual(answer, { approved: true, scope: 'turn' });
  assert.ok(calls[0].options.stdio[1] === 'pipe', 'stdout is captured when the turn is offered');
  // exit 1 without the label => Rechazar
  answer = await createZenityChannel({ spawnImpl: fakeSpawn(1, '', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: false }).ask(request);
  assert.deepEqual(answer, { approved: false, scope: 'once' });
  // zenity < 4: exit 65 + label => still a turn
  answer = await createZenityChannel({ spawnImpl: fakeSpawn(65, 'Aprobar todo este turno\n', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: false }).ask(request);
  assert.deepEqual(answer, { approved: true, scope: 'turn' });
  // a label that is not ours is never a turn
  answer = await createZenityChannel({ spawnImpl: fakeSpawn(1, 'something else\n', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: false }).ask(request);
  assert.equal(answer, null, 'no answer');
  // exit 0 with garbage on stdout is not a clean yes either
  answer = await createZenityChannel({ spawnImpl: fakeSpawn(0, 'Aprobar todo este turno\n', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: false }).ask(request);
  assert.equal(answer, null);
  // without the turn offered, the label is ignored and the dialog is plain zenity
  calls = [];
  answer = await createZenityChannel({ spawnImpl: fakeSpawn(0, '', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: false }).ask({ ...request, turnOffered: false });
  assert.deepEqual(answer, { approved: true, scope: 'once' });
  assert.equal(calls[0].command, 'zenity');
  assert.ok(!calls[0].args.some((arg) => arg.startsWith('--extra-button')), 'no third button');
});

test('zenity: with xdotool present the dialog goes through ask-dialog.js so only the mouse answers', async () => {
  const calls = [];
  const channel = createZenityChannel({ spawnImpl: fakeSpawn(0, '', calls), env: { DISPLAY: ':0' }, logger: quiet, keyboardFree: true });
  await channel.ask({ command_id: 'files.write', params: { path: '/x', content: 'a' } });
  assert.ok(calls[0].args[0].endsWith('ask-dialog.js'), 'spawned through the helper');
  assert.equal(calls[0].args[1], '--');
  assert.equal(calls[0].args[2], '--question');
});

// ---- Gate: the turn never widens a grant -----------------------------------

test('turn: inside a write grant, the turn button is offered and tapping it approves this request AND switches the mode on', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  const target = path.join(dir, 'a.txt');
  w.registry.gate.turn.enable = w.registry.gate.turn.enable.bind(w.registry.gate.turn);
  const approveImpl = async (request) => { assert.equal(request.turnOffered, true, 'the dialog offers the turn'); return { approved: true, channel: 'desktop', scope: 'turn' }; };
  const registry = createCommandRegistry({ approve: approveImpl, authority: w.authority, receipts: w.receipts, turn: w.turn, onTurn: (ask) => w.turned.push(ask), undoLog: w.undoLog, logger: quiet });
  assert.equal((await registry.invoke('files.write', { path: target, content: 'one' })).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'one');
  assert.equal(w.turned.length, 1);
  assert.equal(w.turned[0].enabled, true, 'the gate asked to switch the turn on');
  const execute = w.lines().find((line) => line.kind === 'EXECUTE');
  assert.equal(execute.approval, 'user:desktop', 'this first request carries the dialog channel');
});

test('turn: once active, covered requests pass without asking, renew the window and leave approval:"turn"', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  w.turn.enable('desktop');
  const first = path.join(dir, 'b.txt');
  assert.equal((await w.registry.invoke('files.write', { path: first, content: 'two' })).ok, true);
  assert.equal(w.asked.length, 0, 'did not ask');
  assert.equal(w.lines().filter((line) => line.kind === 'EXECUTE')[0].approval, 'turn');
  assert.equal(w.turn.status().actions, 1, 'the window was renewed');
  assert.equal(w.turned.length, 1);
  assert.equal(w.turned[0].enabled, false);
  // A second covered request also passes.
  assert.equal((await w.registry.invoke('files.write', { path: path.join(dir, 'c.txt'), content: 'three' })).ok, true);
  assert.equal(w.asked.length, 0);
  assert.equal(w.turn.status().actions, 2);
});

test('turn never widens a grant: outside the granted folder, without a grant, or for reads, it still asks (and offers no button)', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  w.turn.enable('desktop');
  const outside = path.join(w.root, 'Private', 'x.txt');
  const result = await w.registry.invoke('files.write', { path: outside, content: 'nope' });
  assert.equal(result.ok, false);
  // A grant exists for Documents only: outside it the authority says
  // "outside granted paths". That is a one-off consent the operator may still
  // give by hand, so the dialog appears, but the turn button is NEVER offered
  // there: a turn never widens a grant.
  assert.equal(w.asked.length, 1, 'outside the grant the operator is still asked once');
  assert.equal(w.asked[0].turnOffered, false, 'and the turn button is not offered');
  assert.equal(fs.existsSync(outside), false, 'nothing was written: the test approver says no');
  assert.equal(w.turn.wouldCover({ actionId: 'workspace.files.write', target: outside, parameters: {} }, w.authority), false);
  // shell with no grant at all: the active turn does not cover it, and the
  // dialog is offered without the turn button.
  w.asked.length = 0;
  const shell = await w.registry.invoke('shell.exec', { command: 'echo x', cwd: dir });
  assert.equal(shell.ok, false);
  assert.equal(w.asked.length, 1, 'no shell grant => the operator is asked');
  assert.equal(w.asked[0].turnOffered, false, 'and the turn button is not offered');
  // reads are never part of a turn
  assert.equal(w.turn.wouldCover({ actionId: 'workspace.files.read', target: dir }, w.authority), false);
});

test('turn: when active, the dialog never offers the button again; an expired turn asks again', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  let now = Date.now();
  const turn = new TurnApproval({ file: path.join(w.state, 'turn2.json'), now: () => now });
  turn.enable('desktop', { windowMs: 1000 });
  now += 2000;
  const asked = [];
  const registry = createCommandRegistry({ approve: async (r) => { asked.push(r); return false; }, authority: w.authority, receipts: w.receipts, turn, logger: quiet });
  await registry.invoke('files.write', { path: path.join(dir, 'd.txt'), content: 'x' });
  assert.equal(asked.length, 1, 'expired turn asks again');
  assert.equal(asked[0].turnOffered, true, 'and offers the button again');
  // While the turn is active, the dialog would not offer it (no dialog at all).
  now -= 3000;
  turn.enable('desktop', { windowMs: 1000 });
  assert.equal(registry.gate.turnOffered({ actionId: 'workspace.files.write', target: path.join(dir, 'e.txt'), parameters: {} }), false);
});

test('turn: credentials and the authority state are never covered, even inside a broad grant', (context) => {
  const w = world(context);
  w.turn.enable('desktop');
  for (const target of [path.join(w.root, '.ssh', 'id_ed25519'), path.join(w.state, 'policy.json')]) {
    assert.equal(w.turn.wouldCover({ actionId: 'workspace.files.write', target }, w.authority), false, target);
  }
});

// ---- Undo log --------------------------------------------------------------

test('undo: an overwritten file is restored to its previous content; a created file is removed', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  w.turn.enable('desktop');
  const existing = path.join(dir, 'existing.txt');
  fs.writeFileSync(existing, 'ORIGINAL');
  const created = path.join(dir, 'created.txt');
  assert.equal((await w.registry.invoke('files.write', { path: existing, content: 'CHANGED' })).ok, true);
  assert.equal((await w.registry.invoke('files.write', { path: created, content: 'NEW' })).ok, true);
  const rows = w.undoLog.undoable();
  assert.equal(rows.length, 2);
  // newest first: rows[0] = created.txt, rows[1] = existing.txt
  assert.equal(rows[0].target, created);
  assert.equal(rows[0].action_id, 'workspace.files.write');
  assert.equal(rows[0].approval, 'turn');
  assert.equal(rows[0].undo.op, 'remove_created');
  assert.equal(rows[1].target, existing);
  assert.equal(rows[1].undo.op, 'restore_copy');
  assert.equal(w.undoLog.undo(rows[0].seq).plan.op, 'remove_created');
  assert.equal(fs.existsSync(created), false, 'created file removed');
  assert.equal(w.undoLog.undo(rows[1].seq).plan.op, 'restore_copy');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'ORIGINAL', 'previous content back');
  assert.equal(w.undoLog.undoable().length, 0);
  assert.throws(() => w.undoLog.undo(rows[1].seq), /already undone/);
});

test('undo: shell.exec is logged as not reversible; a folder that already existed is never removed', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  w.authority.setGrant('workspace.command.run', { enabled: true, pathPrefixes: [dir] });
  w.turn.enable('desktop');
  const existingDir = path.join(dir, 'already');
  fs.mkdirSync(existingDir);
  assert.equal((await w.registry.invoke('shell.exec', { command: 'echo hi', cwd: dir })).ok, true);
  // mkdir on an existing folder changes nothing (EEXIST) and is not undoable.
  assert.equal((await w.registry.invoke('files.mkdir', { path: existingDir })).ok, false);
  const newDir = path.join(dir, 'fresh');
  assert.equal((await w.registry.invoke('files.mkdir', { path: newDir })).ok, true);
  assert.equal(w.undoLog.undoable().length, 1, 'only the created folder is undoable');
  assert.equal(w.undoLog.undoable()[0].target, newDir);
  const entries = w.undoLog.entries();
  assert.ok(entries.some((entry) => entry.kind === 'RAN' && entry.reversible === false && entry.command_preview === 'echo hi'));
  assert.ok(entries.some((entry) => entry.kind === 'BEFORE' && entry.target === existingDir && entry.target_kind === 'folder' && entry.reversible === false && /already existed/.test(entry.reason)));
  assert.equal(fs.existsSync(existingDir), true);
  w.undoLog.undo(w.undoLog.undoable()[0].seq);
  assert.equal(fs.existsSync(newDir), false);
});

test('undo: the log is hash-chained and a copy that no longer matches its hash is refused', async (context) => {
  const w = world(context);
  const dir = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [dir] });
  w.turn.enable('desktop');
  const file = path.join(dir, 'chained.txt');
  fs.writeFileSync(file, 'v1');
  await w.registry.invoke('files.write', { path: file, content: 'v2' });
  const entries = w.undoLog.entries();
  assert.equal(entries.length, 2, 'BEFORE + DONE');
  assert.equal(entries[0].kind, 'BEFORE');
  assert.equal(entries[0].target_kind, 'file');
  assert.equal(entries[1].kind, 'DONE');
  assert.equal(entries[1].prev, entries[0].hash, 'chained');
  assert.equal(entries[0].prev, '0'.repeat(64), 'genesis');
  const before = entries[0];
  fs.writeFileSync(before.copy, 'tampered');
  assert.throws(() => w.undoLog.undo(entries[1].seq), /does not match its hash/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'v2', 'nothing was overwritten');
});

test('undo: planFor is exported and consistent', () => {
  assert.equal(planFor({ reversible: false }), null);
  assert.deepEqual(planFor({ reversible: true, existed: false }), { op: 'remove_created' });
  assert.deepEqual(planFor({ reversible: true, existed: true, target_kind: 'folder' }), { op: 'remove_folder_if_empty' });
  assert.deepEqual(planFor({ reversible: true, existed: true, target_kind: 'file', copy: '/c', sha256: 'h' }), { op: 'restore_copy', copy: '/c', sha256: 'h' });
});
