'use strict';

const { randomUUID } = require('node:crypto');

const GATEWAY_ORIGIN = 'wss://hatch.metaaivm.com/v1/noise';
const DEFAULT_APP_ID = 'hatch-web';

function validateVmId(vmId) {
  if (typeof vmId !== 'string' || !vmId || vmId !== vmId.trim()) {
    throw new Error('Shared Agent Noise target vm_id must be nonempty');
  }
  if (vmId.length > 255) throw new Error('Shared Agent Noise target vm_id must not exceed 255 characters');
  return vmId;
}

function vmIdFromGatewayUrl(gatewayUrl, vmName = null) {
  let url;
  try { url = new URL(gatewayUrl); } catch { throw new Error('Invalid Shared Agent Noise gateway URL'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Invalid Shared Agent Noise gateway URL');
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'vm_id') throw new Error('Shared Agent Noise gateway contains an unexpected query parameter');
  }
  const queryIds = url.searchParams.getAll('vm_id');
  if (queryIds.length > 1) throw new Error('Shared Agent Noise gateway must contain at most one vm_id');
  const fromQuery = queryIds[0] || null;
  const hostname = url.hostname.toLowerCase();
  const fromHost = hostname.endsWith('.metaaivm.com') ? hostname.slice(0, -'.metaaivm.com'.length) : hostname || null;
  const fromName = vmName == null ? null : validateVmId(vmName);
  const vmId = fromQuery ?? fromName ?? fromHost;
  validateVmId(vmId);
  if (fromQuery && fromName && fromQuery !== fromName) {
    throw new Error('Shared Agent Noise gateway vm_id does not match the VM name');
  }
  if (fromQuery && fromHost && fromQuery !== fromHost) {
    throw new Error('Shared Agent Noise gateway vm_id does not match its host identity');
  }
  if (!fromQuery && fromName && fromHost && fromName !== fromHost) {
    throw new Error('Shared Agent Noise gateway host does not match the VM name');
  }
  return vmId;
}

function buildGatewayUrl({ gatewayUrl, vmName = null, authToken, notaryToken = null, requestId = randomUUID(), appId = DEFAULT_APP_ID, atodToken = null }) {
  const vmId = vmIdFromGatewayUrl(gatewayUrl, vmName);
  if (!authToken) throw new Error('Shared Agent OAuth token must be nonempty');
  if (!requestId) throw new Error('Shared Agent Noise request ID must be nonempty');
  const url = new URL(GATEWAY_ORIGIN);
  url.searchParams.set('vm_id', vmId);
  url.searchParams.set('auth_token', authToken);
  if (notaryToken) url.searchParams.set('notary_token', notaryToken);
  url.searchParams.set('app_id', appId || DEFAULT_APP_ID);
  url.searchParams.set('app_version', '2');
  url.searchParams.set('request_id', requestId);
  if (atodToken) url.searchParams.set('atod_token', atodToken);
  return url.toString();
}

module.exports = { GATEWAY_ORIGIN, DEFAULT_APP_ID, vmIdFromGatewayUrl, buildGatewayUrl };
