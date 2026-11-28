'use strict';

// Telegram approval channel: a port of ISyCode's telegram contract
// (src/isycode/telegram/{transport,owner,cli}.py) to muse-node.
//
// - One paired PRIVATE chat: bot id + user id, chat id == user id. Anything
//   else (groups, other users, bots, forwards) is dropped silently.
// - The bot token lives in the desktop keyring, never in a file, argv, log
//   or exception text. Only a whitelist of Bot API methods can be called.
// - A review is a random 32-char callback id bound to one request digest,
//   one message id and a <=120 s deadline. It is single-use and lives only
//   in this process: a restart forgets every pending button.
// - The buttons answer the Approval Broker; they never create a grant. The
//   only operator switches reachable from the phone are Flow (time-boxed,
//   see flow.js) and the panic lock. Unlocking needs the terminal.
// - Telegram's servers see the request preview; long token-like strings are
//   masked before it leaves this computer, and messages are protect_content.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe } = require('./approval');

const TOKEN = /^[0-9]{5,16}:[A-Za-z0-9_-]{20,100}$/;
const METHODS = new Set(['getMe', 'getWebhookInfo', 'getUpdates', 'sendMessage', 'editMessageText', 'answerCallbackQuery']);
const MAX_RESPONSE = 4 * 1024 * 1024;
const CALLBACK_ID = /^[A-Za-z0-9_-]{32}$/;
const FLOW_BUTTON_MINUTES = 30;

class TelegramError extends Error {
  constructor(code, retryAfter = 0) { super(code); this.code = code; this.retryAfter = retryAfter; }
}

class TelegramTransport {
  constructor({ token, fetchImpl = globalThis.fetch }) {
    this.token = token; // () => string; read on every call, never stored in logs
    this.fetchImpl = fetchImpl;
  }

