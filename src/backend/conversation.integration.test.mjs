// Real Worker/DO/D1 + signed relay + Node HTTP/SSE + frontend clients.
// Only the external Live provider and microphone/RTC hardware are substituted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createIntegration } from '../../integration/server.mjs';
import { createProductionRelay } from '../../deployment/relay.mjs';
import { WorkerCaseClient } from '../../frontend/src/features/worker/cases.ts';
import { LiveClient, caseVoicePrefix } from '../../frontend/src/features/live/client.ts';

class ProviderSocket extends EventEmitter {
  readyState = 0;
  constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
  send(raw) { if (JSON.parse(raw).type === 'session.close') queueMicrotask(() => this.receive({ type: 'session.closed', reason: 'close_requested' })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
function waitFor(client, matches) {
  if (matches(client.getSnapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Expected conversation state did not arrive: ' + JSON.stringify(client.getSnapshot()))); }, 4000);
    const unsubscribe = client.subscribe(state => { if (matches(state)) { clearTimeout(timer); unsubscribe(); resolve(); } });
  });
}
// EventSource equivalent using the real Worker SSE response, without a browser.
function eventSource(fetcher, path) {
  const controller = new AbortController();
  const source = { readyState: 0, onopen: null, onmessage: null, onerror: null,
    close() { source.readyState = 2; controller.abort(); } };
  void (async () => {
    const response = await fetcher(path, { signal: controller.signal });
    if (!response.ok) throw new Error('SSE unavailable');
    source.readyState = 1; source.onopen?.({});
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!controller.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const line = frame.split('\n').find(value => value.startsWith('data: '));
          if (line) source.onmessage?.({ data: line.slice(6) });
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  })().catch(() => { if (!controller.signal.aborted) { source.readyState = 2; source.onerror?.({}); } });
  return source;
}

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'conversation-backend-'));
  const staffToken = randomBytes(32).toString('hex'), relaySecret = randomBytes(32).toString('hex');
  let worker, relay, providerSocket, creates = 0;
  t.after(async () => { await relay?.close(); await app.close(); await worker?.dispose(); await rm(stateDir, { recursive: true, force: true }); });
  const app = createIntegration({ stateDir, closeTimeoutMs: 50,
    env: { HUMAN_MCP_URL: 'https://test.invalid/mcp', HUMAN_MCP_TOKEN: 'test-mcp-token-'.repeat(4), WORKER_API_URL: 'http://localhost', STAFF_API_TOKEN: staffToken },
    client: { live: { async create() { creates++; return { session: { id: `live-${creates}` }, transport: { sdp: 'v=0\r\nanswer' } }; } },
      beta: { agents: { sessions: { async delete() {} } } } },
    socketFactory() { providerSocket = new ProviderSocket(); return providerSocket; },
    workerFetch: (url, init) => worker.dispatchFetch(url.href, init),
    // No human-result updates in this scenario; HTTP authorization still uses the real Worker.
    workerSocketFactory: () => new ProviderSocket(),
  });
  const nodeOrigin = await listen(app.server);
  relay = createProductionRelay({ target: nodeOrigin, secret: relaySecret, humanMcpToken: 'test-mcp-token-'.repeat(4), eventLifetimeMs: 10000 });
  const relayOrigin = await listen(relay.server);
  const bundle = await build({ entryPoints: ['src/index.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', jsxImportSource: 'hono/jsx', external: ['cloudflare:workers'], define: { 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false' } });
  worker = new Miniflare(convertV4MiniflareOptions({ name: 'conversation-bridge', modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2025-08-03', durableObjects: { CASES: { className: 'CaseRoom', useSQLite: true } }, d1Databases: ['DB'],
    bindings: { STAFF_API_TOKEN: staffToken, NODE_RELAY_SECRET: relaySecret, NODE_RELAY_ORIGIN: relayOrigin, NODE_RELAY_EVENTS_TRANSPORT: 'sse' },
    outboundService: async request => {
      assert.equal(new URL(request.url).origin, relayOrigin);
      return fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }), redirect: 'manual' });
    },
  }));
  const db = await worker.getD1Database('DB');
  for (const name of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(`migrations/${name}`, 'utf8')).split(';').filter(value => value.trim())) await db.exec(sql.replaceAll('\n', ' '));
  }
  function visitor() {
    let cookie = '';
    const calls = [];
    const fetcher = async (path, init = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('Cookie', cookie);
      if (init.method && init.method !== 'GET') headers.set('Origin', 'http://localhost');
      const response = await worker.dispatchFetch(new URL(path, 'http://localhost').href, { ...init, headers });
      const setCookie = response.headers.get('Set-Cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      calls.push({ path, method: init.method || 'GET', status: response.status });
      return response;
    };
    return { fetcher, calls, cases: new WorkerCaseClient(fetcher) };
  }
  return { visitor, worker, socket: () => providerSocket, creates: () => creates };
}

