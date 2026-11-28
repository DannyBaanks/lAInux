'use strict';

// Approval Broker: asks every available operator channel at once (zenity on
// the desktop, the paired private Telegram chat) and takes the FIRST explicit
// answer. A "no" anywhere is as final as a "yes". A channel that cannot ask
// (no display, Telegram down) abstains; if every channel abstains or the
// deadline passes, the answer is no. Channels never see each other's answers,
// and none of them is reachable by the model: Muse's own chat (and anything it
// relays, like a WhatsApp poll) is never an approval channel.
//
// channel = { name, available(): bool, ask(request, { signal }) -> true | false | null | { approved, ... } }
// approve(request) -> { approved: boolean, channel: string|null, reason, ...extra }

function normalize(answer, channel) {
  if (answer === true || answer === false) return { approved: answer, channel };
  if (answer && typeof answer === 'object' && typeof answer.approved === 'boolean') return { ...answer, channel: answer.channel ?? channel };
  return null; // abstained
}

function createApprovalBroker({ channels, timeoutMs = 110000, logger = console }) {
  return function approve(request) {
    const active = channels.filter((channel) => {
      try { return channel.available(); } catch { return false; }
    });
    if (!active.length) return Promise.resolve({ approved: false, channel: null, reason: 'no approval channel available' });
    const controller = new AbortController();
    return new Promise((resolve) => {
      let pending = active.length;
      let settled = false;
      const finish = (result, abortReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller.abort(abortReason);
        logger.log(`[muse-node] approval ${request.command_id ?? request.action_id}: ${result.approved ? 'approved' : 'denied'} (${result.channel ?? result.reason})`);
        resolve(result);
      };
      const abstain = () => { if (--pending === 0) finish({ approved: false, channel: null, reason: 'no channel answered' }, 'no answer'); };
      const timer = setTimeout(() => finish({ approved: false, channel: null, reason: 'timeout' }, 'timeout'), timeoutMs);
      for (const channel of active) {
        Promise.resolve()
          .then(() => channel.ask(request, { signal: controller.signal }))
          .then((answer) => {
            const result = normalize(answer, channel.name);
            if (result) finish(result, `resolved:${channel.name}`); else abstain();
          }, (error) => {
            logger.error(`[muse-node] approval channel ${channel.name} failed: ${error.code ?? error.message}`);
            abstain();
          });
      }
    });
  };
}

module.exports = { createApprovalBroker, normalize };
