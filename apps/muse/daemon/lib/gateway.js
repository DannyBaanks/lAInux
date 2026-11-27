'use strict';

const { EMPTY, u8 } = require('./bytes');
const { NoiseXXInitiator } = require('./noise');
const { NoiseTransport } = require('./transport');

function socketError(message) {
  return new Error(message);
}

function binaryBytes(data) {
  if (typeof data === 'string') throw new Error('Noise gateway sent a text WebSocket message');
  return u8(data);
}

function waitForOpen(socket, timeoutSignal) {
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(socketError('Noise WebSocket connection failed')); };
    const onClose = () => { cleanup(); reject(socketError('Noise WebSocket closed before open')); };
    const onAbort = () => { cleanup(); reject(timeoutSignal.reason ?? socketError('Noise gateway connection timed out')); };
    const cleanup = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      timeoutSignal.removeEventListener('abort', onAbort);
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    timeoutSignal.addEventListener('abort', onAbort, { once: true });
    if (socket.readyState === 1) onOpen();
    else if (timeoutSignal.aborted) onAbort();
  });
}

function nextBinaryMessage(socket, timeoutSignal) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      try {
        const bytes = binaryBytes(event.data);
        cleanup();
        resolve(bytes);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => { cleanup(); reject(socketError('WebSocket closed during Noise handshake')); };
    const onError = () => { cleanup(); reject(socketError('WebSocket failed during Noise handshake')); };
    const onAbort = () => { cleanup(); reject(timeoutSignal.reason ?? socketError('Noise handshake timed out')); };
    const cleanup = () => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
      timeoutSignal.removeEventListener('abort', onAbort);
    };
    socket.addEventListener('message', onMessage);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    timeoutSignal.addEventListener('abort', onAbort, { once: true });
    if (timeoutSignal.aborted) onAbort();
  });
}

/**
 * Open the primary Muse Noise gateway. RV/attestation policy stays in the
 * supplied buildMessage3 hook; this module owns socket and Noise state only.
 */
async function connectNoiseGateway({
  url,
  timeoutMs = 10000,
  maxMessageBytes = 65535,
  createWebSocket = (target) => new WebSocket(target),
  message1Payload = EMPTY,
  buildMessage3 = async () => EMPTY,
}) {
  const socket = createWebSocket(url);
  socket.binaryType = 'arraybuffer';
  const timeout = AbortSignal.timeout(timeoutMs);
  let handshake;
  try {
    await waitForOpen(socket, timeout);
    handshake = new NoiseXXInitiator();
    handshake.initialize();
    const message1 = handshake.writeMessage1(message1Payload);
    const message1HandshakeHash = handshake.handshakeHash();
    socket.send(message1);
    const message2 = await nextBinaryMessage(socket, timeout);
    if (message2.length > maxMessageBytes) {
      throw new Error(`noise handshake message too large (${message2.length} > ${maxMessageBytes})`);
    }
    const message2Payload = handshake.readMessage2(message2);
    const context = {
      socket,
      message1Payload,
      message1HandshakeHash,
      message2Payload,
      attestationPayload: message2Payload,
      handshakeHash: handshake.handshakeHash(),
      serverStaticPublicKey: handshake.remoteStaticPublicKey(),
      assertOpen: () => {
        if (timeout.aborted) throw timeout.reason ?? socketError('Noise handshake timed out');
        if (socket.readyState !== 1) throw socketError('Noise WebSocket is not open');
      },
    };
    const message3Payload = await buildMessage3(context);
    context.assertOpen();
    const message3 = handshake.writeMessage3(message3Payload ?? EMPTY);
    socket.send(message3);
    const [sendCipher, receiveCipher] = handshake.split();
    const transport = new NoiseTransport(sendCipher, receiveCipher);
    return {
      ws: socket,
      transport,
      message2Payload,
      serverStaticPublicKey: context.serverStaticPublicKey,
      handshakeHash: context.handshakeHash,
      setFrameHandler(handler) {
        const listener = (event) => {
          Promise.resolve(handler(binaryBytes(event.data))).catch(() => socket.close());
        };
        socket.addEventListener('message', listener);
        return () => socket.removeEventListener('message', listener);
      },
      close(code = 1000, reason = '') {
        socket.close(code, reason);
      },
    };
  } catch (error) {
    if (handshake) handshake.destroy();
    try { socket.close(); } catch {}
    throw error;
  }
}

module.exports = { connectNoiseGateway, binaryBytes };
