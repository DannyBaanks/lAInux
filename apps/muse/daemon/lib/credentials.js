'use strict';

const { randomUUID } = require('node:crypto');
const { vmIdFromGatewayUrl } = require('./gateway-url');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 16384;

async function hatchJson(fetchImpl, path, { method = 'GET', body, timeoutMs = 35000 } = {}) {
  const response = await fetchImpl(`https://muse.ai${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) throw new Error(`Hatch response exceeds ${MAX_JSON_BYTES} bytes`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Hatch ${path} returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok) {
    const error = new Error(`Hatch ${path} failed with HTTP ${response.status}: ${json.code ?? text.slice(0, 200)}`);
    error.status = response.status;
    error.code = json.code;
    error.retryAfterMs = json.retryAfterMs;
    throw error;
  }
  return json;
}

async function leaseVm(fetchImpl, vmType = 'standard') {
  const json = await hatchJson(fetchImpl, '/api/hatch/lease-vm', {
    method: 'POST', body: { vmType },
  });
  if (json.status !== 'assigned' || typeof json.gatewayUrl !== 'string' || !json.gatewayUrl.trim()
      || typeof json.vmName !== 'string' || !json.vmName.trim()) {
    throw new Error('VM lease returned an invalid assignment');
  }
  return {
    gatewayUrl: json.gatewayUrl.trim(),
    vmName: json.vmName.trim(),
    ...(typeof json.vmId === 'string' && json.vmId.trim() ? { vmId: json.vmId.trim() } : {}),
  };
}

async function reserveColdLease(fetchImpl, idempotencyKey = randomUUID()) {
  const json = await hatchJson(fetchImpl, '/api/hatch/cold-lease-cvm', {
    method: 'POST', body: { idempotencyKey },
  });
  if (json.ok !== true || !UUID.test(json.vmId ?? '') || typeof json.created !== 'boolean') {
    throw new Error('Invalid cold-lease reservation response');
  }
  return { vmId: json.vmId, created: json.created };
}

async function coldLeaseSession(fetchImpl, vmId) {
  if (!UUID.test(vmId)) throw new Error('Cold-lease vmId must be a canonical UUID');
  const json = await hatchJson(fetchImpl, `/api/hatch/cold-lease-cvm?vmId=${encodeURIComponent(vmId)}`);
  const session = json.session;
  if (json.ok !== true || !session || session.vmId !== vmId || session.vmName !== vmId) {
    throw new Error(`Cold lease is not ready: ${json.code ?? 'invalid session'}`);
  }
  if (typeof session.authToken !== 'string' || !session.authToken.trim()) throw new Error('Cold lease returned no authToken');
  if (typeof session.noiseNotaryToken !== 'string' || !session.noiseNotaryToken.trim()) {
    throw new Error('Cold lease returned no noiseNotaryToken');
  }
  if (!(typeof session.notaryTokenExpirationTs === 'number' || session.notaryTokenExpirationTs === null)) {
    throw new Error('Cold lease returned invalid notaryTokenExpirationTs');
  }
  if (vmIdFromGatewayUrl(session.gatewayUrl, vmId) !== vmId) throw new Error('Cold lease gateway identity mismatch');
  return {
    vmId,
    vmName: vmId,
    gatewayUrl: session.gatewayUrl,
    authToken: session.authToken.trim(),
    noiseNotaryToken: session.noiseNotaryToken.trim(),
    notaryTokenExpirationTs: session.notaryTokenExpirationTs,
  };
}

async function acquireColdLease(fetchImpl, { idempotencyKey = randomUUID(), timeoutMs = 90000, pollMs = 1500, onStatus = null } = {}) {
  const reservation = await reserveColdLease(fetchImpl, idempotencyKey);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await coldLeaseSession(fetchImpl, reservation.vmId);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      onStatus?.({ state: 'waiting', vmId: reservation.vmId, message: error.message });
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

async function noiseToken(fetchImpl, { gatewayUrl, vmName, forceRefresh = false }) {
  const json = await hatchJson(fetchImpl, '/api/hatch/token', {
    method: 'POST',
    body: {
      vmAddress: gatewayUrl,
      ...(vmName ? { vmName } : {}),
      ...(forceRefresh ? { force_refresh: true } : {}),
    },
  });
  if (typeof json.token !== 'string' || !json.token.trim()) throw new Error('Hatch token response has no token');
  return {
    authToken: json.token.trim(),
    noiseNotaryToken: typeof json.notary_token === 'string' ? json.notary_token.trim() : null,
  };
}

async function noiseNotaryToken(fetchImpl, vmName) {
  const json = await hatchJson(fetchImpl, '/api/hatch/noise-notary-token', {
    method: 'POST', body: { vmName },
  });
  if (typeof json.notaryToken !== 'string' || !json.notaryToken.trim()) throw new Error('Noise notary is unavailable');
  return json.notaryToken.trim();
}

async function standardSession(fetchImpl, { vmType = 'standard', forceRefresh = false } = {}) {
  const assignment = await leaseVm(fetchImpl, vmType);
  const token = await noiseToken(fetchImpl, { ...assignment, forceRefresh });
  const notary = token.noiseNotaryToken || await noiseNotaryToken(fetchImpl, assignment.vmName);
  return {
    ...assignment,
    vmId: assignment.vmId ?? assignment.vmName,
    vmType,
    authToken: token.authToken,
    noiseNotaryToken: notary,
  };
}

module.exports = { hatchJson, leaseVm, standardSession, reserveColdLease, coldLeaseSession, acquireColdLease, noiseToken, noiseNotaryToken };
