import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { McpEvents, isPublicAddress } from './mcp-events.mjs';

const host = 'callback.example.com';
const url = `https://${host}/mcp-events`;
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const reply = (status, value = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const subscribe = (extra = {}) => ({ id: 1, method: 'events/subscribe', params: {
  name: 'human.completed', arguments: {}, delivery: { mode: 'webhook', url, secret }, cursor: null, ...extra,
} });
const event = (id = 'evt_1', extra = {}) => ({ eventId: id, name: 'human.completed', timestamp: new Date().toISOString(),
  data: { handoff_id: 'handoff_1', case_id: 'case_1', device_id: 'phone_1', status: 'completed', simulated: true }, cursor: null, ...extra });

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'future-company-mcp-events-'));
  const storePath = join(directory, 'events.json');
  const instance = new McpEvents({ storePath, allowCallbackHosts: [host], ...options });
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  return { instance, storePath };
}

async function until(check, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error('Condition timed out');
    await pause(10);
  }
}

function verifySignature(body, headers) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  assert.equal(headers['webhook-signature'], `v1,${expected}`);
  assert.ok(headers['x-mcp-subscription-id'] ?? headers['X-MCP-Subscription-Id']);
}

test('lists the six truthful handoff events and delegates unknown RPCs', async (t) => {
  const { instance } = await fixture(t);
  assert.equal(await instance.handleRpc({ method: 'tools/list' }), undefined);
  const response = await instance.handleRpc({ id: 8, method: 'events/list' });
  assert.equal(response.id, 8);
  assert.equal(response.result.events.length, 6);
  assert.ok(response.result.events.every((entry) => entry.delivery[0] === 'webhook'));
  assert.match(response.result.events.find((entry) => entry.name === 'human.accepted').description, /not an established audio call/);
});

test('verifies, privately persists and refreshes a deterministic subscription', async (t) => {
  let verifications = 0;
  const { instance, storePath } = await fixture(t, { fetchImpl: async (_url, options) => {
    verifySignature(options.body, options.headers);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.type, 'verification');
    verifications += 1;
    return reply(200, { challenge: body.challenge });
  } });
  const first = await instance.handleRpc(subscribe());
  assert.ok(first.result.id.startsWith('sub_'));
  const second = await instance.handleRpc(subscribe());
  assert.equal(second.result.id, first.result.id);
  assert.equal(verifications, 1);
  assert.equal((await stat(storePath)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(storePath, 'utf8'));
  assert.equal(stored.subscriptions.length, 1);
  assert.equal(stored.subscriptions[0].secret, secret);
  assert.ok(!JSON.stringify(first).includes(secret));
});

test('rejects non-allowlisted, local, credential-bearing and redirected callback URLs before sending', async (t) => {
  let calls = 0;
  const { instance } = await fixture(t, { fetchImpl: async () => { calls += 1; return reply(200); } });
  for (const blocked of ['http://callback.example.com/a', 'https://evil.example.com/a', 'https://callback.example.com.evil.net/a',
    'https://name:password@callback.example.com/a', 'https://127.0.0.1/a', 'https://localhost/a', 'https://callback.example.com:8443/a']) {
    const result = await instance.handleRpc(subscribe({ delivery: { mode: 'webhook', url: blocked, secret } }));
    assert.equal(result.error.code, -32602);
  }
  assert.equal(calls, 0);
  assert.throws(() => new McpEvents({ storePath: '/unused', allowCallbackHosts: ['phone.internal'] }), /exact public/);
  const { instance: empty } = await fixture(t, { allowCallbackHosts: [] });
  assert.equal((await empty.handleRpc(subscribe())).error.code, -32602);
});

test('blocks private, special, mapped and documentation IPs during DNS pinning', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.31.0.1', '192.168.0.2', '169.254.169.254', '100.64.0.1',
    '198.18.0.2', '192.0.2.1', '198.51.100.1', '203.0.113.2', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '2001:0000::1', '2002:7f00:1::', '3fff::1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(ip), true, ip);
});

test('callback verification failure has a safe categorized error and creates no subscription', async (t) => {
  const { instance, storePath } = await fixture(t, { fetchImpl: async () => reply(200, { challenge: 'wrong' }) });
  const result = await instance.handleRpc(subscribe());
  assert.equal(result.error.code, -32015);
  assert.equal(result.error.data.reason, 'challenge_failed');
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).subscriptions.length, 0);
  assert.ok(!JSON.stringify(result).includes(url));
  assert.ok(!JSON.stringify(result).includes(secret));
});

