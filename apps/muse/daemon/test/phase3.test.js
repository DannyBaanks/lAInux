'use strict';

// Phase 3 gates (lAInux.mods): Approval Broker, Flow mode, Telegram channel.
// Telegram runs against an in-memory Bot API fake; no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApprovalBroker } = require('../lib/approval-broker');
const { FlowMode, parseMinutes } = require('../lib/flow');
const { createCommandRegistry } = require('../lib/commands');
const { WorkspaceAuthority } = require('../lib/workspace-authority');
const { ReceiptLog } = require('../lib/receipts');
const { TelegramTransport, TelegramApprovals, Peer, maskForExport, readPeer, writePeer, parseFlowArgs } = require('../lib/telegram');

const quiet = { log() {}, error() {} };
const digest = () => crypto.randomBytes(32).toString('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (predicate, ms = 2000) => {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise((r) => setTimeout(r, 5)); }
};

function channel(name, behaviour) {
  const seen = { asked: 0, aborted: null };
  return {
    seen,
    name,
    available: () => behaviour !== 'unavailable',
    ask(request, { signal }) {
      seen.asked++;
      signal.addEventListener('abort', () => { seen.aborted = signal.reason; }, { once: true });
      if (behaviour === 'abstain') return Promise.resolve(null);
      if (behaviour === 'throw') return Promise.reject(new Error('boom'));
      if (behaviour === 'never') return new Promise(() => {});
      return new Promise((resolve) => setTimeout(() => resolve(behaviour.answer), behaviour.after ?? 0));
    },
  };
}

// ---- Approval Broker -------------------------------------------------------

test('broker: first explicit answer wins and the other channel is cancelled', async () => {
  const desktop = channel('desktop', 'never');
  const phone = channel('telegram', { answer: { approved: true, channel: 'telegram' }, after: 5 });
  const result = await createApprovalBroker({ channels: [desktop, phone], logger: quiet })({ command_id: 'shell.exec', digest: digest() });
  assert.deepEqual(result, { approved: true, channel: 'telegram' });
  assert.equal(desktop.seen.aborted, 'resolved:telegram');
});

test('broker: a no is as final as a yes', async () => {
  const slowYes = channel('telegram', { answer: true, after: 50 });
  const fastNo = channel('desktop', { answer: false, after: 1 });
  const result = await createApprovalBroker({ channels: [slowYes, fastNo], logger: quiet })({ command_id: 'x', digest: digest() });
  assert.equal(result.approved, false);
  assert.equal(result.channel, 'desktop');
});

test('broker: all abstain, failures, no channels or timeout => no', async () => {
  const approveA = createApprovalBroker({ channels: [channel('a', 'abstain'), channel('b', 'throw')], logger: quiet });
  assert.equal((await approveA({ command_id: 'x' })).approved, false);
  const approveB = createApprovalBroker({ channels: [channel('a', 'unavailable')], logger: quiet });
  assert.equal((await approveB({ command_id: 'x' })).reason, 'no approval channel available');
  const hanging = channel('a', 'never');
  const approveC = createApprovalBroker({ channels: [hanging], timeoutMs: 20, logger: quiet });
  assert.equal((await approveC({ command_id: 'x' })).reason, 'timeout');
  assert.equal(hanging.seen.aborted, 'timeout');
});

// ---- Flow mode -------------------------------------------------------------

function world(context, approveImpl) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-phase3-')));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'home');
  for (const dir of ['Documents', 'Private', '.ssh']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const state = path.join(base, 'state');
  const authority = new WorkspaceAuthority({ root, stateDirectory: state });
  const receipts = new ReceiptLog({ file: path.join(state, 'receipts', 'r.jsonl') });
  const flow = new FlowMode({ file: path.join(state, 'flow.json') });
  const asked = [];
  const flowed = [];
  const approve = async (request) => { asked.push(request); return approveImpl ? approveImpl(request) : false; };
  const registry = createCommandRegistry({ approve, authority, receipts, flow, onFlow: (ask) => flowed.push(ask), logger: quiet });
  const lines = () => { try { return fs.readFileSync(receipts.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)); } catch { return []; } };
  return { base, root, state, authority, receipts, flow, registry, asked, flowed, lines };
}

const canary = (dir) => path.join(dir, `canary-${crypto.randomBytes(6).toString('hex')}.txt`);

