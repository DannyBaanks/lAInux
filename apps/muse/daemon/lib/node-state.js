'use strict';

// Explicit connection state for the Linux node. An open WebSocket is not proof
// the node works: the gateway can end the /chat/subscribe stream while the
// socket and heartbeats stay healthy, which leaves the node "online" but deaf
// (observed 2026-11-27 17:08). READY therefore means "subscription stream
// alive + capabilities accepted", and anything less is DEGRADED.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATES = Object.freeze(['DISCONNECTED', 'CONNECTING', 'REGISTERED', 'READY', 'DEGRADED', 'RECONNECTING']);

const TRANSITIONS = Object.freeze({
  DISCONNECTED: ['CONNECTING', 'RECONNECTING'],
  CONNECTING: ['REGISTERED', 'DEGRADED', 'RECONNECTING', 'DISCONNECTED'],
  REGISTERED: ['READY', 'DEGRADED', 'RECONNECTING', 'DISCONNECTED'],
  READY: ['DEGRADED', 'RECONNECTING', 'DISCONNECTED'],
  DEGRADED: ['RECONNECTING', 'DISCONNECTED'],
  RECONNECTING: ['CONNECTING', 'DISCONNECTED'],
});

function defaultStatusPath() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'muse-node', 'status.json');
}

class NodeStatus {
  constructor({ file = defaultStatusPath(), logger = console, now = () => new Date() } = {}) {
    this.file = file;
    this.logger = logger;
    this.now = now;
    this.data = {
      state: 'DISCONNECTED',
      since: now().toISOString(),
      pid: process.pid,
      sessions: 0,
      reconnects: 0,
      last_heartbeat_ok: null,
      last_invoke_ok: null,
      last_invoke_id: null,
      last_error: null,
      reason: null,
      history: [],
    };
  }

  get state() { return this.data.state; }

  transition(next, reason = null) {
    if (!STATES.includes(next)) throw new Error(`Unknown node state: ${next}`);
    const current = this.data.state;
    if (current === next) return false;
    if (!TRANSITIONS[current].includes(next)) {
      // Never throw from the daemon's control loop: record and force, so the
      // status file still reflects reality.
      this.logger.error(`[muse-node] state ${current} -> ${next} is not a declared transition (${reason ?? 'no reason'})`);
    }
    const at = this.now().toISOString();
    this.data.state = next;
    this.data.since = at;
    this.data.reason = reason;
    if (next === 'CONNECTING') this.data.sessions += 1;
    if (next === 'RECONNECTING') this.data.reconnects += 1;
    this.data.history = [...this.data.history, { at, from: current, to: next, reason }].slice(-20);
    this.logger.log(`[muse-node] state ${current} -> ${next}${reason ? ` (${reason})` : ''}`);
    this.flush();
    return true;
  }

  heartbeatOk() { this.data.last_heartbeat_ok = this.now().toISOString(); this.flush(); }

  invokeOk(invokeId) {
    this.data.last_invoke_ok = this.now().toISOString();
    this.data.last_invoke_id = invokeId;
    this.flush();
  }

  error(message) {
    this.data.last_error = { at: this.now().toISOString(), message: String(message).slice(0, 500) };
    this.flush();
  }

  flush() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (error) {
      this.logger.error(`[muse-node] status file: ${error.message}`);
    }
  }
}

module.exports = { NodeStatus, STATES, TRANSITIONS, defaultStatusPath };
