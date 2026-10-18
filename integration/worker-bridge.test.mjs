import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WorkerBridge } from './worker-bridge.mjs';
import { LiveConversation } from './live-session.mjs';
import { issueBridgeProof } from '../src/backend/bridge-proof.ts';

const token = 'test-server-credential-'.padEnd(64, 'a');
const result = { text: '【模擬回答】TypeScriptを使います。', language: 'ja' };
const requested = (caseId = 'case-one', id = 'handoff-one') => ({ name: 'human.requested', data: { case_id: caseId, handoff_id: id, status: 'requested', revision: 1, summary: '開発環境を確認', task: '開発環境は？', target_role: 'Engineer', expected_result: '回答本文' } });
const completed = (caseId = 'case-one', id = 'handoff-one') => ({ name: 'human.completed', data: { case_id: caseId, handoff_id: id, status: 'completed', revision: 4, result, simulated: true } });

function fixture({ deliver = async () => ({ status: 'live_submitted' }), conflict = false,
  beforeRequest = () => {}, afterWrite = () => {} } = {}) {
  const snapshots = new Map(['case-one', 'case-two'].map(id => [id, { id, revision: 0, status: 'active', requests: [] }]));
  const calls = [];
  const sockets = [];
  const commands = new Map();
  const events = [];
  const deliveries = [];
  const receipts = [];
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'manual');
    const path = url.pathname.slice('/api/v1'.length);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, body });
    const id = body?.caseId || path.match(/^\/staff\/cases\/([^/]+)/)?.[1];
    const state = snapshots.get(id);
    const error = (status, title) => Response.json({ title }, { status, headers: { 'Content-Type': 'application/problem+json' } });
    if (!state) return error(404, 'case_not_found');
    await beforeRequest({ path, body, state });
    if (!body) return Response.json({ case: structuredClone(state) });
    const old = commands.get(`${id}:${body.commandId}`);
    const fingerprint = JSON.stringify({ ...body, expectedRevision: undefined });
    if (old) return old.fingerprint === fingerprint ? Response.json({ case: old.snapshot }) : error(409, 'idempotency_conflict');
    if (conflict && path.endsWith('/handoffs')) { conflict = false; state.revision++; return error(409, 'revision_conflict'); }
    if (body.expectedRevision !== state.revision) return error(409, 'revision_conflict');
    if (path.endsWith('/handoffs')) {
      state.requests.push({ id: `request-${body.handoffId}`, status: 'pending', origin: { nodeCaseId: body.nodeCaseId, handoffId: body.handoffId, route: body.route, targetRole: body.targetRole, expectedResult: body.expectedResult }, summary: body.summary, question: body.task });
    } else if (path.endsWith('/claim')) {
      const request = state.requests.find(r => path.includes(`/${r.id}/`));
      if (request.status !== 'pending') return error(409, 'already_claimed');
      request.status = 'claimed'; request.assignedTo = 'demo-staff';
    } else if (path.endsWith('/answer')) {
      const request = state.requests.find(r => path.includes(`/${r.id}/`));
      if (request.status !== 'claimed') return error(409, 'claim_required');
      request.status = 'answered'; request.result = body.result; request.simulated = body.simulated;
      request.delivery = { status: 'pending' };
    } else if (path.endsWith('/cancel')) {
      state.requests.find(r => path.includes(`/${r.origin.handoffId}/`)).status = 'cancelled';
    } else if (path.endsWith('/delivery')) {
      const request = state.requests.find(r => path.includes(`/${r.origin.handoffId}/`));
      if (request.status !== 'answered') return error(409, 'answer_required');
      if (body.status === 'queued' && request.delivery?.status !== 'pending') return error(409, 'delivery_in_progress');
      request.delivery = { status: body.status };
    } else throw new Error(`Unexpected external endpoint ${path}`);
    state.revision++;
    const snapshot = structuredClone(state);
    commands.set(`${id}:${body.commandId}`, { fingerprint, snapshot });
    await afterWrite({ path, body, state });
    return Response.json({ case: snapshot });
  };
  const makeBridge = () => new WorkerBridge({ url: 'http://127.0.0.1:8787', token, fetcher,
    socketFactory: (url, options) => {
      assert.equal(url.protocol, 'ws:'); assert.equal(options.headers.Authorization, `Bearer ${token}`);
      const socket = new EventEmitter(); socket.readyState = 1; socket.close = () => { socket.closed = true; };
      sockets.push(socket); return socket;
    }, deliver: async event => { deliveries.push(event); return deliver(event); },
    emit: event => { events.push(event); if (event.type === 'worker.delivery') receipts.splice(0).forEach(resolve => resolve(event)); },
  });
  const bridge = makeBridge();
  const receipt = () => new Promise(resolve => receipts.push(resolve));
  const attach = async (id = 'case-one') => { const proof = await issueBridgeProof(id, token); await bridge.attachCase(id, proof); return proof; };
  return { bridge, makeBridge, calls, events, deliveries, sockets, snapshots, receipt, attach };
}