test('flow: inside a write grant, writes run without asking and leave a flow receipt', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  w.flow.enable(30, 'terminal');
  const target = canary(path.join(w.root, 'Documents'));
  assert.equal((await w.registry.invoke('files.write', { path: target, content: 'flow' })).ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'flow');
  assert.equal(w.asked.length, 0, 'Flow did not ask');
  assert.equal(w.flowed.length, 1, 'operator notified');
  const execute = w.lines().find((line) => line.kind === 'EXECUTE');
  assert.equal(execute.approval, 'flow');
  assert.equal(ReceiptLog.verify(w.receipts.file).ok, true);
});

test('flow never widens a grant: outside the granted folder or without a grant it still asks', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [path.join(w.root, 'Documents')] });
  w.flow.enable(30, 'telegram', 'all');
  const outside = canary(path.join(w.root, 'Private'));
  assert.equal((await w.registry.invoke('files.write', { path: outside, content: 'x' })).error_code, 'permission_denied');
  assert.equal(fs.existsSync(outside), false);
  assert.equal(w.asked.length, 1, 'asked instead of flowing');
  // no shell grant at all: Flow "all" still asks
  assert.equal((await w.registry.invoke('shell.exec', { command: 'true', cwd: path.join(w.root, 'Documents') })).error_code, 'permission_denied');
  assert.equal(w.asked.length, 2);
});

test('flow never reaches credentials or its own state, even inside a broad grant', async (context) => {
  const w = world(context);
  w.authority.setGrant('workspace.files.write', { enabled: true, pathPrefixes: [w.root] });
  w.flow.enable(30, 'terminal', 'all');
  const key = path.join(w.root, '.ssh', 'authorized_keys');
  assert.equal((await w.registry.invoke('files.write', { path: key, content: 'ssh-ed25519 evil' })).error_code, 'permission_denied');
  assert.equal(fs.existsSync(key), false);
  assert.equal(w.asked.length, 0, 'denied without asking');
});

test('flow scope: write covers files.* only; shell needs scope all', async (context) => {
  const w = world(context);
  const docs = path.join(w.root, 'Documents');
  w.authority.setGrant('workspace.command.run', { enabled: true, pathPrefixes: [docs] });
  w.flow.enable(30, 'terminal');
  const marker = canary(docs);
  assert.equal((await w.registry.invoke('shell.exec', { command: `touch ${marker}`, cwd: docs })).error_code, 'permission_denied');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(w.asked.length, 1);
  w.flow.enable(30, 'terminal', 'all');
  assert.equal((await w.registry.invoke('shell.exec', { command: `touch ${marker}`, cwd: docs })).exit_code, 0);
  assert.equal(fs.existsSync(marker), true);
  assert.equal(w.asked.length, 1, 'scope all did not ask');
});

test('flow expires, is off when malformed, and only the operator can set it', (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-flow-'));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  let now = Date.now();
  const flow = new FlowMode({ file: path.join(base, 'flow.json'), now: () => now });
  assert.equal(flow.status().active, false);
  flow.enable(10, 'terminal');
  assert.equal(flow.covers('workspace.files.write'), true);
  now += 11 * 60000;
  assert.equal(flow.status().active, false, 'expired');
  fs.writeFileSync(path.join(base, 'flow.json'), '{"until":"never"');
  assert.equal(flow.status().active, false, 'malformed = off');
  fs.writeFileSync(path.join(base, 'flow.json'), JSON.stringify({ until: new Date(now + 365 * 86400000).toISOString() }));
  assert.equal(flow.status().active, false, 'a hand-edited year-long Flow is rejected');
  assert.throws(() => flow.enable(10, 'muse'), /operator/);
  assert.throws(() => flow.enable(9999, 'terminal'), /minutes/);
  assert.equal(parseMinutes('2h'), 120);
  assert.deepEqual(parseFlowArgs(['15', 'terminal']), { minutes: 15, scope: 'all' });
  assert.equal(parseFlowArgs(['rm -rf']), null);
});

test('without Flow, a broker answer is recorded with its channel', async (context) => {
  const w = world(context, () => ({ approved: true, channel: 'telegram' }));
  const target = canary(path.join(w.root, 'Documents'));
  assert.equal((await w.registry.invoke('files.write', { path: target, content: 'si' })).ok, true);
  assert.equal(w.lines().find((line) => line.kind === 'EXECUTE').approval, 'user:telegram');
});

// ---- Telegram --------------------------------------------------------------