test('owned case connects through Worker and signed relay; SSE updates frontend history and shutdown retains it', { timeout: 20000 }, async t => {
  const f = await fixture(t), visitor = f.visitor();
  const authorization = await visitor.cases.prepareVoice('ja');
  const prefix = caseVoicePrefix(authorization.case.id);
  const track = { stopped: false, enabled: true, stop() { this.stopped = true; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  const channel = { onmessage: null, onclose: null, close() {} };
  const peer = { iceGatheringState: 'complete', localDescription: null, closed: false,
    addTrack() {}, createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\no=test' }),
    async setLocalDescription(offer) { this.localDescription = offer; },
    async setRemoteDescription() {}, close() { this.closed = true; }, addEventListener() {}, removeEventListener() {} };
  const live = new LiveClient(authorization.case.id, 'ja', {
    fetch: visitor.fetcher, events: path => eventSource(visitor.fetcher, path), supported: () => true,
    microphone: async () => stream, peer: () => peer, audio: () => ({ autoplay: true, play: async () => {}, pause() {} }),
  }, { apiPrefix: prefix });
  t.after(() => live.dispose());
  const diagnostic = await visitor.fetcher(`${prefix}/status`);
  assert.equal(diagnostic.status, 200, await diagnostic.text());
  live.observe();
  await waitFor(live, state => state.configured && state.events === 'connected');
  await live.start('ja', 'reception', authorization.bridgeToken);
  assert.equal(f.creates(), 1);
  channel.onmessage({ data: JSON.stringify({ type: 'session.started', session: { id: 'live-1' } }) });
  assert.equal(live.getSnapshot().phase, 'connected');
  const input = { type: 'session.input_transcript.delta', event_id: 'input-1', item_id: 'utterance-1', delta: '仕事をお願いしたいです。', is_final: true };
  f.socket().receive(input);
  f.socket().receive({ type: 'session.output_transcript.delta', event_id: 'output-1', item_id: 'reply-1', delta: 'ご依頼の内容を教えてください。', is_final: true });
  await waitFor(live, state => state.transcripts.length === 2);
  // The same provider frame also arriving over RTC must not duplicate history.
  channel.onmessage({ data: JSON.stringify(input) });
  assert.deepEqual(live.getSnapshot().transcripts.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: '仕事をお願いしたいです。' }, { role: 'assistant', text: 'ご依頼の内容を教えてください。' },
  ]);
  await live.setLanguage('en', 'en');
  assert.equal(live.getSnapshot().language, 'en');
  const other = f.visitor(); await other.cases.ensureCase('ja');
  assert.equal((await other.fetcher(`${prefix}/status`)).status, 404);
  assert.equal((await other.fetcher(`${prefix}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404);
  assert.equal(f.creates(), 1);
  await live.stop();
  assert.equal(live.getSnapshot().phase, 'ended');
  assert.equal(live.getSnapshot().transcripts.length, 2);
  assert.ok(track.stopped && peer.closed);
  assert.ok(visitor.calls.some(call => call.path === `${prefix}/session/live-1` && call.method === 'DELETE' && call.status === 200));
  assert.equal(visitor.calls.some(call => call.path === '/api/status' || call.path.startsWith('/api/live/')), false);
  assert.equal(JSON.stringify(live.getSnapshot()).includes(authorization.bridgeToken), false);
});
