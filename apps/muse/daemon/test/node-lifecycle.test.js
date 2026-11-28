'use strict';

// Phase 0 gates: a node that cannot receive invokes must say so and reconnect;
// a redelivered invoke must never run twice; cancelling a shell command must
// leave no descendant processes behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MuseNodeService } = require('../lib/node-service');
const { InvokeLedger } = require('../lib/invoke-ledger');
const { NodeStatus } = require('../lib/node-state');
const { shellExec, activeGroups } = require('../lib/commands');

const quiet = { log() {}, error() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRpc({ accepted = 1, rejected = [], heartbeat = async () => ({ status: 200, json: {} }) } = {}) {
  const calls = [];
  return {
    calls,
    async subscribe(options) { this.subscription = options; return { status: 200, streamId: 1n }; },
    async requestJson(options) {
      calls.push(options);
      if (options.path === '/api/nodes/heartbeat') return heartbeat();
      if (options.path === '/client/register-capabilities') {
        return { status: 200, json: { accepted_device_commands: accepted, rejected_ids: rejected } };
      }
      return { status: 200, json: { status: 'registered' } };
    },
  };
}

function registry(invoke = async () => ({ ok: true })) {
  return { definitions: { ping: { description: 'ping' } }, invoke };
}

function service(rpc, extra = {}) {
  return new MuseNodeService({
    rpc, identity: { nodeId: 'n1', displayName: 'Test' }, registry: registry(), logger: quiet, heartbeatMs: 3600000, ...extra,
  });
}

function tempStatus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-node-status-'));
  return { file: path.join(dir, 'status.json'), status: new NodeStatus({ file: path.join(dir, 'status.json'), logger: quiet }) };
}

test('READY only when every device command is accepted', async () => {
  const { status, file } = tempStatus();
  const node = service(fakeRpc(), { status });
  await node.start();
  assert.equal(status.state, 'READY');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.state, 'READY');
  assert.deepEqual(onDisk.history.map((h) => h.to), ['CONNECTING', 'REGISTERED', 'READY']);
  assert.ok(onDisk.last_heartbeat_ok, 'first heartbeat recorded');
  await node.close();
});

test('partially accepted capabilities => DEGRADED and lost, not READY', async () => {
  const { status } = tempStatus();
  const node = service(fakeRpc({ accepted: 0, rejected: ['ping'] }), { status });
  await node.start();
  assert.equal(status.state, 'DEGRADED');
  assert.match(await node.lost, /capabilities not fully accepted/);
  await node.close();
});

test('clean end of the subscription stream marks the session lost (the 17:08 deaf node)', async () => {
  const rpc = fakeRpc();
  const { status } = tempStatus();
  const node = service(rpc, { status });
  await node.start();
  assert.equal(typeof rpc.subscription.onStreamEnd, 'function', 'subscription must handle a clean end');
  rpc.subscription.onStreamEnd();
  assert.match(await node.lost, /clean end of stream/);
  assert.equal(status.state, 'DEGRADED');
  assert.match(status.data.last_error.message, /subscription ended/);
  await node.close();
});

test('subscription reset marks the session lost', async () => {
  const rpc = fakeRpc();
  const node = service(rpc);
  await node.start();
  rpc.subscription.onStreamError(new Error('Noise RPC stream reset (5): response body error'));
  assert.match(await node.lost, /stream reset/);
  await node.close();
});

test('heartbeat: transient failures tolerated, N consecutive failures => lost', async () => {
  let failing = false;
  const rpc = fakeRpc({ heartbeat: async () => { if (failing) throw new Error('service unavailable'); return { status: 200, json: {} }; } });
  const node = service(rpc, { maxHeartbeatFailures: 3 });
  await node.start();
  let lost = null;
  node.lost.then((reason) => { lost = reason; });
  failing = true;
  await node.beat().catch(() => {});
  await node.beat().catch(() => {});
  failing = false;
  await node.beat();
  await sleep(0);
  assert.equal(lost, null, 'a success resets the failure count');
  failing = true;
  for (let i = 0; i < 3; i += 1) await node.beat().catch(() => {});
  await sleep(0);
  assert.match(lost, /3 consecutive heartbeat failures/);
  await node.close();
});