test('phone result is saved through claim/revision then forwarded once to its original route', async () => {
  const f = fixture({ conflict: true });
  const proof = await f.attach();
  await f.bridge.humanEvent(requested(), 'recruiting');
  const receipt = f.receipt();
  await f.bridge.humanEvent(completed(), 'haas');
  assert.equal((await receipt).status, 'live_submitted');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].data.source_route, 'recruiting');
  assert.deepEqual(f.deliveries[0].data.result, result);
  assert.equal(f.deliveries[0].data.simulated, true);
  const writes = f.calls.filter(call => call.body).map(call => call.path);
  assert.ok(writes.findIndex(path => path.endsWith('/claim')) < writes.findIndex(path => path.endsWith('/answer')));
  assert.ok(writes.findIndex(path => path.endsWith('/answer')) < writes.findIndex(path => path.endsWith('/delivery')));
  await f.bridge.humanEvent(completed(), 'haas');
  await f.bridge.syncCase('case-one', proof);
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot: f.snapshots.get('case-one') })));
  await nextTurn();
  assert.equal(f.deliveries.length, 1);
  f.bridge.close();
  assert.equal(f.sockets[0].closed, true);
});

test('proof, unknown case and wrong snapshot cannot deliver another caller result', async () => {
  const f = fixture();
  const proof = await f.attach();
  await assert.rejects(f.bridge.attachCase('case-two', proof), { status: 403 });
  await assert.rejects(f.bridge.syncCase('case-two', proof), { status: 403 });
  assert.equal(await f.bridge.humanEvent(completed('case-two'), 'haas'), false);
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot: { id: 'case-two', requests: [{ status: 'answered', result, simulated: true }] } })));
  await nextTurn();
  assert.equal(f.deliveries.length, 0);
  f.bridge.close();
});

test('two Node consumers use distinct durable reservation IDs and dispatch only one result', async () => {
  const f = fixture();
  const proof = await f.attach();
  const second = f.makeBridge();
  await second.attachCase('case-one', proof);
  await Promise.all([f.bridge.humanEvent(requested(), 'recruiting'), second.humanEvent(requested(), 'recruiting')]);
  Object.assign(f.snapshots.get('case-one').requests[0], { status: 'answered', result, simulated: true, delivery: { status: 'pending' } });
  const receipt = f.receipt();
  // Both consumers see the same pending snapshot, before either durable claim.
  // A later GET may already see queued and legitimately skip the second attempt.
  const frame = Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot: structuredClone(f.snapshots.get('case-one')) }));
  f.sockets.forEach(socket => socket.emit('message', frame));
  await receipt;
  await Promise.all([f.bridge.cases.get('case-one').deliveries.get('handoff-one'), second.cases.get('case-one').deliveries.get('handoff-one')]);
  assert.equal(f.deliveries.length, 1);
  const reservations = f.calls.filter(c => c.path.endsWith('/delivery') && c.body.status === 'queued');
  assert.equal(new Set(reservations.map(c => c.body.commandId)).size, 2);
  f.bridge.close(); second.close();
});

test('cancel arriving during the first registration invalidates a late result', async () => {
  const f = fixture();
  await f.attach();
  const register = f.bridge.humanEvent(requested(), 'haas');
  const cancel = f.bridge.humanEvent({ name: 'human.cancelled', data: { case_id: 'case-one', handoff_id: 'handoff-one' } }, 'haas');
  await Promise.all([register, cancel]);
  await f.bridge.humanEvent(completed(), 'haas');
  assert.equal(f.snapshots.get('case-one').requests[0].status, 'cancelled');
  assert.equal(f.deliveries.length, 0);
  f.bridge.close();
});

