'use strict';

// Incremental parser for Muse subscription streams: complete JSON objects may
// arrive concatenated or split at arbitrary byte boundaries.
class JsonStreamParser {
  constructor({ maxRecordBytes = 16 * 1024 * 1024 } = {}) {
    this.maxRecordBytes = maxRecordBytes;
    this.buffer = '';
    this.decoder = new TextDecoder('utf-8');
  }

  push(data) {
    this.buffer += this.decoder.decode(data, { stream: true });
    if (this.buffer.length > this.maxRecordBytes) throw new Error('Subscription JSON record exceeds byte budget');
    const records = [];
    for (;;) {
      const start = this.buffer.search(/[^\s]/);
      if (start < 0) {
        this.buffer = '';
        return records;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer[0] !== '{') throw new Error('Subscription stream expected a JSON object');
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let index = 0; index < this.buffer.length; index += 1) {
        const character = this.buffer[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') {
          depth -= 1;
          if (depth === 0) {
            end = index + 1;
            break;
          }
          if (depth < 0) throw new Error('Malformed subscription JSON stream');
        }
      }
      if (end < 0) return records;
      records.push(JSON.parse(this.buffer.slice(0, end)));
      this.buffer = this.buffer.slice(end);
    }
  }

  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) throw new Error('Incomplete subscription JSON record');
  }
}

module.exports = { JsonStreamParser };
