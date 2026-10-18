import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, chmodSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { request } from 'node:https';

const MAX_BYTES = 256 * 1024;
const TTL_MS = 60 * 60 * 1000;
const VERIFY_CACHE_MS = 5 * 60 * 1000;
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = [250, 1000, 4000];
const TIMEOUT_MS = 5000;
const MAX_OUTBOX = 1000;
const EVENT_NAMES = ['requested', 'ringing', 'accepted', 'completed', 'unavailable', 'cancelled'].map((status) => `human.${status}`);
const FILTER_KEYS = ['device_id', 'case_id'];
const RESPONSE_LIMIT = 32 * 1024;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max;
const hash = (value) => createHash('sha256').update(value).digest('hex');

class RpcError extends Error {
  constructor(code, message, reason) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

// This is intentionally conservative: only globally routable unicast is accepted.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const [first, second] = address.split(':').map((word) => Number.parseInt(word || '0', 16));
    // Restrict to global 2000::/3, excluding special, documentation and transition ranges.
    return first >= 0x2000 && first < 0x4000 && first !== 0x2002 && first !== 0x3fff
      && !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8));
  }
  return false;
}

function publicHostname(host) {
  return typeof host === 'string' && host === host.toLowerCase()
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && host.includes('.')
    && !host.includes('..') && !isIP(host)
    && !/(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test)$/.test(host);
}

function decodeSecret(secret) {
  if (typeof secret !== 'string' || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) {
    throw new RpcError(-32602, 'Invalid subscription signing secret');
  }
  const encoded = secret.slice(6);
  const key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new RpcError(-32602, 'Invalid subscription signing secret');
  }
  return key;
}

function signature(secret, id, seconds, body) {
  return `v1,${createHmac('sha256', decodeSecret(secret)).update(`${id}.${seconds}.${body}`).digest('base64')}`;
}