test('queued voice-switch delivery can be invalidated without a second Agent call', async () => {
  let resolveDelivery;
  let received;
  const waiting = new Promise(resolve => { received = resolve; });
  const f = fixture({ deliver: event => { received(event); return new Promise(resolve => { resolveDelivery = resolve; }); } });
  await f.attach();
  await f.bridge.humanEvent(requested(), 'recruiting');
  await f.bridge.humanEvent(completed(), 'haas');
  const event = await waiting;
  assert.equal(event.isValid(), true);
  await f.bridge.humanEvent({ name: 'human.cancelled', data: { case_id: 'case-one', handoff_id: 'handoff-one' } }, 'haas');
  assert.equal(event.isValid(), false);
  resolveDelivery({ status: 'cancelled' });
  await nextTurn();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.snapshots.get('case-one').requests[0].status, 'cancelled');
  f.bridge.close();
});

test('an employee saved answer remains authoritative and thrown delivery records failure', async () => {
  const f = fixture({ deliver: async () => { throw new Error('Provider credentials must not be logged'); } });
  await f.attach();
  await f.bridge.humanEvent(requested(), 'haas');
  const state = f.snapshots.get('case-one');
  Object.assign(state.requests[0], { status: 'answered', result: { text: 'Employee answer', language: 'en' }, simulated: false, delivery: { status: 'pending' } });
  const receipt = f.receipt();
  await f.bridge.humanEvent(completed(), 'haas');
  assert.equal((await receipt).status, 'failed');
  assert.equal(f.deliveries[0].data.result.text, 'Employee answer');
  assert.equal(f.deliveries[0].data.simulated, false);
  assert.equal(f.calls.filter(call => call.path.endsWith('/answer')).length, 0);
  assert.equal(JSON.stringify(f.events).includes('credentials'), false);
  f.bridge.close();
});

test('synthetic revision and cached reload keep the verified employee answer above stale phone data', async () => {
  const f = fixture();
  await f.attach();
  await f.bridge.humanEvent(requested(), 'recruiting');
  await f.bridge.humanEvent({ name: 'human.accepted', data: { ...requested().data, status: 'accepted', revision: 100 } }, 'haas');
  const snapshot = f.snapshots.get('case-one');
  Object.assign(snapshot.requests[0], { status: 'answered', result: { text: 'Verified employee answer', language: 'en' }, simulated: false, delivery: { status: 'pending' } });
  snapshot.revision++;
  const receipt = f.receipt();
  await f.bridge.humanEvent({ ...completed(), data: { ...completed().data, revision: 101 } }, 'haas');
  await receipt;
  const data = f.deliveries[0].data;
  assert.ok(data.revision > 101);
  assert.equal(data.source_route, 'recruiting');
  assert.equal(data.summary, '開発環境を確認');
  assert.equal(data.task, '開発環境は？');
  assert.equal(data.target_role, 'Engineer');
  assert.equal(data.expected_result, '回答本文');
  assert.equal(data.result.text, 'Verified employee answer');
  assert.equal(data.simulated, false);
  const stale = { ...completed().data, revision: 101 };
  const reload = f.bridge.records([stale])[0];
  assert.equal(reload.result.text, 'Verified employee answer');
  assert.equal(reload.simulated, false);
  assert.ok(reload.revision > stale.revision);
  assert.equal(reload.worker_revision, f.snapshots.get('case-one').revision);
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot: { id: 'case-one', revision: 0, requests: [] } })));
  assert.equal(f.bridge.requests('case-one', [stale])[0].result.text, 'Verified employee answer');
  assert.equal(f.bridge.records([{ ...stale, case_id: 'case-two' }])[0].result.text, stale.result.text);
  f.bridge.close();
});

test('closed case releases a connecting socket and cannot re-sync or send a late answer', async () => {
  const f = fixture();
  const proof = await f.attach();
  f.sockets[0].readyState = 0;
  f.sockets[0].terminate = () => { f.sockets[0].terminated = true; };
  f.bridge.closeCase('case-one');
  assert.equal(f.sockets[0].terminated, true);
  await assert.rejects(f.bridge.syncCase('case-one', proof), { status: 403 });
  assert.equal(await f.bridge.humanEvent(completed(), 'recruiting'), false);
});

