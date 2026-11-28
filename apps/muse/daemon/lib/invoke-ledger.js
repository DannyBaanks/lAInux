'use strict';

// Process-wide record of invocations, shared by every gateway session. After a
// reconnect the gateway may redeliver an invoke_id we already ran (or are still
// running): the ledger makes that a replay of the stored result, never a second
// execution of the command.

class InvokeLedger {
  constructor({ maxDone = 500, ttlMs = 60 * 60 * 1000, now = () => Date.now() } = {}) {
    this.maxDone = maxDone;
    this.ttlMs = ttlMs;
    this.now = now;
    this.inflight = new Map();
    this.done = new Map();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.done) {
      if (entry.at >= cutoff && this.done.size <= this.maxDone) break;
      this.done.delete(id);
    }
  }

  // run(id, execute) -> { result, replayed }
  //   replayed=false: execute() ran now for the first time
  //   replayed=true:  the result came from an earlier or concurrent run
  async run(invokeId, execute) {
    this.prune();
    const finished = this.done.get(invokeId);
    if (finished) return { result: finished.result, replayed: true };
    const running = this.inflight.get(invokeId);
    if (running) return { result: await running, replayed: true };
    // A throwing command is still recorded as done: a redelivery must replay
    // the failure, not run the command a second time.
    const promise = (async () => execute())()
      .catch((error) => ({ ok: false, error_code: 'command_failed', message: error?.message ?? String(error) }));
    this.inflight.set(invokeId, promise);
    try {
      const result = await promise;
      this.done.set(invokeId, { result, at: this.now() });
      return { result, replayed: false };
    } finally {
      this.inflight.delete(invokeId);
    }
  }

  get running() { return this.inflight.size; }
}

module.exports = { InvokeLedger };
