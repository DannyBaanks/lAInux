'use strict';

// Append-only, hash-chained receipts: EXECUTE (Sentinel allowed, owner about
// to act), DENY (nothing happened) and RETURN (verified outcome). Each line
// carries the SHA-256 of the previous line, so an edited or removed receipt
// breaks the chain (`muse-node receipts --verify`). Receipts never store file
// contents or command output; commands are stored as a hash plus a short,
// redacted preview.

const fs = require('node:fs');
const path = require('node:path');
const { canonicalJson, sha256 } = require('./security');

const GENESIS = '0'.repeat(64);

function redact(text, limit = 120) {
  return String(text ?? '')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, '***')
    .slice(0, limit);
}

class ReceiptLog {
  constructor({ file, now = () => new Date() }) {
    this.file = file;
    this.now = now;
    this.last = null;
  }

  tail() {
    if (this.last) return this.last;
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trimEnd().split('\n').filter(Boolean);
      const last = lines.length ? JSON.parse(lines.at(-1)) : null;
      this.last = last ? { seq: last.seq, hash: last.hash } : { seq: 0, hash: GENESIS };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.last = { seq: 0, hash: GENESIS };
    }
    return this.last;
  }

  append(kind, fields) {
    const previous = this.tail();
    const body = { v: 1, seq: previous.seq + 1, at: this.now().toISOString(), kind, ...fields, prev: previous.hash };
    const hash = sha256(canonicalJson(body));
    const line = `${JSON.stringify({ ...body, hash })}\n`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, line, { mode: 0o600 });
    this.last = { seq: body.seq, hash };
    return { ...body, hash };
  }

  static verify(file) {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean); }
    catch (error) { if (error.code === 'ENOENT') return { ok: true, count: 0 }; throw error; }
    let prev = GENESIS;
    for (const [index, line] of lines.entries()) {
      const { hash, ...body } = JSON.parse(line);
      if (body.prev !== prev || sha256(canonicalJson(body)) !== hash || body.seq !== index + 1) {
        return { ok: false, count: lines.length, broken_at: index + 1 };
      }
      prev = hash;
    }
    return { ok: true, count: lines.length, head: prev };
  }
}

module.exports = { ReceiptLog, redact, GENESIS };
