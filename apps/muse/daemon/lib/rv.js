'use strict';

const crypto = require('node:crypto');
const { concat, EMPTY, equal } = require('./bytes');
const { decodeFields, fieldBytes, fieldString, fieldVarint } = require('./proto');

const KEY_DOMAIN = Buffer.from('hatch.noise-auth.key.v1');
const VM_KEY_LABEL = Buffer.from('vm-proof-key');
const CLIENT_KEY_LABEL = Buffer.from('client-proof-key');
const VM_PROOF_DOMAIN = Buffer.from('hatch.noise-auth.vm-proof.v1');
const CLIENT_PROOF_DOMAIN = Buffer.from('hatch.noise-auth.client-proof.v1');
const STANDARD_CLIENT_HELLO = fieldVarint(2, 1);
const ACCEPTED_VERDICTS = new Set(['accepted_host_data_bound', 'accepted_chip_and_host_data_bound']);

class ChipBindingRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChipBindingRejected';
  }
}

function hmac(key, ...parts) {
  const mac = crypto.createHmac('sha256', key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

function createClientHello() {
  const clientNonce = crypto.randomBytes(32);
  return { clientNonce, payload: fieldBytes(1, clientNonce) };
}

function decodeChipBinding(bytes) {
  try {
    const binding = { claimId: '', ownerNonce: '' };
    const seen = new Set();
    decodeFields(bytes, {
      1: (reader, wire) => {
        if (wire !== 2 || seen.has(1)) throw new Error('invalid claimId');
        seen.add(1);
        binding.claimId = Buffer.from(reader.readBytes()).toString('utf8');
      },
      2: (reader, wire) => {
        if (wire !== 2 || seen.has(2)) throw new Error('invalid ownerNonce');
        seen.add(2);
        binding.ownerNonce = Buffer.from(reader.readBytes()).toString('utf8');
      },
    });
    if (!binding.claimId || !binding.ownerNonce) throw new Error('incomplete chip binding');
    return binding;
  } catch (error) {
    throw new ChipBindingRejected(error.message);
  }
}

// Returns null for a standard/raw attestation payload, exactly like the web client.
function decodeRvChallenge(payload) {
  try {
    const challenge = { attestation: null, state: null, vmNonce: null, vmProof: null, chipBinding: null };
    const seen = new Set();
    const once = (field, wire, expected) => {
      if (wire !== expected || seen.has(field)) throw new Error('invalid RV field');
      seen.add(field);
    };
    decodeFields(payload, {
      1: (reader, wire) => { once(1, wire, 2); challenge.attestation = reader.readBytes(); },
      2: (reader, wire) => {
        once(2, wire, 0);
        const state = Number(reader.readVarint());
        challenge.state = state === 1 ? 'unprovisioned' : state === 2 ? 'provisioned' : null;
      },
      3: (reader, wire) => { once(3, wire, 2); challenge.vmNonce = reader.readBytes(); },
      4: (reader, wire) => { once(4, wire, 2); challenge.vmProof = reader.readBytes(); },
      5: (reader, wire) => { once(5, wire, 2); challenge.chipBinding = decodeChipBinding(reader.readBytes()); },
    });
    if (!challenge.attestation || !challenge.state || !challenge.vmNonce || challenge.vmNonce.length !== 32) return null;
    if (challenge.state === 'unprovisioned' && challenge.vmProof !== null) return null;
    if (challenge.state === 'provisioned' && (!challenge.vmProof || challenge.vmProof.length !== 32)) return null;
    return challenge;
  } catch (error) {
    if (error instanceof ChipBindingRejected) throw error;
    return null;
  }
}

function encodeRvChallenge(challenge) {
  const state = challenge.state === 'unprovisioned' ? 1 : challenge.state === 'provisioned' ? 2 : null;
  if (!state) throw new Error('Invalid RV state');
  return concat(
    fieldBytes(1, challenge.attestation ?? EMPTY),
    fieldVarint(2, state),
    fieldBytes(3, challenge.vmNonce),
    challenge.vmProof == null ? EMPTY : fieldBytes(4, challenge.vmProof),
    challenge.chipBinding == null ? EMPTY : fieldBytes(5, concat(
      fieldString(1, challenge.chipBinding.claimId),
      fieldString(2, challenge.chipBinding.ownerNonce),
    )),
  );
}

function assertTranscript(clientNonce, message1HandshakeHash, handshakeHash) {
  if (clientNonce?.length !== 32 || message1HandshakeHash?.length !== 32 || handshakeHash?.length !== 32) {
    throw new Error('Noise RV key and transcript hashes must be exactly 32 bytes');
  }
}

function assertVerdict(challenge, verdict) {
  if (!ACCEPTED_VERDICTS.has(verdict)) {
    const error = new Error(`Noise RV attestation verdict is not accepted: ${verdict ?? 'missing'}`);
    error.code = 'attestation_failed';
    throw error;
  }
  if (challenge.state === 'unprovisioned' && verdict !== 'accepted_chip_and_host_data_bound') {
    const error = new Error('Unprovisioned enrollment requires accepted_chip_and_host_data_bound');
    error.code = 'cvm_fresh_key_unpinned';
    throw error;
  }
}

function buildRvMessage3({
  challenge,
  rvKey,
  notaryToken,
  clientNonce,
  message1HandshakeHash,
  handshakeHash,
  attestationVerdict,
}) {
  if (!challenge || rvKey?.length !== 32) throw new Error('Noise RV challenge and 32-byte rvKey are required');
  if (typeof notaryToken !== 'string' || !notaryToken.trim()) throw new Error('Noise RV notary token is missing');
  assertTranscript(clientNonce, message1HandshakeHash, handshakeHash);
  assertVerdict(challenge, attestationVerdict);
  const token = notaryToken.trim();
  if (challenge.state === 'unprovisioned') {
    return concat(fieldString(1, token), fieldBytes(2, rvKey));
  }
  const vmProofKey = hmac(rvKey, KEY_DOMAIN, VM_KEY_LABEL);
  const expectedVmProof = hmac(vmProofKey, VM_PROOF_DOMAIN, message1HandshakeHash, clientNonce, challenge.vmNonce);
  vmProofKey.fill(0);
  if (!equal(expectedVmProof, challenge.vmProof)) {
    const error = new Error('Noise RV VM proof does not match the recovery key');
    error.code = 'cvm_key_rejected';
    throw error;
  }
  const clientProofKey = hmac(rvKey, KEY_DOMAIN, CLIENT_KEY_LABEL);
  const clientProof = hmac(clientProofKey, CLIENT_PROOF_DOMAIN, handshakeHash, challenge.vmNonce, clientNonce);
  clientProofKey.fill(0);
  try {
    return concat(fieldString(1, token), fieldBytes(3, clientProof));
  } finally {
    clientProof.fill(0);
  }
}

module.exports = {
  STANDARD_CLIENT_HELLO,
  ChipBindingRejected,
  createClientHello,
  decodeRvChallenge,
  encodeRvChallenge,
  buildRvMessage3,
};