test('redelivered invoke after reconnect replays the result, never runs twice', async () => {
  const ledger = new InvokeLedger();
  let runs = 0;
  const invoke = async () => { runs += 1; return { ok: true, run: runs }; };
  const first = fakeRpc();
  const nodeA = new MuseNodeService({ rpc: first, identity: { nodeId: 'n1', displayName: 'T' }, registry: registry(invoke), logger: quiet, ledger, heartbeatMs: 3600000 });
  await nodeA.handleInvoke({ invoke_id: 'inv-1', command_id: 'ping', params_json: '{}' });
  await nodeA.close();
  const second = fakeRpc();
  const nodeB = new MuseNodeService({ rpc: second, identity: { nodeId: 'n1', displayName: 'T' }, registry: registry(invoke), logger: quiet, ledger, heartbeatMs: 3600000 });
  await nodeB.handleInvoke({ invoke_id: 'inv-1', command_id: 'ping', params_json: '{}' });
  assert.equal(runs, 1, 'command executed exactly once');
  const replay = second.calls.find((call) => call.path === '/client/invoke-result');
  assert.deepEqual(JSON.parse(replay.params.payload_json), { ok: true, run: 1 });
  await nodeB.close();
});

test('concurrent redelivery while the first run is in flight executes once', async () => {
  const ledger = new InvokeLedger();
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const invoke = async () => { runs += 1; await gate; return { ok: true }; };
  const rpc = fakeRpc();
  const node = new MuseNodeService({ rpc, identity: { nodeId: 'n1', displayName: 'T' }, registry: registry(invoke), logger: quiet, ledger, heartbeatMs: 3600000 });
  const a = node.handleInvoke({ invoke_id: 'inv-2', command_id: 'ping', params_json: '{}' });
  const b = node.handleInvoke({ invoke_id: 'inv-2', command_id: 'ping', params_json: '{}' });
  release();
  await Promise.all([a, b]);
  assert.equal(runs, 1);
  assert.equal(rpc.calls.filter((call) => call.path === '/client/invoke-result').length, 2, 'both deliveries answered');
});

test('close() does not wait for a running command (reconnect is not held hostage)', async () => {
  const ledger = new InvokeLedger();
  const invoke = () => new Promise(() => {}); // e.g. an approval dialog nobody answers
  const node = new MuseNodeService({ rpc: fakeRpc(), identity: { nodeId: 'n1', displayName: 'T' }, registry: registry(invoke), logger: quiet, ledger, heartbeatMs: 3600000 });
  node.handleInvoke({ invoke_id: 'inv-3', command_id: 'ping', params_json: '{}' });
  await sleep(0);
  const started = Date.now();
  await node.close();
  assert.ok(Date.now() - started < 100, 'close returned immediately');
  assert.equal(ledger.running, 1, 'the command stays tracked for the next session');
});

function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { return error.code !== 'ESRCH'; }
  // a zombie still answers kill(0); check /proc state
  try { return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}

test('shell.exec timeout kills the whole process group, grandchildren included', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-shell-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const result = await shellExec({ command: `sleep 30 & echo $! > '${pidFile}'; wait`, timeout_ms: 300 }, { graceMs: 200 });
  assert.equal(result.timed_out, true);
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  await sleep(400);
  assert.equal(alive(grandchild), false, `grandchild ${grandchild} must be gone`);
  assert.equal(activeGroups.size, 0);
});

test('shell.exec returns when bash exits even if a background child holds stdout, and reaps it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-shell-'));
  const pidFile = path.join(dir, 'bg.pid');
  const started = Date.now();
  const result = await shellExec({ command: `sleep 30 & echo $! > '${pidFile}'; echo done`, timeout_ms: 20000 });
  assert.ok(Date.now() - started < 5000, 'did not wait for the background sleep');
  assert.equal(result.ok, true);
  assert.match(result.stdout, /done/);
  await sleep(200);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false, 'background child reaped');
});
