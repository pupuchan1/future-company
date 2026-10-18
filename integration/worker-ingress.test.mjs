import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegration } from './server.mjs';
import { WorkerBridge } from './worker-bridge.mjs';
import { issueBridgeProof } from '../src/backend/bridge-proof.ts';
import { LiveEventReducer } from '../frontend/src/features/live/events.ts';
import { initialSnapshot } from '../frontend/src/features/live/types.ts';

const token = 'server-only-test-credential'.padEnd(64, 'x');
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  send(raw) { const event = JSON.parse(raw); this.sent.push(event); if (event.type === 'session.close') queueMicrotask(() => this.receive({ type: 'session.closed' })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t, { env = {} } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'future-company-worker-ingress-'));
  const liveCreates = [];
  const agentCalls = [];
  const liveSockets = new Map();
  const workerSockets = [];
  const workerConnections = [];
  const registered = deferred(), delivered = deferred();
  const state = { id: 'case-owned', revision: 0, status: 'active', requests: [] };
  const commands = new Map();
  const workerFetch = async (url, options) => {
    workerConnections.push({ transport: 'http', url, options });
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    const path = url.pathname;
    if (!path.includes(`/cases/${state.id}`)) return Response.json({ title: 'case_not_found' }, { status: 404, headers: { 'Content-Type': 'application/problem+json' } });
    if (options.method === 'GET') return Response.json({ case: structuredClone(state) });
    const body = JSON.parse(options.body);
    if (commands.has(body.commandId)) return Response.json({ case: commands.get(body.commandId) });
    assert.equal(body.expectedRevision, state.revision);
    if (path.endsWith('/handoffs')) state.requests.push({ id: `request-${body.handoffId}`, status: 'pending', origin: { nodeCaseId: body.nodeCaseId, handoffId: body.handoffId, route: body.route } });
    else if (path.endsWith('/delivery')) state.requests.find(r => path.includes(`/${r.origin.handoffId}/`)).delivery.status = body.status;
    else if (path.endsWith('/cancel')) state.requests.find(r => path.includes(`/${r.origin.handoffId}/`)).status = 'cancelled';
    else throw Error(`Unexpected worker endpoint ${path}`);
    state.revision++;
    const snapshot = structuredClone(state); commands.set(body.commandId, snapshot);
    if (path.endsWith('/handoffs')) registered.resolve();
    if (body.status === 'live_submitted') delivered.resolve();
    return Response.json({ case: snapshot });
  };
  function stream(id, input) {
    agentCalls.push({ id, input });
    return { controller: { abort() {} }, withResultCollection() {},
      async *[Symbol.asyncIterator]() { yield { type: 'agent.session.created', session: { id } }; },
      async finalResult() { return { session_id: id, turn_id: `turn-${agentCalls.length}`, turn: { status: 'completed' }, output_text: '【模擬回答】TypeScriptを使います。' }; } };
  }
  const app = createIntegration({ stateDir, closeTimeoutMs: 20,
    env: { HUMAN_MCP_TOKEN: 'test-mcp', HUMAN_MCP_URL: 'https://mcp.example.invalid/mcp', WORKER_API_URL: 'http://127.0.0.1:8787', STAFF_API_TOKEN: token, ...env },
    client: { live: { async create(input) { liveCreates.push(input); return { session: { id: `live-${liveCreates.length}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }; } },
      beta: { agents: { sessions: { async create(input) { return stream(`agent-${input.metadata.role}`, input); }, stream,
        events: { async create() {} }, async delete() {} } } } },
    socketFactory(url) { const socket = new FakeSocket(); liveSockets.set(new URL(url).pathname.split('/').at(-2), socket); return socket; },
    workerFetch, workerSocketFactory(url, options) {
      workerConnections.push({ transport: 'websocket', url, options });
      const socket = new FakeSocket(); workerSockets.push(socket); return socket;
    },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, body, extra = {}) => {
    const response = await fetch(base + path, { method: extra.method || 'POST', headers: { 'Content-Type': 'application/json', ...extra.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const proof = await issueBridgeProof('case-owned', token);
  const start = (fields = {}) => api('/api/live/session', { sdp: 'v=0\r\n', route: 'recruiting', case_id: 'case-owned', bridge_token: proof, ...fields });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close(); await rm(stateDir, { recursive: true, force: true });
  };
  t.after(close);
  const event = async (name, matches = () => true) => {
    const response = await fetch(base + '/api/events');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const seen = [];
    const received = (async () => {
      let pending = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error('Event stream ended before the expected event.');
        pending += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (data) {
            const parsed = JSON.parse(data.slice(6));
            seen.push(parsed);
            if (parsed.type === name && matches(parsed)) return parsed;
          }
        }
      }
    })();
    t.after(() => reader.cancel());
    return { received, seen, close: () => reader.cancel() };
  };
  return { app, close, api, start, proof, liveCreates, agentCalls, liveSockets, workerSockets, workerConnections, state, registered, delivered, event };
}

test('HTTP voice start rejects missing, forged and other-case proof before provider creation', async t => {
  const f = await fixture(t);
  assert.equal((await f.start({ bridge_token: undefined })).status, 403);
  assert.equal((await f.start({ bridge_token: 'forged.token' })).status, 403);
  assert.equal((await f.start({ case_id: 'case-other' })).status, 403);
  assert.equal(f.liveCreates.length, 0);
  const start = await f.start();
  assert.equal(start.status, 200);
  assert.equal(start.body.case_id, 'case-owned');
  assert.equal(start.body.route, 'recruiting');
  assert.equal((await f.start()).status, 409);
  assert.equal(f.liveCreates.length, 1);
  assert.equal((await f.api(`/api/live/session/${start.body.session.id}`, undefined, { method: 'DELETE' })).status, 200);
  assert.equal(f.workerSockets[0].readyState, 3);
});

test('HTTP result ingress requires active case proof and preserves cross-origin rejection', async t => {
  const f = await fixture(t);
  await f.start();
  const fields = { case_id: 'case-owned', bridge_token: f.proof };
  assert.equal((await f.api('/api/worker/results', fields)).status, 202);
  assert.equal((await f.api('/api/worker/results', { ...fields, bridge_token: 'forged.token' })).status, 403);
  assert.equal((await f.api('/api/worker/results', { ...fields, case_id: 'case-other' })).status, 403);
  assert.equal((await f.api('/api/worker/results', fields, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal(f.agentCalls.length, 0);
});

test('saved Worker result waits for voice activation and reaches original Agent once', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const started = await f.start();
  const oldId = started.body.session.id;
  const commands = [];
  f.app.gateway.service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true, capabilities: ['ring.start', 'ring.stop'] }, command => { commands.push(command); return true; });
  const request = f.app.gateway.service.requestHuman({ case_id: 'case-owned', reason: 'human_requested', summary: '現場の開発環境', language: 'ja', idempotency_key: 'owned-question' });
  await f.registered.promise;
  const prepared = await f.api(`/api/live/session/${oldId}/handoff`, { sdp: 'v=0\r\n', route: 'haas' });
  assert.equal(prepared.status, 200);
  const completion = await f.event('human.completed');
  Object.assign(f.state.requests[0], { status: 'answered', result: { text: '【模擬回答】TypeScriptを使います。', language: 'ja' }, simulated: true, delivery: { status: 'pending' } });
  f.workerSockets[0].receive({ type: 'case.snapshot', snapshot: structuredClone(f.state) });
  await completion.received;
  await completion.close();
  assert.equal(f.state.requests[0].delivery.status, 'queued');
  assert.equal(f.agentCalls.length, 0);
  const active = await f.api(`/api/live/session/${prepared.body.session.id}/activate`, { handoff_token: prepared.body.handoff_token });
  assert.equal(active.status, 200);
  await f.delivered.promise;
  assert.equal(f.agentCalls.length, 1);
  assert.equal(f.agentCalls[0].input.metadata.role, 'recruiting');
  assert.match(f.agentCalls[0].input.input, /TypeScript/);
  assert.match(f.agentCalls[0].input.input, new RegExp(request.handoff_id));
  assert.equal(f.liveSockets.get(prepared.body.session.id).sent.filter(e => e.type === 'session.commentary.append').length, 1);
  await f.api('/api/worker/results', { case_id: 'case-owned', bridge_token: f.proof });
  assert.equal(f.agentCalls.length, 1);
});

test('late device ACKs keep the saved Worker answer in SSE and the real UI reducer without another Agent turn', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  await f.start();
  const commands = [];
  const device = f.app.gateway.service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop'] }, command => { commands.push(command); return true; });
  const request = f.app.gateway.service.requestHuman({ case_id: 'case-owned', reason: 'human_requested',
    summary: '現場の開発環境', language: 'ja', idempotency_key: 'late-ack-question' });
  await f.registered.promise;
  const output = await f.event('human.accepted');
  const answer = { text: 'A saved employee answer stays authoritative.', language: 'en' };
  Object.assign(f.state.requests[0], { status: 'answered', result: answer, simulated: false, delivery: { status: 'pending' } });
  f.state.revision++;
  f.workerSockets[0].receive({ type: 'case.snapshot', snapshot: structuredClone(f.state) });
  await f.delivered.promise;
  assert.equal(f.agentCalls.length, 1);
  const ack = { command_id: commands[0].command_id, handoff_id: request.handoff_id };
  assert.equal(device.handleEvent({ ...ack, type: 'ring.started' }), true);
  assert.equal(device.handleEvent({ ...ack, type: 'handset.off_hook' }), true);
  await output.received;
  await output.close();
  const late = output.seen.filter(event => ['human.ringing', 'human.accepted'].includes(event.type));
  assert.equal(late.length, 2);
  for (const event of late) {
    assert.equal(event.data.status, 'completed');
    assert.deepEqual(event.data.result, answer);
    assert.equal(event.data.source_route, 'recruiting');
  }
  const reducer = new LiveEventReducer();
  const ui = output.seen.reduce((snapshot, event) => reducer.apply(snapshot, event, 'server'), initialSnapshot('case-owned', 'ja'));
  assert.equal(ui.requests[0].status, 'completed');
  assert.deepEqual(ui.requests[0].result, answer);
  assert.equal(f.agentCalls.length, 1);
});

test('invalid and closed-case Worker results are rejected before SSE publication', { timeout: 5000 }, async t => {
  let bridge;
  const attach = WorkerBridge.prototype.attachCase;
  t.mock.method(WorkerBridge.prototype, 'attachCase', function (...args) { bridge = this; return attach.apply(this, args); });
  const f = await fixture(t);
  const started = await f.start();
  // A later valid event is an SSE barrier, so the negative assertion needs no sleep.
  const output = await f.event('human.requested', event => event.data.case_id === 'barrier-case');
  const event = { name: 'human.completed', eventId: 'invalid-worker-result', isValid: () => false,
    data: { case_id: 'case-owned', handoff_id: 'invalid-handoff', status: 'completed', revision: 1,
      result: { text: 'This result must not be published.', language: 'en' }, simulated: true } };
  assert.deepEqual(await bridge.deliver(event), { status: 'cancelled' });
  await f.api(`/api/live/session/${started.body.session.id}`, undefined, { method: 'DELETE' });
  assert.deepEqual(await bridge.deliver({ ...event, eventId: 'closed-worker-result', isValid: () => true }), { status: 'cancelled' });
  f.app.gateway.service.requestHuman({ case_id: 'barrier-case', reason: 'human_requested', summary: 'SSE barrier', language: 'en', idempotency_key: 'barrier' });
  await output.received;
  await output.close();
  assert.equal(output.seen.filter(item => ['invalid-worker-result', 'closed-worker-result'].includes(item.eventId)).length, 0);
  assert.equal(f.agentCalls.length, 0);
});

test('server CF_ACCESS aliases reach configured Worker HTTPS and WSS without replacing staff or case authorization', async t => {
  const f = await fixture(t, { env: { WORKER_API_URL: 'https://worker.example.invalid',
    CF_ACCESS_CLIENT_ID: 'new-id.access', CF_ACCESS_CLIENT_SECRET: 'new-secret',
    WORKER_ACCESS_CLIENT_ID: 'legacy-id.access', WORKER_ACCESS_CLIENT_SECRET: 'legacy-secret' } });
  assert.equal((await f.start({ bridge_token: 'forged.token' })).status, 403);
  assert.equal(f.workerConnections.length, 0);
  assert.equal((await f.start()).status, 200);
  assert.deepEqual(f.workerConnections.map(call => call.transport), ['http', 'websocket']);
  for (const { url, options, transport } of f.workerConnections) {
    assert.equal(url.hostname, 'worker.example.invalid');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers['CF-Access-Client-Id'], 'new-id.access');
    assert.equal(options.headers['CF-Access-Client-Secret'], 'new-secret');
    if (transport === 'http') assert.equal(options.redirect, 'error');
    else assert.equal(options.followRedirects, false);
  }
});

test('closing with an open SSE connection does not publish Live teardown to an ended response', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const started = await f.start();
  const output = await f.event('human.requested');
  f.app.gateway.service.requestHuman({ case_id: 'barrier-case', reason: 'human_requested', summary: 'Keep SSE open', language: 'en', idempotency_key: 'shutdown-barrier' });
  await output.received;
  await f.close();
  await output.close();
  assert.equal(f.liveSockets.get(started.body.session.id).readyState, 3);
});