test('local callback E2E verifies Standard Webhooks and retries one immutable event after 503', async (t) => {
  const received = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      verifySignature(body, request.headers);
      const payload = JSON.parse(body);
      if (payload.type === 'verification') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }
      assert.equal(request.headers['webhook-id'], payload.eventId);
      received.push({ payload, body });
      response.writeHead(received.length === 1 ? 503 : 204);
      response.end();
    } catch (error) {
      response.writeHead(400);
      response.end(error.message);
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const { instance, storePath } = await fixture(t, { fetchImpl: (requested, options) => {
    assert.equal(requested, url);
    // Only this test adapter maps the validated public URL to a local fake receiver.
    return fetch(`http://127.0.0.1:${server.address().port}/callback`, options);
  } });
  assert.ok((await instance.handleRpc(subscribe())).result);
  const original = event();
  assert.deepEqual(await instance.publish(original), { queued: 1 });
  assert.deepEqual(await instance.publish({ ...original, data: { ...original.data, revision: 2 } }),
    { queued: 0, duplicate: true, rejected: 'event_id_collision' });
  await until(() => received.length === 2);
  assert.equal(received[0].body, received[1].body);
  assert.equal(received[0].payload.eventId, 'evt_1');
  await until(() => JSON.parse(readFileSyncForTest(storePath)).outbox.length === 0);
});

// Keep synchronous readback inside polling checks, without exposing private values.
import { readFileSync as readFileSyncForTest } from 'node:fs';

test('filters events, rejects oversized payloads and deduplicates exact published events', async (t) => {
  let delivered = 0;
  const { instance } = await fixture(t, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return reply(200, { challenge: payload.challenge });
    delivered += 1;
    return reply(204);
  } });
  await instance.handleRpc(subscribe({ arguments: { device_id: 'phone_1', case_id: 'case_1' } }));
  const original = event('evt_same');
  assert.deepEqual(await instance.publish(original), { queued: 1 });
  assert.deepEqual(await instance.publish(original), { queued: 0, duplicate: true });
  const other = event('evt_other');
  other.data.device_id = 'phone_2';
  assert.deepEqual(await instance.publish(other), { queued: 0 });
  const huge = event('evt_huge');
  huge.data.summary = 'a'.repeat(256 * 1024);
  assert.equal((await instance.publish(huge)).rejected, 'payload_too_large');
  await until(() => delivered === 1);
});

test('unsubscribe removes queued retries and is idempotent', async (t) => {
  let delivered = 0;
  const { instance, storePath } = await fixture(t, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return reply(200, { challenge: payload.challenge });
    delivered += 1;
    return reply(503);
  } });
  await instance.handleRpc(subscribe());
  await instance.publish(event());
  await until(() => delivered === 1);
  const request = subscribe(); request.method = 'events/unsubscribe'; delete request.params.delivery.secret;
  assert.deepEqual((await instance.handleRpc(request)).result, {});
  assert.deepEqual((await instance.handleRpc(request)).result, {});
  await pause(350);
  assert.equal(delivered, 1);
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).outbox.length, 0);
});

test('persisted outbox resumes after restart without new event IDs', async (t) => {
  let firstAttempts = 0;
  const { instance, storePath } = await fixture(t, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return reply(200, { challenge: payload.challenge });
    firstAttempts += 1;
    return reply(503);
  } });
  await instance.handleRpc(subscribe());
  await instance.publish(event('evt_resume'));
  await until(() => firstAttempts === 1);
  await instance.close();
  let resumed;
  const next = new McpEvents({ storePath, allowCallbackHosts: [host], fetchImpl: async (_url, options) => {
    resumed = JSON.parse(options.body);
    verifySignature(options.body, options.headers);
    return reply(204);
  } });
  t.after(() => next.close());
  await until(() => resumed !== undefined);
  assert.equal(resumed.eventId, 'evt_resume');
});

test('expired subscriptions stop delivery; 410 and 413 never retry', async (t) => {
  let now = Date.now();
  let delivered = 0;
  const { instance } = await fixture(t, { clock: () => now, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return reply(200, { challenge: payload.challenge });
    delivered += 1;
    return reply(410);
  } });
  await instance.handleRpc(subscribe());
  now += 61 * 60 * 1000;
  assert.deepEqual(await instance.publish(event('evt_expired')), { queued: 0 });
  await instance.handleRpc(subscribe());
  await instance.publish(event('evt_gone'));
  await until(() => delivered === 1);
  await pause(350);
  assert.equal(delivered, 1);
  assert.deepEqual(await instance.publish(event('evt_after_gone')), { queued: 0 });
  const { instance: tooLarge } = await fixture(t, { fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return reply(200, { challenge: payload.challenge });
    delivered += 1;
    return reply(413);
  } });
  await tooLarge.handleRpc(subscribe());
  await tooLarge.publish(event('evt_413'));
  await until(() => delivered === 2);
  await pause(350);
  assert.equal(delivered, 2);
});

test('transient delivery failure is bounded and never rejects the ring caller', async (t) => {
  let now = Date.now();
  let delivered = 0;
  const { instance, storePath } = await fixture(t, { clock: () => { now += 10000; return now; }, fetchImpl: async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.type === 'verification') return reply(200, { challenge: payload.challenge });
    delivered += 1;
    throw new Error('Fake callback unavailable');
  } });
  await instance.handleRpc(subscribe());
  assert.deepEqual(await instance.publish(event('evt_bounded')), { queued: 1 });
  await until(() => delivered === 4);
  await pause(100);
  assert.equal(delivered, 4);
  assert.equal(JSON.parse(await readFile(storePath, 'utf8')).outbox.length, 0);
  await instance.close();
  assert.deepEqual(await instance.publish(event('evt_closed')), { queued: 0, rejected: 'closed' });
});
