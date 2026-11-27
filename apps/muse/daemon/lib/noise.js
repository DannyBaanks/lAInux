'use strict';

const crypto = require('node:crypto');
const { EMPTY, concat, equal, u8 } = require('./bytes');

const PROTOCOL_NAME = Buffer.from('Noise_XX_25519_AESGCM_SHA256', 'utf8');
const HASH_LENGTH = 32;
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

function sha256(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(u8(part));
  return hash.digest();
}

function hmac(key, data) {
  return crypto.createHmac('sha256', u8(key)).update(u8(data)).digest();
}

// Noise HKDF: HMAC-HASH chaining key, empty info, 2 or 3 outputs.
function hkdf(chainingKey, inputKeyMaterial, outputs = 2) {
  const tempKey = hmac(chainingKey, inputKeyMaterial);
  const result = [];
  let previous = EMPTY;
  for (let index = 1; index <= outputs; index += 1) {
    previous = hmac(tempKey, concat(previous, Uint8Array.of(index)));
    result.push(previous);
  }
  tempKey.fill(0);
  return result;
}

function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

function generateX25519() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey, privateKey, publicKeyBytes: rawPublicKey(publicKey) };
}

function importPublicKey(bytes) {
  return crypto.createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(u8(bytes)).toString('base64url') },
  });
}

function importPrivateKey(bytes) {
  if (bytes.length !== 32) throw new Error('X25519 private key must be 32 bytes');
  const privateKey = crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'X25519', d: Buffer.from(u8(bytes)).toString('base64url') },
  });
  return {
    privateKey,
    publicKey: crypto.createPublicKey(privateKey),
    publicKeyBytes: rawPublicKey(crypto.createPublicKey(privateKey)),
  };
}

function dh(privateKey, publicBytes) {
  const secret = crypto.diffieHellman({ privateKey, publicKey: importPublicKey(publicBytes) });
  if (equal(secret, Buffer.alloc(32))) throw new Error('x25519: DH produced all-zeros output');
  return secret;
}

