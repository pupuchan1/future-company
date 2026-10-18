const encoder = new TextEncoder();
export const MAX_BODY_BYTES = 256 * 1024;
export const CASE_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const SESSION_PATTERN = '[A-Za-z0-9_-]{1,200}';
const secretPattern = /^[A-Za-z0-9_-]{32,200}$/;

export function requireRelaySecret(secret) {
  if (typeof secret !== 'string' || !secretPattern.test(secret)) {
    throw new Error('NODE_RELAY_SECRET must contain 32–200 URL-safe characters.');
  }
  return secret;
}

export function voiceRoute(path, method) {
  if (path === '/status' && method === 'GET') return { kind: 'status', upstream: '/api/status' };
  if (path === '/events' && method === 'GET') return { kind: 'events', upstream: '/api/events' };
  if (path === '/results' && method === 'POST') return { kind: 'results', upstream: '/api/worker/results' };
  if (path === '/session' && method === 'POST') return { kind: 'create', upstream: '/api/live/session' };
  const match = new RegExp(`^/session/(${SESSION_PATTERN})(?:/(handoff|activate))?$`).exec(path);
  if (!match) return null;
  if (!match[2] && method === 'DELETE') return { kind: 'close', sessionId: match[1], upstream: `/api/live/session/${match[1]}` };
  if (match[2] && method === 'POST') return { kind: match[2], sessionId: match[1], upstream: `/api/live/session/${match[1]}/${match[2]}` };
  return null;
}

function hex(bytes) { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
function unhex(value) {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));
}
async function key(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(requireRelaySecret(secret)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function message({ method, path, caseId, timestamp, nonce, body = new Uint8Array() }) {
  const digest = hex(await crypto.subtle.digest('SHA-256', body));
  return encoder.encode(['future-company-relay-v1', method, path, caseId, timestamp, nonce, digest].join('\n'));
}

export async function signRelayRequest({ secret, method, path, caseId, body, now = Date.now(), nonce = crypto.randomUUID() }) {
  if (!CASE_PATTERN.test(caseId)) throw new Error('Invalid case identifier.');
  const timestamp = String(Math.floor(now / 1000));
  const signature = hex(await crypto.subtle.sign('HMAC', await key(secret), await message({ method, path, caseId, timestamp, nonce, body })));
  return {
    'x-future-case-id': caseId,
    'x-future-timestamp': timestamp,
    'x-future-nonce': nonce,
    'x-future-signature': signature,
  };
}

export async function verifyRelayRequest({ secret, method, path, headers, body, now = Date.now(), maxAgeSeconds = 30 }) {
  const caseId = headers.get('x-future-case-id') || '';
  const timestamp = headers.get('x-future-timestamp') || '';
  const nonce = headers.get('x-future-nonce') || '';
  const signature = unhex(headers.get('x-future-signature') || '');
  if (!CASE_PATTERN.test(caseId) || !/^\d{10}$/.test(timestamp) || !/^[A-Za-z0-9_-]{16,100}$/.test(nonce) || !signature) return null;
  const age = Math.floor(now / 1000) - Number(timestamp);
  if (age < -5 || age > maxAgeSeconds) return null;
  const valid = await crypto.subtle.verify('HMAC', await key(secret), signature, await message({ method, path, caseId, timestamp, nonce, body }));
  return valid ? { caseId, nonce, expiresAt: (Number(timestamp) + maxAgeSeconds + 5) * 1000 } : null;
}

export async function readBoundedBody(stream, limit = MAX_BODY_BYTES) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Object.assign(new Error('Request body too large.'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