test('explicit synchronization retries a failed reservation before Agent delivery, but repeated snapshots do not', async () => {
  let fail = true;
  const f = fixture({ beforeRequest: ({ body }) => {
    if (body?.status === 'queued' && fail) { fail = false; throw new Error('Synthetic reservation failure'); }
  } });
  const proof = await f.attach();
  await f.bridge.humanEvent(requested(), 'recruiting');
  await f.bridge.humanEvent(completed(), 'haas');
  await f.bridge.cases.get('case-one').deliveries.get('handoff-one');
  assert.equal(f.snapshots.get('case-one').requests[0].delivery.status, 'pending');
  assert.equal(f.deliveries.length, 0);
  const snapshot = { type: 'case.snapshot', snapshot: f.snapshots.get('case-one') };
  f.sockets[0].emit('message', Buffer.from(JSON.stringify(snapshot)));
  await f.bridge.cases.get('case-one').queue;
  assert.equal(f.calls.filter(call => call.body?.status === 'queued').length, 1);
  const receipt = f.receipt();
  assert.equal((await f.bridge.syncCase('case-one', proof)).status, 'accepted');
  assert.equal((await receipt).status, 'live_submitted');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].data.source_route, 'recruiting');
  await f.bridge.syncCase('case-one', proof);
  assert.equal(f.deliveries.length, 1);
  f.bridge.close();
});

test('lost queued-write response can be explicitly recovered with the original command without a second delivery', async () => {
  let loseResponse = true;
  const f = fixture({ afterWrite: ({ body }) => {
    if (body.status === 'queued' && loseResponse) { loseResponse = false; throw new Error('Synthetic lost reservation response'); }
  } });
  const proof = await f.attach();
  await f.bridge.humanEvent(requested(), 'haas');
  await f.bridge.humanEvent(completed(), 'haas');
  await f.bridge.cases.get('case-one').deliveries.get('handoff-one');
  assert.equal(f.snapshots.get('case-one').requests[0].delivery.status, 'queued');
  assert.equal(f.deliveries.length, 0);
  const receipt = f.receipt();
  await f.bridge.syncCase('case-one', proof);
  assert.equal((await receipt).status, 'live_submitted');
  const reservations = f.calls.filter(call => call.body?.status === 'queued');
  assert.equal(reservations.length, 2);
  assert.equal(reservations[0].body.commandId, reservations[1].body.commandId);
  assert.equal(f.deliveries.length, 1);
  f.bridge.close();
});

test('an ambiguous final receipt failure never repeats an already invoked Agent delivery', async () => {
  const f = fixture({ beforeRequest: ({ body }) => {
    if (body?.status === 'live_submitted') throw new Error('Synthetic receipt failure');
  } });
  const proof = await f.attach();
  await f.bridge.humanEvent(requested(), 'haas');
  await f.bridge.humanEvent(completed(), 'haas');
  await f.bridge.cases.get('case-one').deliveries.get('handoff-one');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.snapshots.get('case-one').requests[0].delivery.status, 'queued');
  await f.bridge.syncCase('case-one', proof);
  const stale = structuredClone(f.snapshots.get('case-one'));
  stale.requests[0].delivery.status = 'pending';
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot: stale })));
  await f.bridge.cases.get('case-one').queue;
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.calls.filter(call => call.body?.status === 'queued').length, 1);
  f.bridge.close();
});

test('Worker cancellation snapshot invalidates a result while its Agent is pending', async () => {
  let received, started, finish;
  const arrived = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { finish = resolve; });
  const sent = [], turns = [];
  // Use the real Live delivery path without constructing a provider connection.
  const live = Object.assign(Object.create(LiveConversation.prototype), {
    id: 'live-review', caseId: 'case-one', routing: { route: 'haas', language: 'en' },
    history: [], seen: new Set(), queue: Promise.resolve(), closed: false,
    emit() {}, handoffs: () => [], send: (...args) => { sent.push(args); return true; },
    backend: { run: async args => { turns.push(args); started(); return pending; } },
  });
  const f = fixture({ deliver: event => { received = event; return live.humanEvent(event); } });
  await f.attach();
  await f.bridge.humanEvent(requested(), 'recruiting');
  await f.bridge.humanEvent(completed(), 'haas');
  await arrived;
  assert.equal(received.isValid(), true);
  assert.equal(turns[0].route, 'recruiting');
  assert.equal(turns[0].language, 'en');
  const state = f.snapshots.get('case-one');
  state.requests[0].status = 'cancelled';
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot: state })));
  assert.equal(received.isValid(), false);
  finish('This cancelled answer must not reach Live.');
  await f.bridge.cases.get('case-one').deliveries.get('handoff-one');
  assert.equal(f.events.filter(item => item.type === 'worker.delivery').length, 0);
  assert.equal(f.calls.filter(call => call.body?.status === 'live_submitted').length, 0);
  assert.equal(turns.length, 1);
  assert.equal(sent.length, 0);
  f.bridge.close();
});
