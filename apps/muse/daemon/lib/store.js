'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function defaultProfile() {
  return process.env.MUSE_PROFILE || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'muse-desktop');
}

function loadOrCreateIdentity(profile = defaultProfile()) {
  const identityPath = path.join(profile, 'node-identity.json');
  if (fs.existsSync(identityPath)) {
    const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    if (identity.version !== 1 || typeof identity.nodeId !== 'string' || typeof identity.recoverySecret !== 'string') {
      throw new Error('Invalid Muse node identity');
    }
    const recoverySecret = Buffer.from(identity.recoverySecret, 'base64url');
    if (recoverySecret.length !== 32) throw new Error('Invalid Muse recovery secret');
    return { ...identity, recoverySecret };
  }
  const identity = {
    version: 1,
    nodeId: crypto.randomUUID(),
    displayName: `${os.hostname()} (Linux)`,
    platform: 'linux',
    recoverySecret: crypto.randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const temporary = `${identityPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, identityPath);
  fs.chmodSync(identityPath, 0o600);
  return { ...identity, recoverySecret: Buffer.from(identity.recoverySecret, 'base64url') };
}

module.exports = { defaultProfile, loadOrCreateIdentity };
