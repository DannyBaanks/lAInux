'use strict';

const { EMPTY } = require('./bytes');
const { connectNoiseGateway } = require('./gateway');
const { buildGatewayUrl, vmIdFromGatewayUrl } = require('./gateway-url');
const { deriveRvKey } = require('./noise');
const { buildRvMessage3, createClientHello, decodeRvChallenge } = require('./rv');

async function connectPrimaryGateway({
  session,
  recoverySecret,
  verifyAttestation = null,
  createWebSocket,
  timeoutMs = 15000,
}) {
  const vmId = vmIdFromGatewayUrl(session.gatewayUrl, session.vmName ?? session.vmId ?? null);
  const rvKey = deriveRvKey(recoverySecret, vmId);
  const notaryToken = session.noiseNotaryToken ?? session.notaryToken;
  const url = buildGatewayUrl({
    gatewayUrl: session.gatewayUrl,
    vmName: session.vmName ?? session.vmId ?? null,
    authToken: session.authToken ?? session.token,
    notaryToken,
    appId: session.appId,
    atodToken: session.atodToken,
  });
  const hello = createClientHello();
  let rvChallenge = null;
  let observedType = 'standard';
  try {
    const connection = await connectNoiseGateway({
      url,
      timeoutMs,
      createWebSocket,
      message1Payload: hello.payload,
      buildMessage3: async (context) => {
        rvChallenge = decodeRvChallenge(context.message2Payload);
        if (!rvChallenge) {
          if (verifyAttestation) {
            await verifyAttestation({
              observedType: 'standard',
              attestationPayload: context.message2Payload,
              serverStaticPublicKey: context.serverStaticPublicKey,
              handshakeHash: context.handshakeHash,
              clientNonce: hello.clientNonce,
            });
          }
          return EMPTY;
        }
        observedType = 'confidential';
        if (!verifyAttestation) {
          const error = new Error(`RV ${rvChallenge.state} connection requires an attestation verifier`);
          error.code = 'attestation_verifier_unavailable';
          error.rvState = rvChallenge.state;
          throw error;
        }
        const attestationVerdict = verifyAttestation
          ? await verifyAttestation({
              observedType,
              state: rvChallenge.state,
              attestationPayload: rvChallenge.attestation,
              serverStaticPublicKey: context.serverStaticPublicKey,
              handshakeHash: context.handshakeHash,
              message1HandshakeHash: context.message1HandshakeHash,
              clientNonce: hello.clientNonce,
              chipBinding: rvChallenge.chipBinding,
            })
          : null;
        return buildRvMessage3({
          challenge: rvChallenge,
          rvKey,
          notaryToken,
          clientNonce: hello.clientNonce,
          message1HandshakeHash: context.message1HandshakeHash,
          handshakeHash: context.handshakeHash,
          attestationVerdict,
        });
      },
    });
    return { ...connection, vmId, observedType, rvChallenge };
  } finally {
    rvKey.fill(0);
  }
}

module.exports = { connectPrimaryGateway };
