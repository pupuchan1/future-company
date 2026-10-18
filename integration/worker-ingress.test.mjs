import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIntegration } from './server.mjs';
import { issueBridgeProof } from '../src/backend/bridge-proof.ts';

const token = 'server-only-test-credential'.padEnd(64, 'x');
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 0; this.sent = []; queueMicrotask(() => { this.readyState = 1; this.emit('open'); }); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  send(raw) { const event = JSON.parse(raw); this.sent.push(event); if (event.type === 'session.close') queueMicrotask(() => this.receive({ type: 'session.closed' })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'future-company-worker-ingress-'));
  const liveCreates = [];
  const agentCalls = [];
  const liveSockets = new Map();
  const workerSockets = [];
  const registered = deferred(), delivered = deferred();
  const state = { id: 'case-owned', revision: 0, status: 'active', requests: [] };
  const commands = new Map();
  const workerFetch = async (url, options) => {
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
    env: { HUMAN_MCP_TOKEN: 'test-mcp', HUMAN_MCP_URL: 'https://mcp.example.invalid/mcp', WORKER_API_URL: 'http://127.0.0.1:8787', STAFF_API_TOKEN: token },
    client: { live: { async create(input) { liveCreates.push(input); return { session: { id: `live-${liveCreates.length}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } }; } },
      beta: { agents: { sessions: { async create(input) { return stream(`agent-${input.metadata.role}`, input); }, stream,
        events: { async create() {} }, async delete() {} } } } },
    socketFactory(url) { const socket = new FakeSocket(); liveSockets.set(new URL(url).pathname.split('/').at(-2), socket); return socket; },
    workerFetch, workerSocketFactory() { const socket = new FakeSocket(); workerSockets.push(socket); return socket; },
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, body, extra = {}) => {
    const response = await fetch(base + path, { method: extra.method || 'POST', headers: { 'Content-Type': 'application/json', ...extra.headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const proof = await issueBridgeProof('case-owned', token);
  const start = (fields = {}) => api('/api/live/session', { sdp: 'v=0\r\n', route: 'recruiting', case_id: 'case-owned', bridge_token: proof, ...fields });
  t.after(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
  const event = async name => {
    const response = await fetch(base + '/api/events');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
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
          if (data && JSON.parse(data.slice(6)).type === name) return;
        }
      }
    })();
    t.after(() => reader.cancel());
    return { received, close: () => reader.cancel() };
  };
  return { app, api, start, proof, liveCreates, agentCalls, liveSockets, workerSockets, state, registered, delivered, event };
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
