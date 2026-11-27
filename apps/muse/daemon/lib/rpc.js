'use strict';

const { randomUUID } = require('node:crypto');
const { concat, EMPTY } = require('./bytes');

function queryPath(path, params) {
  if (!params || Object.keys(params).length === 0) return path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}

function jsonBody(body) {
  if (!body.length) return null;
  try {
    return JSON.parse(Buffer.from(body).toString('utf8'));
  } catch (error) {
    throw new Error(`Noise RPC returned invalid JSON: ${error.message}`);
  }
}

class NoiseRpcClient {
  constructor(connection, { requestTimeoutMs = 30000, appId = null, onUnsolicitedFrame = null } = {}) {
    this.connection = connection;
    this.transport = connection.transport;
    this.requestTimeoutMs = requestTimeoutMs;
    this.appId = appId;
    this.onUnsolicitedFrame = onUnsolicitedFrame;
    this.pending = new Map();
    this.closed = false;
    this.removeFrameHandler = connection.setFrameHandler((frame) => this.receive(frame));
    this.closeListener = () => this.close(new Error('Noise gateway closed'));
    connection.ws.addEventListener('close', this.closeListener, { once: true });
  }

  async receive(encryptedFrame) {
    const frame = await this.transport.decryptFrame(encryptedFrame);
    if (!frame) return;
    const pending = this.pending.get(frame.streamId.toString());
    if (!pending) {
      if (this.onUnsolicitedFrame) await this.onUnsolicitedFrame(frame);
      return;
    }
    if (frame.case === 'reset') {
      this.pending.delete(frame.streamId.toString());
      clearTimeout(pending.timer);
      pending.reject(new Error(`Noise RPC stream reset (${frame.reset.code}): ${frame.reset.reason}`));
      return;
    }
    if (frame.case === 'response') {
      pending.status = frame.response.status;
      pending.headers = frame.response.headers;
      if (frame.response.body.length) pending.parts.push(frame.response.body);
      if (frame.response.endBody) pending.done = true;
    } else if (frame.case === 'bodyChunk') {
      if (frame.data.length) pending.parts.push(frame.data);
      if (pending.onBodyChunk) await pending.onBodyChunk(frame.data, frame.endBody);
      if (frame.endBody) pending.done = true;
    }
    if (pending.done) {
      this.pending.delete(frame.streamId.toString());
      clearTimeout(pending.timer);
      pending.resolve({
        streamId: frame.streamId,
        status: pending.status,
        headers: pending.headers,
        body: concat(...pending.parts),
      });
    }
  }

  headers(extra = [], includeJson = false) {
    const headers = [
      { key: 'x-request-id', value: randomUUID() },
      { key: 'Accept-Language', value: 'en-US' },
    ];
    if (this.appId) headers.push({ key: 'x-app-id', value: this.appId });
    if (includeJson) headers.push({ key: 'Content-Type', value: 'application/json' });
    for (const header of extra) {
      if (header.key.toLowerCase() === 'accept-language') continue;
      const index = headers.findIndex(({ key }) => key.toLowerCase() === header.key.toLowerCase());
      if (index >= 0) headers[index] = header;
      else headers.push(header);
    }
    return headers;
  }

  async request({ method, path, params, body, headers = [], service = 'daemon', signal, onBodyChunk }) {
    if (this.closed) throw new Error('Noise RPC client is closed');
    const upperMethod = method.toUpperCase();
    const isGet = upperMethod === 'GET';
    const requestPath = isGet ? queryPath(path, params) : path;
    const requestBody = body !== undefined
      ? Buffer.from(body)
      : !isGet && params !== undefined
        ? Buffer.from(JSON.stringify(params))
        : EMPTY;
    const request = await this.transport.encryptHttpRequest({
      service,
      httpMethod: upperMethod,
      path: requestPath,
      headers: this.headers(headers, !isGet && requestBody.length > 0),
      body: requestBody,
    });
    return new Promise((resolve, reject) => {
      const key = request.streamId.toString();
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`Noise RPC timed out: ${upperMethod} ${requestPath}`));
      }, this.requestTimeoutMs);
      const onAbort = () => {
        this.pending.delete(key);
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Noise RPC aborted'));
      };
      this.pending.set(key, {
        resolve: (response) => { signal?.removeEventListener('abort', onAbort); resolve(response); },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error); },
        timer,
        status: 0,
        headers: [],
        parts: [],
        done: false,
        onBodyChunk,
      });
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      for (const frame of request.frames) this.connection.ws.send(frame);
    });
  }

  async requestJson(options) {
    const response = await this.request(options);
    const value = jsonBody(response.body);
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(`Noise RPC ${options.method} ${options.path} failed with HTTP ${response.status}: ${Buffer.from(response.body).toString('utf8').slice(0, 500)}`);
      error.status = response.status;
      error.response = value;
      throw error;
    }
    return { ...response, json: value };
  }

  close(reason = new Error('Noise RPC client closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
    this.removeFrameHandler?.();
    this.connection.ws.removeEventListener('close', this.closeListener);
  }
}

module.exports = { NoiseRpcClient, queryPath, jsonBody };