const BOT = 777000111;
const USER = 424242;
const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Minimal Bot API: queues updates, records calls, long-poll resolves when an
// update is pushed or the request is aborted.
function fakeBotApi() {
  const calls = [];
  const queue = [];
  let nextUpdate = 1;
  let nextMessage = 100;
  let waiter = null;
  const ok = (result) => ({ status: 200, text: async () => JSON.stringify({ ok: true, result }) });
  const api = {
    calls,
    push(update) { queue.push({ update_id: nextUpdate++, ...update }); waiter?.(); },
    sent: () => calls.filter((call) => call.method === 'sendMessage'),
    edits: () => calls.filter((call) => call.method === 'editMessageText'),
    async fetch(url, init) {
      assert.ok(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`));
      const method = url.split('/').pop();
      const body = JSON.parse(init.body);
      calls.push({ method, body });
      if (method === 'getWebhookInfo') return ok({ url: '' });
      if (method === 'getMe') return ok({ id: BOT, is_bot: true, username: 'muse_test_bot' });
      if (method === 'sendMessage') return ok({ message_id: nextMessage++, chat: { id: body.chat_id, type: 'private' }, from: { id: BOT, is_bot: true } });
      if (method === 'editMessageText') return ok({ message_id: body.message_id, chat: { id: body.chat_id, type: 'private' } });
      if (method === 'answerCallbackQuery') return ok(true);
      if (method === 'getUpdates') {
        while (queue.length && queue[0].update_id < body.offset) queue.shift();
        if (!queue.length && body.timeout > 0) {
          await new Promise((resolve, reject) => {
            waiter = resolve;
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
          waiter = null;
        }
        return ok(queue.filter((row) => row.update_id >= body.offset));
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return api;
}

function press(api, messageId, data, { from = USER, chat = USER, botAuthor = BOT, extra = {} } = {}) {
  api.push({ callback_query: {
    id: `cb${Math.random()}`, data, from: { id: from, is_bot: false },
    message: { message_id: messageId, chat: { id: chat, type: 'private' }, from: { id: botAuthor, is_bot: true }, ...extra },
  } });
}

async function phone(context, { flow = null, authority = null, ttlMs = 110000 } = {}) {
  const api = fakeBotApi();
  const transport = new TelegramTransport({ token: () => TOKEN, fetchImpl: api.fetch });
  const channel = new TelegramApprovals({ transport, peer: new Peer({ bot_id: BOT, user_id: USER, chat_id: USER }), flow, authority, ttlMs, logger: quiet, hostname: 'testbox' });
  channel.start();
  context.after(() => channel.stop());
  await until(() => channel.available());
  return { api, channel };
}

const lastButtons = (api) => {
  const message = api.sent().at(-1);
  return { text: message.body.text, data: message.body.reply_markup.inline_keyboard.flat().map((button) => button.callback_data) };
};

test('telegram: Permitir from the paired user approves the exact message', async (context) => {
  const { api, channel } = await phone(context);
  const answer = channel.ask({ command_id: 'shell.exec', params: { command: 'ls', cwd: '~' }, digest: digest() });
  await until(() => api.sent().length === 1);
  const { data, text } = lastButtons(api);
  assert.match(text, /Muse quiere ejecutar un comando/);
  assert.equal(api.sent()[0].body.protect_content, true);
  press(api, 100, data[0]);
  assert.deepEqual(await answer, { approved: true, channel: 'telegram' });
  await until(() => api.edits().length === 1);
  assert.match(api.edits()[0].body.text, /Permitido desde Telegram/);
});

test('telegram: strangers, groups, forwards, other messages and forged ids are ignored', async (context) => {
  const { api, channel } = await phone(context, { ttlMs: 400 });
  const answer = channel.ask({ command_id: 'files.write', params: { path: '/x', content: 'y' }, digest: digest() });
  await until(() => api.sent().length === 1);
  const [approve] = lastButtons(api).data;
  press(api, 100, approve, { from: 999 }); // another user
  press(api, 100, approve, { chat: -100123 }); // a group
  press(api, 100, approve, { extra: { forward_origin: {} } }); // a forward
  press(api, 101, approve); // a different message
  press(api, 100, approve, { botAuthor: 555 }); // not our bot's message
  press(api, 100, `a:${'A'.repeat(32)}`); // forged callback id
  assert.equal(await answer, null, 'nothing approved; the review expired');
});

test('telegram: a button is single-use and Rechazar is a no', async (context) => {
  const { api, channel } = await phone(context);
  const first = channel.ask({ command_id: 'files.mkdir', params: { path: '/x' }, digest: digest() });
  await until(() => api.sent().length === 1);
  const [approveFirst, reject] = lastButtons(api).data;
  press(api, 100, reject);
  assert.deepEqual(await first, { approved: false, channel: 'telegram' });
  const second = channel.ask({ command_id: 'files.mkdir', params: { path: '/x' }, digest: digest() });
  await until(() => api.sent().length === 2);
  const [approveSecond] = lastButtons(api).data;
  press(api, 100, approveFirst); // first review, already consumed
  press(api, 100, approveSecond); // second's id on the first message
  await new Promise((resolve) => setTimeout(resolve, 50));
  let settled = false;
  second.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'replays and misplaced buttons did not answer');
  press(api, 101, approveSecond);
  assert.deepEqual(await second, { approved: true, channel: 'telegram' });
});

test('telegram: the Flow button approves and enables a scoped, time-boxed Flow', async (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tgflow-'));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const flow = new FlowMode({ file: path.join(base, 'flow.json') });
  const { api, channel } = await phone(context, { flow });
  const answer = channel.ask({ command_id: 'files.write', params: { path: '/x', content: 'y' }, digest: digest() });
  await until(() => api.sent().length === 1);
  press(api, 100, lastButtons(api).data[2]);
  assert.deepEqual(await answer, { approved: true, channel: 'telegram', flow: true });
  const state = flow.status();
  assert.equal(state.active, true);
  assert.equal(state.scope, 'write', 'pressed on a write: covers writes only');
  assert.ok(state.remainingMs <= 30 * 60000);
});

test('telegram: commands from the paired chat only; /bloquear locks, nobody can unlock remotely', async (context) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tgcmd-')));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.mkdirSync(path.join(base, 'home'));
  const authority = new WorkspaceAuthority({ root: path.join(base, 'home'), stateDirectory: path.join(base, 'state') });
  const flow = new FlowMode({ file: path.join(base, 'state', 'flow.json') });
  const { api } = await phone(context, { flow, authority });
  const say = (text, from = USER) => api.push({ message: { message_id: 5, text, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false } } });
  say('/flow 8h', 999); // stranger
  say('/flow 20 terminal');
  await until(() => flow.status().active);
  assert.equal(flow.status().scope, 'all');
  assert.equal(api.sent().filter((m) => m.body.chat_id === 999).length, 0, 'no reply to strangers');
  say('/bloquear');
  await until(() => authority.policy().locked === true);
  assert.equal(flow.status().active, false, 'lock also ends Flow');
  say('/desbloquear');
  say('/unlock');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(authority.policy().locked, true, 'unlocking needs the terminal');
});

test('telegram: answered on the desktop -> the phone message says so; old taps after restart do nothing', async (context) => {
  const { api, channel } = await phone(context);
  const controller = new AbortController();
  const answer = channel.ask({ command_id: 'shell.exec', params: { command: 'ls' }, digest: digest() }, { signal: controller.signal });
  await until(() => api.sent().length === 1);
  controller.abort('resolved:desktop');
  assert.equal(await answer, null);
  await until(() => api.edits().length === 1);
  assert.match(api.edits()[0].body.text, /Resuelto en la PC/);
});

test('telegram: token never appears in errors; secrets are masked before export', async () => {
  const transport = new TelegramTransport({ token: () => TOKEN, fetchImpl: async () => { throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/getMe`); } });
  await assert.rejects(transport.getMe(), (error) => error.code.startsWith('transport_failure') && !String(error.message).includes(TOKEN) && !error.cause);
  const bad = new TelegramTransport({ token: () => 'not-a-token', fetchImpl: async () => assert.fail('must not call') });
  await assert.rejects(bad.getMe(), { code: 'credential_unavailable' });
  await assert.rejects(transport.call('deleteWebhook'), { code: 'method_not_allowed' });
  assert.equal(maskForExport('export KEY=sk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ok'), 'export «oculto» ok');
});

test('telegram: connect failures retry (nothing was sent); other failures do not', async () => {
  let calls = 0;
  const flaky = new TelegramTransport({ token: () => TOKEN, fetchImpl: async () => {
    calls++;
    if (calls < 3) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: { id: BOT, is_bot: true, username: 'b' } }) };
  } });
  assert.equal((await flaky.getMe()).id, BOT);
  assert.equal(calls, 3);
  let resets = 0;
  const midway = new TelegramTransport({ token: () => TOKEN, fetchImpl: async () => { resets++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(midway.getMe(), /ECONNRESET/);
  assert.equal(resets, 1, 'a reset after connecting may have delivered: no retry');
});

test('telegram: the pairing file must be private and describe a private chat', (context) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tgpeer-'));
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const file = path.join(base, 'cfg', 'telegram-peer.json');
  assert.equal(readPeer(file), null);
  writePeer(new Peer({ bot_id: BOT, user_id: USER, chat_id: USER }), file);
  assert.equal(readPeer(file).userId, USER);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readPeer(file), /private/);
  assert.throws(() => writePeer(new Peer({ bot_id: BOT, user_id: USER, chat_id: -5 }), file), /invalid/);
});