// DNS is checked on every connection. The validated address is pinned into the
// HTTPS request; TLS still verifies the original hostname. Redirects are not used.
async function secureFetch(urlString, options) {
  const url = new URL(urlString);
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Callback address is not public');
  }
  const pinned = addresses[0];
  return new Promise((accept, reject) => {
    const req = request(url, {
      method: options.method,
      headers: options.headers,
      signal: options.signal,
      servername: url.hostname,
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) response.destroy(new Error('Callback response too large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString('utf8');
        accept({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body) });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function eventDefinition(name) {
  return {
    name,
    description: `${name.slice(6)} state for a human handoff. accepted means handset acceptance, not an established audio call.`,
    delivery: ['webhook'],
    inputSchema: {
      type: 'object',
      properties: { device_id: { type: 'string' }, case_id: { type: 'string' } },
      additionalProperties: false,
    },
    payloadSchema: {
      type: 'object',
      properties: {
        handoff_id: { type: 'string' }, case_id: { type: 'string' }, device_id: { type: 'string' },
        status: { type: 'string', const: name.slice(6) }, simulated: { type: 'boolean' },
        audio_connected: { type: 'boolean' }, revision: { type: 'number' },
      },
      required: ['handoff_id', 'case_id', 'device_id', 'status', 'simulated'],
      additionalProperties: true,
    },
  };
}

/** One instance and private store per authenticated application/tenant. */
export class McpEvents {
  #path;
  #hosts;
  #fetch;
  #clock;
  #state;
  #timer;
  #running;
  #storageRetryAt = 0;
  #closed = false;
  #controllers = new Set();

  constructor({ storePath, allowCallbackHosts = [], fetchImpl, clock = Date.now } = {}) {
    if (!text(storePath, 4096)) throw new TypeError('A private storePath is required');
    if (!Array.isArray(allowCallbackHosts) || allowCallbackHosts.some((host) => !publicHostname(host))) {
      throw new TypeError('allowCallbackHosts must contain exact public hostnames');
    }
    this.#path = resolve(storePath);
    this.#hosts = new Set(allowCallbackHosts);
    this.#fetch = fetchImpl ?? secureFetch;
    this.#clock = clock;
    const parent = dirname(this.#path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
      throw new Error('storePath parent must be a private directory (0700)');
    }
    if (existsSync(this.#path)) {
      const file = lstatSync(this.#path);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error('Unsafe events store');
      this.#state = JSON.parse(readFileSync(this.#path, 'utf8'));
      if (this.#state.version !== 1 || !Array.isArray(this.#state.subscriptions)
        || !Array.isArray(this.#state.outbox) || !object(this.#state.seen)) throw new Error('Invalid events store');
      chmodSync(this.#path, 0o600);
    } else {
      this.#state = { version: 1, scopeId: randomUUID(), subscriptions: [], outbox: [], seen: {} };
    }
    this.#prune();
    this.#persist();
    this.#schedule();
  }

  #now() { return Number(this.#clock()); }

  #persist() {
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.#state), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, this.#path);
    chmodSync(this.#path, 0o600);
  }

  #prune() {
    const now = this.#now();
    this.#state.subscriptions = this.#state.subscriptions.filter((s) => s.expiresAt > now);
    const live = new Set(this.#state.subscriptions.map((s) => s.id));
    this.#state.outbox = this.#state.outbox.filter((job) => live.has(job.subscriptionId));
    for (const [id, seen] of Object.entries(this.#state.seen)) if (seen.expiresAt <= now) delete this.#state.seen[id];
  }

  #url(raw) {
    let url;
    try { url = new URL(raw); } catch { throw new RpcError(-32602, 'Invalid callback URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || (url.port && url.port !== '443') || !publicHostname(url.hostname) || !this.#hosts.has(url.hostname)) {
      throw new RpcError(-32602, 'Callback host is not allowed');
    }
    return url.href;
  }

  #arguments(value = {}) {
    if (!object(value) || Object.keys(value).some((key) => !FILTER_KEYS.includes(key))
      || Object.values(value).some((value) => !text(value, 256))) {
      throw new RpcError(-32602, 'Invalid event filter');
    }
    return Object.fromEntries(FILTER_KEYS.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
  }

  #key(name, argumentsValue, url) {
    return `sub_${hash(JSON.stringify([this.#state.scopeId, name, argumentsValue, url])).slice(0, 32)}`;
  }

  async #send(subscription, body, id, readJson = false) {
    // Repeat URL validation at delivery, including entries loaded from disk.
    const url = this.#url(subscription.url);
    const seconds = String(Math.floor(this.#now() / 1000));
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref?.();
    try {
      return await Promise.race([
        Promise.resolve(this.#fetch(url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': seconds,
            'webhook-signature': signature(subscription.secret, id, seconds, body),
            'X-MCP-Subscription-Id': subscription.id,
          },
          body,
        })).then(async (response) => readJson
          ? { status: response.status, ok: response.ok, jsonBody: response.ok ? await response.json() : {} }
          : response),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Callback timeout or cancellation')), { once: true })),
      ]);
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async handleRpc({ method, params = {}, id = null } = {}) {
    if (!['events/list', 'events/subscribe', 'events/unsubscribe'].includes(method)) return undefined;
    try {
      if (this.#closed) throw new RpcError(-32000, 'Events service is closed');
      this.#prune();
      if (!object(params)) throw new RpcError(-32602, 'Invalid event parameters');
      let result;
      if (method === 'events/list') {
        result = { events: EVENT_NAMES.map(eventDefinition) };
      } else {
        if (!EVENT_NAMES.includes(params.name)) throw new RpcError(-32602, 'Unknown event');
        const args = this.#arguments(params.arguments);
        const delivery = params.delivery;
        if (!object(delivery) || delivery.mode !== 'webhook') throw new RpcError(-32602, 'Only webhook delivery is supported');
        const url = this.#url(delivery.url);
        const subscriptionId = this.#key(params.name, args, url);
        if (method === 'events/unsubscribe') {
          this.#state.subscriptions = this.#state.subscriptions.filter((s) => s.id !== subscriptionId);
          this.#state.outbox = this.#state.outbox.filter((job) => job.subscriptionId !== subscriptionId);
          result = {};
        } else {
          if (params.cursor !== undefined && params.cursor !== null) throw new RpcError(-32602, 'Event replay is not supported');
          decodeSecret(delivery.secret);
          const previous = this.#state.subscriptions.find((s) => s.id === subscriptionId);
          const subscription = { id: subscriptionId, name: params.name, arguments: args, url, secret: delivery.secret,
            verifiedAt: previous?.secret === delivery.secret ? previous.verifiedAt : 0,
            expiresAt: this.#now() + TTL_MS };
          if (!subscription.verifiedAt || this.#now() - subscription.verifiedAt >= VERIFY_CACHE_MS) {
            const challenge = randomBytes(24).toString('base64url');
            try {
              const response = await this.#send(subscription, JSON.stringify({ type: 'verification', challenge }), `msg_verification_${randomUUID()}`, true);
              const echo = response.jsonBody;
              const expected = Buffer.from(challenge);
              const actual = Buffer.from(typeof echo.challenge === 'string' ? echo.challenge : '');
              if (!response.ok || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
                throw new RpcError(-32015, 'Callback verification failed', 'challenge_failed');
              }
            } catch (error) {
              if (error instanceof RpcError) throw error;
              throw new RpcError(-32015, 'Callback verification failed', 'timeout_or_unreachable');
            }
            subscription.verifiedAt = this.#now();
          }
          if (this.#closed) throw new RpcError(-32000, 'Events service is closed');
          this.#state.subscriptions = this.#state.subscriptions.filter((s) => s.id !== subscriptionId);
          this.#state.subscriptions.push(subscription);
          result = { id: subscriptionId, refreshBefore: new Date(subscription.expiresAt - 5 * 60 * 1000).toISOString(), cursor: null, truncated: false };
        }
      }
      this.#persist();
      this.#schedule();
      return { jsonrpc: '2.0', id, result };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: error instanceof RpcError ? error.code : -32603,
        message: error instanceof RpcError ? error.message : 'Events service could not save the operation',
        ...(error instanceof RpcError && error.reason ? { data: { reason: error.reason } } : {}) } };
    }
  }

  async publish(event) {
    // Delivery failure is never allowed to stop the physical handoff path.
    try {
      if (this.#closed) return { queued: 0, rejected: 'closed' };
      if (!object(event) || !text(event.eventId, 256) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(event.eventId) || !EVENT_NAMES.includes(event.name)
        || !text(event.timestamp, 64) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(event.timestamp)
        || !Number.isFinite(Date.parse(event.timestamp)) || !object(event.data)
        || !['handoff_id', 'case_id', 'device_id'].every((key) => text(event.data[key], 256))
        || event.data.status !== event.name.slice(6) || typeof event.data.simulated !== 'boolean'
        || (event.cursor !== undefined && event.cursor !== null)) return { queued: 0, rejected: 'invalid_event' };
      const payload = { eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: null };
      const body = JSON.stringify(payload);
      if (Buffer.byteLength(body) > MAX_BYTES) return { queued: 0, rejected: 'payload_too_large' };
      this.#prune();
      const seen = Object.hasOwn(this.#state.seen, event.eventId) ? this.#state.seen[event.eventId] : undefined;
      if (seen) return { queued: 0, duplicate: true, ...(seen.hash !== hash(body) ? { rejected: 'event_id_collision' } : {}) };
      const matching = this.#state.subscriptions.filter((s) => s.name === event.name
        && Object.entries(s.arguments).every(([key, value]) => event.data[key] === value));
      if (this.#state.outbox.length + matching.length > MAX_OUTBOX) return { queued: 0, rejected: 'outbox_full' };
      for (const subscription of matching) this.#state.outbox.push({ id: `${subscription.id}:${event.eventId}`,
        subscriptionId: subscription.id, eventId: event.eventId, body, attempts: 0, nextAttemptAt: this.#now() });
      this.#state.seen[event.eventId] = { hash: hash(body), expiresAt: this.#now() + SEEN_TTL_MS };
      this.#persist();
      this.#schedule();
      return { queued: matching.length };
    } catch {
      return { queued: 0, rejected: 'storage_or_event_error' };
    }
  }

  #schedule() {
    clearTimeout(this.#timer);
    if (this.#closed || this.#running) return;
    const next = Math.min(...this.#state.outbox.map((job) => job.nextAttemptAt),
      ...this.#state.subscriptions.map((subscription) => subscription.expiresAt));
    if (!Number.isFinite(next)) return;
    this.#timer = setTimeout(() => {
      this.#running = this.#drain().then(() => { this.#storageRetryAt = 0; }).catch(() => {
        this.#storageRetryAt = this.#now() + 1000;
      }).finally(() => {
        this.#running = undefined;
        this.#schedule();
      });
    }, Math.max(0, Math.min(2 ** 31 - 1, Math.max(next, this.#storageRetryAt) - this.#now())));
    this.#timer.unref?.();
  }

  async #drain() {
    this.#prune();
    this.#persist();
    while (!this.#closed) {
      const job = this.#state.outbox.find((candidate) => candidate.nextAttemptAt <= this.#now());
      if (!job) break;
      if (job.attempts > RETRY_MS.length) {
        this.#state.outbox = this.#state.outbox.filter((candidate) => candidate.id !== job.id);
        this.#persist();
        continue;
      }
      const subscription = this.#state.subscriptions.find((s) => s.id === job.subscriptionId && s.expiresAt > this.#now());
      if (!subscription) {
        this.#state.outbox = this.#state.outbox.filter((candidate) => candidate.id !== job.id);
        this.#persist();
        continue;
      }
      job.attempts += 1;
      // Persist before delivery: a crash can repeat delivery, never erase it.
      this.#persist();
      let retry = true;
      let status = 0;
      try {
        const response = await this.#send(subscription, job.body, job.eventId);
        status = response.status;
        retry = !response.ok && ([408, 425, 429].includes(status) || status >= 500);
      } catch { /* Network errors are retried with the same event ID. */ }
      if (this.#closed) break;
      if (status === 410) {
        this.#state.subscriptions = this.#state.subscriptions.filter((s) => s.id !== subscription.id);
        this.#state.outbox = this.#state.outbox.filter((candidate) => candidate.subscriptionId !== subscription.id);
      } else if (!retry || job.attempts > RETRY_MS.length) {
        this.#state.outbox = this.#state.outbox.filter((candidate) => candidate.id !== job.id);
      } else {
        job.nextAttemptAt = this.#now() + RETRY_MS[job.attempts - 1];
      }
      this.#prune();
      this.#persist();
    }
  }

  async close() {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const controller of this.#controllers) controller.abort();
    await this.#running;
  }
}