  async call(method, payload = {}, { signal, timeoutMs = 45000 } = {}) {
    if (!METHODS.has(method)) throw new TelegramError('method_not_allowed');
    let response;
    let text;
    try {
      const secret = this.token();
      if (typeof secret !== 'string' || !TOKEN.test(secret)) throw new TelegramError('credential_unavailable');
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      response = await this.fetchImpl(`https://api.telegram.org/bot${secret}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any(signals),
      });
      text = await response.text();
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      // Never surface the original error: its message or cause can carry the URL.
      throw new TelegramError(signal?.aborted ? 'aborted' : 'transport_failure');
    }
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw new TelegramError('response_too_large');
    let body;
    try { body = JSON.parse(text); } catch { throw new TelegramError('malformed_response'); }
    const code = body?.error_code ?? response.status;
    if (code === 429) {
      const retry = body?.parameters?.retry_after;
      throw new TelegramError('rate_limited', Number.isInteger(retry) ? Math.min(3600, Math.max(1, retry)) : 1);
    }
    if (code === 409) throw new TelegramError('polling_conflict');
    if (response.status !== 200 || body?.ok !== true || !('result' in body)) {
      throw new TelegramError(response.status >= 400 && response.status < 500 ? 'telegram_rejected' : 'transport_failure');
    }
    return body.result;
  }

  async getMe() {
    const me = await this.call('getMe');
    if (me?.is_bot !== true || !Number.isSafeInteger(me.id) || me.id <= 0) throw new TelegramError('invalid_bot_identity');
    return { id: me.id, username: typeof me.username === 'string' ? me.username : '' };
  }

  async ensurePolling() {
    const info = await this.call('getWebhookInfo');
    if (info?.url !== '') throw new TelegramError('webhook_conflict');
  }

  async getUpdates(offset, { timeout = 25, signal } = {}) {
    const result = await this.call('getUpdates', { offset, timeout, limit: 100, allowed_updates: ['message', 'callback_query'] },
      { signal, timeoutMs: (timeout + 15) * 1000 });
    if (!Array.isArray(result) || result.length > 100 || result.some((row) => !Number.isSafeInteger(row?.update_id) || row.update_id < 0)) {
      throw new TelegramError('malformed_updates');
    }
    return result.sort((a, b) => a.update_id - b.update_id);
  }

  static receipt(result, chatId) {
    if (result?.chat?.id !== chatId || result.chat.type !== 'private' || !Number.isSafeInteger(result.message_id) || result.message_id <= 0) {
      throw new TelegramError('unverified_delivery');
    }
    return { chatId, messageId: result.message_id };
  }

  async send(chatId, text, markup = null) {
    const payload = { chat_id: chatId, text, protect_content: true, link_preview_options: { is_disabled: true } };
    if (markup) payload.reply_markup = markup;
    return TelegramTransport.receipt(await this.call('sendMessage', payload), chatId);
  }

  async edit(chatId, messageId, text) {
    const result = await this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text, reply_markup: { inline_keyboard: [] }, link_preview_options: { is_disabled: true },
    });
    const receipt = TelegramTransport.receipt(result, chatId);
    if (receipt.messageId !== messageId) throw new TelegramError('unverified_delivery');
    return receipt;
  }

  async answerCallback(callbackQueryId, text = '') {
    if (typeof callbackQueryId !== 'string' || !callbackQueryId || callbackQueryId.length > 128) return;
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text.slice(0, 190) });
  }
}

class Peer {
  constructor({ bot_id: botId, user_id: userId, chat_id: chatId }) {
    Object.assign(this, { botId, userId, chatId });
    Object.freeze(this);
  }

  valid() {
    const id = (value) => Number.isSafeInteger(value) && value > 0;
    return id(this.botId) && id(this.userId) && this.chatId === this.userId;
  }

  // A message (or the message under a pressed button) in the paired private
  // chat, sent/pressed by the paired human. Forwards never count.
  accepts(message, sender) {
    if (!this.valid() || !message || typeof message !== 'object' || !sender || typeof sender !== 'object') return false;
    return message.chat?.type === 'private' && message.chat.id === this.chatId
      && sender.id === this.userId && sender.is_bot === false
      && !['forward_origin', 'forward_from', 'forward_from_chat', 'is_automatic_forward'].some((key) => key in message);
  }

  toJSON() { return { bot_id: this.botId, user_id: this.userId, chat_id: this.chatId }; }
}

// Strings that look like secrets do not leave this computer.
function maskForExport(text) {
  return String(text ?? '').replace(/[A-Za-z0-9_\-+=]{32,}/g, '«oculto»');
}

// "/flow [30|30m|2h] [terminal]" -> { minutes, scope }
function parseFlowArgs(args) {
  let minutes = FLOW_BUTTON_MINUTES;
  let scope = 'write';
  for (const arg of args) {
    const match = /^(\d+)\s*(m|min|h)?$/i.exec(arg);
    if (match) minutes = Number(match[1]) * (match[2]?.toLowerCase() === 'h' ? 60 : 1);
    else if (/^(terminal|shell|todo|all)$/i.test(arg)) scope = 'all';
    else return null;
  }
  return { minutes, scope };
}

function formatRemaining(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

class TelegramApprovals {
  constructor({ transport, peer, flow = null, authority = null, hostname = os.hostname(), ttlMs = 110000, logger = console, now = () => Date.now() }) {
    if (!(peer instanceof Peer) || !peer.valid()) throw new Error('invalid Telegram peer');
    this.name = 'telegram';
    Object.assign(this, { transport, peer, flow, authority, hostname, logger, now });
    this.ttlMs = Math.min(120000, Math.max(1000, ttlMs));
    this.pending = new Map(); // callbackId -> { digest, messageId, expiresAt, text, finish }
    this.offset = 0;
    this.healthy = false;
    this.stopped = false;
    this.controller = new AbortController();
    this.loop = null;
  }

  available() { return this.healthy && !this.stopped; }

  start() {
    if (!this.loop) this.loop = this.run();
    return this;
  }

  async stop() {
    this.stopped = true;
    this.controller.abort('stopping');
    for (const review of this.pending.values()) review.finish(null, '🔌 muse-node se detuvo: esta petición ya no vale.');
    await this.loop?.catch(() => {});
  }

  async run() {
    let backoff = 2000;
    while (!this.stopped) {
      try {
        if (!this.healthy) {
          await this.transport.ensurePolling();
          // Old taps and commands queued while we were offline never act.
          for (;;) {
            const stale = await this.transport.getUpdates(this.offset, { timeout: 0, signal: this.controller.signal });
            if (!stale.length) break;
            this.offset = stale.at(-1).update_id + 1;
          }
          this.healthy = true;
          backoff = 2000;
          this.logger.log('[muse-node] telegram: approval channel ready');
        }
        const updates = await this.transport.getUpdates(this.offset, { signal: this.controller.signal });
        for (const update of updates) {
          this.offset = update.update_id + 1;
          try { await this.handleUpdate(update); }
          catch (error) { this.logger.error(`[muse-node] telegram update ignored: ${error.code ?? error.message}`); }
        }
      } catch (error) {
        if (this.stopped) break;
        this.healthy = false;
        const wait = error.retryAfter ? error.retryAfter * 1000 : backoff;
        this.logger.error(`[muse-node] telegram: ${error.code ?? 'error'}; retry in ${Math.round(wait / 1000)} s`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, wait);
          this.controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        backoff = Math.min(backoff * 2, 60000);
      }
    }
  }

  reviewText(request) {
    const { title, body } = describe(request);
    return maskForExport(`🔐 ${title}\n💻 ${this.hostname}\n\n${body}\n\nHuella: ${String(request.digest ?? '').slice(0, 12)}\nCaduca en ${Math.round(this.ttlMs / 1000)} s.`).slice(0, 3800);
  }

  // Approval Broker channel.
  async ask(request, { signal } = {}) {
    if (!this.available() || signal?.aborted) return null;
    if (!/^[a-f0-9]{64}$/.test(String(request.digest ?? ''))) return null;
    for (const [id, review] of this.pending) if (review.expiresAt <= this.now()) review.finish(null, '⌛ Caducó.');
    if (this.pending.size >= 32) return null;
    const callbackId = crypto.randomBytes(24).toString('base64url');
    const text = this.reviewText(request);
    let receipt;
    try {
      receipt = await this.transport.send(this.peer.chatId, text, {
        inline_keyboard: [
          [{ text: '✅ Permitir', callback_data: `a:${callbackId}` }, { text: '❌ Rechazar', callback_data: `r:${callbackId}` }],
          [{ text: `⚡ Permitir + Flow ${FLOW_BUTTON_MINUTES} min`, callback_data: `f:${callbackId}` }],
        ],
      });
    } catch (error) {
      this.logger.error(`[muse-node] telegram approval not delivered: ${error.code ?? 'error'}`);
      return null;
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = (answer, footer) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(callbackId);
        this.transport.edit(this.peer.chatId, receipt.messageId, `${text}\n\n${footer}`).catch(() => {});
        resolve(answer);
      };
      const onAbort = () => finish(null, String(signal.reason ?? '').startsWith('resolved:desktop') ? '🖥 Resuelto en la PC.' : '⌛ Caducó sin respuesta: rechazado.');
      const timer = setTimeout(() => finish(null, '⌛ Caducó sin respuesta: rechazado.'), this.ttlMs);
      this.pending.set(callbackId, { digest: request.digest, shell: request.command_id === 'shell.exec', messageId: receipt.messageId, expiresAt: this.now() + this.ttlMs, finish });
      signal?.addEventListener('abort', onAbort, { once: true });
      // Answered elsewhere while the message was in flight.
      if (signal?.aborted) onAbort();
    });
  }

  async handleUpdate(update) {
    const callback = update.callback_query;
    const message = callback ? callback.message : update.message;
    const sender = callback ? callback.from : update.message?.from;
    if (!this.peer.accepts(message, sender)) return; // not our human, not our chat: silence
    if (callback) return this.handleCallback(callback, message);
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (text.startsWith('/')) return this.handleCommand(text);
  }

  async handleCallback(callback, message) {
    const data = typeof callback.data === 'string' ? callback.data : '';
    const kind = data.slice(0, 2);
    const id = data.slice(2);
    const review = ['a:', 'r:', 'f:'].includes(kind) && CALLBACK_ID.test(id) ? this.pending.get(id) : null;
    // (the Flow button covers the kind of action it was pressed on)
    // The button must sit on the exact message we sent for this review, from our bot.
    if (!review || message.message_id !== review.messageId || message.from?.id !== this.peer.botId || review.expiresAt <= this.now()) {
      await this.transport.answerCallback(callback.id, 'Esta petición ya no es válida.').catch(() => {});
      return;
    }
    let flowNote = '';
    if (kind === 'f:' && this.flow) {
      try {
        const state = this.flow.enable(FLOW_BUTTON_MINUTES, 'telegram', review.shell ? 'all' : 'write');
        flowNote = `\n⚡ Flow (${state.scope === 'all' ? 'escritura + terminal' : 'escritura'}) activo hasta ${new Date(state.until).toLocaleTimeString('es')}.`;
      } catch (error) {
        flowNote = `\n(Flow no se pudo activar: ${error.message})`;
      }
    }
    const approved = kind !== 'r:';
    review.finish({ approved, channel: 'telegram', ...(kind === 'f:' ? { flow: true } : {}) },
      `${approved ? '✅ Permitido' : '❌ Rechazado'} desde Telegram.${flowNote}`);
    await this.transport.answerCallback(callback.id, approved ? 'Permitido' : 'Rechazado').catch(() => {});
  }

  async handleCommand(text) {
    const [command, ...rest] = text.split(/\s+/);
    const argument = rest[0];
    const reply = (value) => this.transport.send(this.peer.chatId, value).catch(() => {});
    const flowLine = () => {
      const state = this.flow?.status() ?? { active: false };
      return state.active ? `⚡ Flow (${state.scope === 'all' ? 'escritura + terminal' : 'escritura'}) activo, quedan ${formatRemaining(state.remainingMs)}.` : 'Flow apagado: te pido permiso para escribir y ejecutar.';
    };
    if (command === '/flow') {
      if (!this.flow) return reply('Flow no está disponible.');
      if (argument === 'off') { this.flow.disable(); return reply('Flow apagado.'); }
      const parsed = parseFlowArgs(rest);
      if (!parsed) return reply('Uso: /flow 30 · /flow 2h · /flow 30 terminal · /flow off');
      try { this.flow.enable(parsed.minutes, 'telegram', parsed.scope); } catch (error) { return reply(error.message); }
      return reply(`${flowLine()}\nSolo dentro de las carpetas que ya autorizaste; ~/.ssh y credenciales siguen negadas. /flow off para apagarlo.${parsed.scope === 'all' ? '\n⚠️ Incluye la terminal: un comando así corre con todo tu poder de usuario.' : ''}`);
    }
    if (command === '/bloquear') {
      if (!this.authority) return reply('No disponible.');
      this.authority.setLocked(true);
      this.flow?.disable();
      return reply('🔒 muse-node BLOQUEADO: todo se niega salvo ping. Para desbloquear, en la PC: muse-node unlock');
    }
    if (command === '/estado' || command === '/start' || command === '/ayuda') {
      let locked = false;
      try { locked = Boolean(this.authority?.policy().locked); } catch {}
      return reply([
        `💻 ${this.hostname}: muse-node en línea${locked ? ' · 🔒 BLOQUEADO' : ''}.`,
        flowLine(),
        `Peticiones esperando respuesta: ${this.pending.size}.`,
        '',
        '/flow 30 — no pedir permiso para escribir 30 min (o /flow 2h)',
        '/flow 30 terminal — también comandos (con cuidado)',
        '/flow off — volver a pedir permiso',
        '/bloquear — negar todo ya (desbloqueo solo en la PC)',
      ].join('\n'));
    }
  }

  notify(text) {
    if (!this.available()) return;
    this.transport.send(this.peer.chatId, maskForExport(text).slice(0, 3800)).catch(() => {});
  }
}

// ---- pairing state ---------------------------------------------------------

function defaultPeerFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'lainux-mods', 'telegram-peer.json');
}

function readPeer(file = defaultPeerFile()) {
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || (info.mode & 0o077) || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error(`${file} must be a private regular file owned by you`);
  }
  const peer = new Peer(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!peer.valid()) throw new Error('invalid Telegram pairing');
  return peer;
}

function writePeer(peer, file = defaultPeerFile()) {
  if (!(peer instanceof Peer) || !peer.valid()) throw new Error('invalid Telegram peer');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(peer), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// Wait for "/pair <pin>" in a private chat with the bot. The PIN is shown only
// in the operator's terminal, so whoever sends it is looking at that terminal.
async function waitForPairing(transport, pin, { timeoutMs = 180000, now = () => Date.now() } = {}) {
  const deadline = now() + timeoutMs;
  let offset = 0;
  for (;;) {
    const stale = await transport.getUpdates(offset, { timeout: 0 });
    if (!stale.length) break;
    offset = stale.at(-1).update_id + 1;
  }
  while (now() < deadline) {
    const updates = await transport.getUpdates(offset, { timeout: Math.max(1, Math.min(25, Math.floor((deadline - now()) / 1000))) });
    for (const update of updates) {
      offset = update.update_id + 1;
      const message = update.message;
      const from = message?.from;
      const candidate = from && Number.isSafeInteger(from.id) ? new Peer({ bot_id: 1, user_id: from.id, chat_id: from.id }) : null;
      if (candidate?.accepts(message, from) && message.text?.trim() === `/pair ${pin}`) {
        await transport.getUpdates(offset, { timeout: 0 }); // confirm, so the PIN is not replayed
        return { userId: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username ?? '' };
      }
    }
  }
  throw new Error('pairing expired: the PIN was not received in time');
}

module.exports = {
  parseFlowArgs, TelegramTransport, TelegramError, TelegramApprovals, Peer, maskForExport, readPeer, writePeer, defaultPeerFile, waitForPairing, TOKEN, FLOW_BUTTON_MINUTES,
};