function nonce64(counter) {
  // Muse's WebCrypto implementation uses 4 zero bytes + uint64 big-endian.
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

class CipherState {
  constructor(key = null) {
    this.key = key ? Buffer.from(key) : null;
    this.n = 0;
    this.poisoned = false;
  }

  assertLive() {
    if (this.poisoned) throw new Error('CipherState: poisoned after prior failure');
  }

  hasKey() {
    return this.key !== null;
  }

  nextNonce() {
    if (this.n >= MAX_NONCE) {
      this.poisoned = true;
      throw new Error('CipherState: nonce exhausted');
    }
    return nonce64(this.n++);
  }

  encryptWithAd(additionalData, plaintext) {
    this.assertLive();
    if (!this.key) return u8(plaintext);
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', this.key, this.nextNonce());
      cipher.setAAD(u8(additionalData), { plaintextLength: plaintext.length });
      return concat(cipher.update(u8(plaintext)), cipher.final(), cipher.getAuthTag());
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  decryptWithAd(additionalData, ciphertext) {
    this.assertLive();
    if (!this.key) return u8(ciphertext);
    try {
      if (ciphertext.length < 16) throw new Error('AES-GCM ciphertext is shorter than its tag');
      const body = ciphertext.subarray(0, ciphertext.length - 16);
      const tag = ciphertext.subarray(ciphertext.length - 16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, this.nextNonce());
      decipher.setAAD(u8(additionalData), { plaintextLength: body.length });
      decipher.setAuthTag(tag);
      return concat(decipher.update(body), decipher.final());
    } catch (error) {
      this.poisoned = true;
      throw error;
    }
  }

  destroy() {
    if (this.key) this.key.fill(0);
    this.key = null;
    this.poisoned = true;
  }
}

class SymmetricState {
  constructor() {
    const paddedName = Buffer.alloc(HASH_LENGTH);
    paddedName.set(PROTOCOL_NAME);
    this.ck = paddedName;
    this.h = sha256(paddedName); // MixHash(empty prologue).
    this.cipher = new CipherState();
  }

  mixHash(data) {
    this.h = sha256(this.h, data);
  }

  mixKey(inputKeyMaterial) {
    const [chainingKey, key] = hkdf(this.ck, inputKeyMaterial, 2);
    this.ck.fill(0);
    this.ck = chainingKey;
    this.cipher = new CipherState(key);
    key.fill(0);
  }

  encryptAndHash(plaintext) {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  handshakeHash() {
    return Buffer.from(this.h);
  }

  split() {
    const [first, second] = hkdf(this.ck, EMPTY, 2);
    this.ck.fill(0);
    this.h.fill(0);
    const keys = [new CipherState(first), new CipherState(second)];
    first.fill(0);
    second.fill(0);
    return keys;
  }
}

function assertPhase(handshake, expected, operation) {
  if (handshake.phase === 'dead') throw new Error(`NoiseXX: ${operation} called on dead handshake`);
  if (handshake.phase !== expected) {
    throw new Error(`NoiseXX: ${operation} called in wrong phase (expected ${expected}, got ${handshake.phase})`);
  }
}

class NoiseXXInitiator {
  constructor() {
    this.phase = 'new';
    this.symmetric = new SymmetricState();
    this.e = null;
    this.s = null;
    this.re = null;
    this.rs = null;
  }

  initialize() {
    assertPhase(this, 'new', 'initialize');
    this.phase = 'initialized';
  }

  writeMessage1(payload = EMPTY) {
    assertPhase(this, 'initialized', 'writeMessage1');
    try {
      this.e = generateX25519();
      this.symmetric.mixHash(this.e.publicKeyBytes);
      const encryptedPayload = this.symmetric.encryptAndHash(payload);
      this.phase = 'message1';
      return concat(this.e.publicKeyBytes, encryptedPayload);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  readMessage2(message) {
    assertPhase(this, 'message1', 'readMessage2');
    if (message.length < 96) {
      this.destroy();
      throw new Error(`NoiseXX: message 2 too short (${message.length} < 96)`);
    }
    try {
      this.re = Buffer.from(message.subarray(0, 32));
      this.symmetric.mixHash(this.re);
      this.symmetric.mixKey(dh(this.e.privateKey, this.re));
      this.rs = Buffer.from(this.symmetric.decryptAndHash(message.subarray(32, 80)));
      this.symmetric.mixKey(dh(this.e.privateKey, this.rs));
      const payload = this.symmetric.decryptAndHash(message.subarray(80));
      this.phase = 'message2';
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  writeMessage3(payload = EMPTY) {
    assertPhase(this, 'message2', 'writeMessage3');
    try {
      // The Muse web client generates a fresh initiator static key per session.
      this.s = generateX25519();
      const encryptedStatic = this.symmetric.encryptAndHash(this.s.publicKeyBytes);
      this.symmetric.mixKey(dh(this.s.privateKey, this.re));
      const encryptedPayload = this.symmetric.encryptAndHash(payload);
      this.phase = 'message3';
      return concat(encryptedStatic, encryptedPayload);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  split() {
    assertPhase(this, 'message3', 'split');
    this.phase = 'split';
    return this.symmetric.split();
  }

  remoteStaticPublicKey() {
    return this.rs ? Buffer.from(this.rs) : null;
  }

  handshakeHash() {
    return this.symmetric.handshakeHash();
  }

  destroy() {
    this.symmetric.ck.fill(0);
    this.symmetric.h.fill(0);
    this.phase = 'dead';
  }
}

class NoiseXXResponder {
  constructor(staticPrivateKey = null) {
    this.phase = 'new';
    this.symmetric = new SymmetricState();
    this.s = staticPrivateKey ? importPrivateKey(staticPrivateKey) : generateX25519();
    this.e = null;
    this.re = null;
    this.rs = null;
  }

  initialize() {
    assertPhase(this, 'new', 'initialize');
    this.phase = 'initialized';
  }

  readMessage1(message) {
    assertPhase(this, 'initialized', 'readMessage1');
    if (message.length < 32) {
      this.destroy();
      throw new Error('NoiseXX: message 1 too short');
    }
    try {
      this.re = Buffer.from(message.subarray(0, 32));
      this.symmetric.mixHash(this.re);
      const payload = this.symmetric.decryptAndHash(message.subarray(32));
      this.phase = 'message1';
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  writeMessage2(payload = EMPTY) {
    assertPhase(this, 'message1', 'writeMessage2');
    try {
      this.e = generateX25519();
      this.symmetric.mixHash(this.e.publicKeyBytes);
      this.symmetric.mixKey(dh(this.e.privateKey, this.re));
      const encryptedStatic = this.symmetric.encryptAndHash(this.s.publicKeyBytes);
      this.symmetric.mixKey(dh(this.s.privateKey, this.re));
      const encryptedPayload = this.symmetric.encryptAndHash(payload);
      this.phase = 'message2';
      return concat(this.e.publicKeyBytes, encryptedStatic, encryptedPayload);
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  readMessage3(message) {
    assertPhase(this, 'message2', 'readMessage3');
    if (message.length < 48) {
      this.destroy();
      throw new Error('NoiseXX: message 3 too short');
    }
    try {
      this.rs = Buffer.from(this.symmetric.decryptAndHash(message.subarray(0, 48)));
      this.symmetric.mixKey(dh(this.e.privateKey, this.rs));
      const payload = this.symmetric.decryptAndHash(message.subarray(48));
      this.phase = 'message3';
      return payload;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }

  split() {
    assertPhase(this, 'message3', 'split');
    this.phase = 'split';
    const [first, second] = this.symmetric.split();
    return [second, first];
  }

  staticPublicKey() {
    return Buffer.from(this.s.publicKeyBytes);
  }

  remoteStaticPublicKey() {
    return this.rs ? Buffer.from(this.rs) : null;
  }

  destroy() {
    this.symmetric.ck.fill(0);
    this.symmetric.h.fill(0);
    this.phase = 'dead';
  }
}

// HKDF-SHA256(recovery secret, salt="", info="hatch:rv-luks:v1:<vmId>", 32).
function deriveRvKey(recoverySecret, vmId) {
  const secret = u8(recoverySecret);
  if (secret.length !== 32) throw new Error('CVM recovery secret must be exactly 32 bytes');
  if (typeof vmId !== 'string' || !vmId.trim() || vmId !== vmId.trim()) {
    throw new Error('CVM VM id is required for recovery-key derivation');
  }
  return Buffer.from(crypto.hkdfSync('sha256', secret, EMPTY, `hatch:rv-luks:v1:${vmId}`, 32));
}

module.exports = {
  CipherState,
  NoiseXXInitiator,
  NoiseXXResponder,
  deriveRvKey,
  generateX25519,
  importPrivateKey,
  rawPublicKey,
  hkdf,
  nonce64,
};
