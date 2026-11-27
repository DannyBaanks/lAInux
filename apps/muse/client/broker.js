'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MAX_REQUEST_BYTES = 65536;
const MAX_RESPONSE_BYTES = 1048576;

function abstractSocketName() {
  if (process.platform !== 'linux') throw new Error('The Muse credential broker currently requires Linux');
  return `\0muse-desktop-${process.getuid()}-credentials`;
}

function writeBrokerConfig(profile, config) {
  const configPath = path.join(profile, 'broker.json');
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, configPath);
  fs.chmodSync(configPath, 0o600);
  return configPath;
}

function readBrokerConfig(profile) {
  const config = JSON.parse(fs.readFileSync(path.join(profile, 'broker.json'), 'utf8'));
  if (config.version !== 1 || typeof config.socket !== 'string' || typeof config.token !== 'string') {
    throw new Error('Invalid Muse broker configuration');
  }
  return config;
}

function startCredentialBroker({ profile, handler, socketPath = abstractSocketName() }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const server = net.createServer((connection) => {
    let input = '';
    let answered = false;
    connection.setEncoding('utf8');
    connection.on('data', async (chunk) => {
      input += chunk;
      if (input.length > MAX_REQUEST_BYTES || answered) {
        answered = true;
        connection.end();
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      answered = true;
      let response;
      try {
        const request = JSON.parse(input.slice(0, newline));
        if (request.token !== token) throw new Error('Broker authentication failed');
        if (typeof request.method !== 'string') throw new Error('Broker method is required');
        const result = await handler(request.method, request.params ?? {});
        response = { ok: true, result };
      } catch (error) {
        response = { ok: false, error: { code: error.code ?? 'broker_error', message: error.message } };
      }
      let encoded = JSON.stringify(response);
      if (Buffer.byteLength(encoded) > MAX_RESPONSE_BYTES) {
        encoded = JSON.stringify({ ok: false, error: { code: 'response_too_large', message: 'Broker response is too large' } });
      }
      connection.end(`${encoded}\n`);
    });
    connection.on('error', () => {});
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      const configPath = writeBrokerConfig(profile, { version: 1, socket: socketPath, token });
      resolve({
        server,
        configPath,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function brokerRequest(profile, method, params = {}, { timeoutMs = 120000 } = {}) {
  const config = readBrokerConfig(profile);
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(config.socket);
    let input = '';
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new Error(`Muse broker timed out: ${method}`));
    }, timeoutMs);
    connection.setEncoding('utf8');
    connection.on('connect', () => {
      connection.write(`${JSON.stringify({ token: config.token, method, params })}\n`);
    });
    connection.on('data', (chunk) => {
      input += chunk;
      if (input.length > MAX_RESPONSE_BYTES) {
        connection.destroy();
        clearTimeout(timer);
        reject(new Error('Muse broker response is too large'));
      }
    });
    connection.on('end', () => {
      clearTimeout(timer);
      try {
        const response = JSON.parse(input.trim());
        if (!response.ok) {
          const error = new Error(response.error?.message ?? 'Muse broker request failed');
          error.code = response.error?.code;
          reject(error);
        } else resolve(response.result);
      } catch (error) { reject(error); }
    });
    connection.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Muse shell broker is unavailable: ${error.message}. Start muse-desktop first.`));
    });
  });
}

module.exports = { abstractSocketName, startCredentialBroker, brokerRequest, readBrokerConfig };
