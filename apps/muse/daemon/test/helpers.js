'use strict';

const { NoiseXXInitiator, NoiseXXResponder } = require('../lib/noise');

function handshake({ message1 = Buffer.from('client hello'), message2 = Buffer.from('server proof'), message3 = Buffer.from('client proof') } = {}) {
  const initiator = new NoiseXXInitiator();
  const responder = new NoiseXXResponder();
  initiator.initialize();
  responder.initialize();
  const first = initiator.writeMessage1(message1);
  const firstPayload = responder.readMessage1(first);
  const second = responder.writeMessage2(message2);
  const secondPayload = initiator.readMessage2(second);
  const third = initiator.writeMessage3(message3);
  const thirdPayload = responder.readMessage3(third);
  return {
    initiator,
    responder,
    first,
    second,
    third,
    firstPayload,
    secondPayload,
    thirdPayload,
    initiatorKeys: initiator.split(),
    responderKeys: responder.split(),
  };
}

module.exports = { handshake };
