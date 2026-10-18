import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import OpenAI from 'openai';
import { createIntegration } from './server.mjs';
import { createCaseState, initialHistory, voiceMap } from './case-state.mjs';
import { LiveConversation } from './live-session.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Local handoff test timed out.');
    await pause(5);
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.sent = [];
    queueMicrotask(() => { this.readyState = 1; this.emit('open'); });
  }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  send(raw) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    if (event.type === 'session.close') queueMicrotask(() => this.receive({ type: 'session.closed' }));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  terminate() { this.close(); }
}

async function fixture(t, { create, handoffTimeoutMs = 30000 } = {}) {
  const sockets = new Map();
  const creates = [];
  const runs = [];
  const closedCases = [];
  const stateDir = await mkdtemp(join(tmpdir(), 'future-company-handoff-'));
  const app = createIntegration({ stateDir, handoffTimeoutMs, closeTimeoutMs: 20,
    env: { HUMAN_MCP_TOKEN: 'local-handoff-test-token', HUMAN_MCP_URL: 'https://mcp.example.invalid/mcp' },
    client: { live: { async create(input) {
      creates.push(input);
      return create ? create(input, creates.length) : { session: { id: `live-${creates.length}` }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } };
    } } },
    socketFactory(url) {
      const socket = new FakeSocket();
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-2));
      sockets.set(id, socket);
      return socket;
    },
  });
  app.backend.run = async (input) => { runs.push(input); return '担当からの確認済み回答です。'; };
  app.backend.classify = async (_text, previous) => previous;
  app.backend.closeCase = async (caseId) => {
    closedCases.push(caseId);
    for (const key of app.backend.sessions.keys()) if (key.startsWith(`${caseId}:`)) app.backend.sessions.delete(key);
    return [];
  };
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const api = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(base + path, { method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const start = async (route = 'reception', caseId = 'case-switch') => api('/api/live/session', { sdp: 'v=0\r\n', route, case_id: caseId });
  const prepare = async (id, route = 'haas') => api(`/api/live/session/${id}/handoff`, { sdp: 'v=0\r\n', route });
  const activate = async (prepared) => api(`/api/live/session/${prepared.body.session.id}/activate`, { handoff_token: prepared.body.handoff_token });
  t.after(async () => { await app.close(); await rm(stateDir, { recursive: true, force: true }); });
  return { app, api, start, prepare, activate, sockets, creates, runs, closedCases, stateDir };
}

test('provider connection failures return 502 and store only allowlisted diagnostic metadata', async (t) => {
  const f = await fixture(t, { create: () => { throw new OpenAI.APIConnectionError({
    cause: new TypeError('private input and credential must not be logged', {
      cause: new AggregateError([Object.assign(new Error('private host details'), { code: 'ENOTFOUND' })]),
    }),
  }); } });
  const response = await f.start();
  assert.equal(response.status, 502);
  assert.match(response.body.error, /Provider connection failed/);
  const lines = await readFile(join(f.stateDir, 'errors.jsonl'), 'utf8');
  const entry = JSON.parse(lines.trim());
  assert.equal(entry.name, 'APIConnectionError');
  assert.equal(entry.cause_code, 'ENOTFOUND');
  assert.equal(f.creates.length, 3);
  assert.doesNotMatch(lines, /private|credential/);
  assert.equal((await f.api('/api/status')).status, 200);
});

test('startup advertises fixed department voices and supports direct interview entry', async (t) => {
  const f = await fixture(t);
  const status = await f.api('/api/status');
  assert.equal(status.body.handoff_configured, true);
  assert.deepEqual(status.body.voice_map, voiceMap);
  assert.equal((await f.start('unknown')).status, 400);
  const started = await f.start('recruiting');
  assert.equal(started.status, 200);
  assert.equal(started.body.voice, 'harema');
  assert.equal(started.body.route, 'recruiting');
  assert.match(f.creates[0].session.instructions, /株式会社HaaS/);
  assert.match(f.creates[0].session.instructions, /caller selected the recruitment interview/i);
  f.sockets.get(started.body.session.id).receive({ type: 'session.delegation.created', delegation: { id: 'intro', target: 'client' } });
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].route, 'recruiting');
  assert.match(f.runs[0].transcript, /Application action/);
});

test('voice handoff preserves history, Agents state and original human-result route exactly once', async (t) => {
  const f = await fixture(t);
  const started = await f.start('recruiting');
  const oldId = started.body.session.id;
  const oldSocket = f.sockets.get(oldId);
  oldSocket.receive({ type: 'session.input_transcript.delta', event_id: 'heard-1', delta: '開発環境を人間に確認してください。' });
  oldSocket.receive({ type: 'session.output_transcript.delta', event_id: 'said-1', delta: '担当者に確認します。' });
  const agentsState = { id: 'agents-recruiting', active: false };
  f.app.backend.sessions.set('case-switch:recruiting', agentsState);
  const commands = [];
  const device = f.app.gateway.service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop'] }, (command) => { commands.push(command); return true; });
  const request = f.app.gateway.service.requestHuman({ case_id: 'case-switch', reason: 'human_requested',
    summary: '架空の開発環境の確認', language: 'ja', idempotency_key: 'question-1' });
  const command = commands.find((entry) => entry.type === 'ring.start');
  const prepared = await f.prepare(oldId, 'haas');
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.old_session_id, oldId);
  assert.equal(prepared.body.voice, 'marin');
  assert.deepEqual(f.creates[1].session.input.map((item) => item.role), ['user', 'assistant']);
  assert.deepEqual(f.creates[1].session.input.map((item) => item.content[0].type), ['input_text', 'output_text']);
  assert.match(f.creates[1].session.input[0].content[0].text, /開発環境/);
  assert.match(f.creates[1].session.instructions, /Stay silent/);
  for (const type of ['ring.started', 'handset.off_hook', 'handset.on_hook']) {
    device.handleEvent({ type, handoff_id: request.handoff_id, command_id: command.command_id,
      ...(type === 'handset.on_hook' ? { result: { text: '架空回答: TypeScript と React を使用します。', language: 'ja' } } : {}) });
  }
  await pause(0);
  assert.equal(f.runs.length, 0);
  assert.equal(oldSocket.sent.filter((entry) => entry.type === 'session.close').length, 0);
  const activated = await f.activate(prepared);
  assert.equal(activated.status, 200);
  assert.equal(activated.body.active, true);
  await until(() => f.runs.length === 1 && oldSocket.readyState === 3);
  assert.equal(f.runs[0].source, 'human_event');
  assert.equal(f.runs[0].route, 'recruiting');
  assert.match(f.runs[0].transcript, /架空回答: TypeScript/);
  assert.match(f.runs[0].transcript, /開発環境を人間に確認/);
  assert.equal(f.app.backend.sessions.get('case-switch:recruiting'), agentsState);
  assert.deepEqual(f.closedCases, []);
  const retry = await f.activate(prepared);
  assert.deepEqual(retry, activated);
  assert.equal(f.runs.length, 1);
  await f.api(`/api/live/session/${prepared.body.session.id}`, undefined, 'DELETE');
  assert.deepEqual(f.closedCases, ['case-switch']);
});

test('queued classification blocks a switch before any new provider session is created', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  const pending = deferred();
  f.app.backend.classify = () => pending.promise;
  const socket = f.sockets.get(started.body.session.id);
  socket.receive({ type: 'session.input_transcript.delta', event_id: 'speech', delta: '面談したいです。' });
  socket.receive({ type: 'session.delegation.created', delegation: { id: 'slow-classification', target: 'client' } });
  const blocked = await f.prepare(started.body.session.id);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'busy');
  assert.equal(f.creates.length, 1);
  pending.resolve({ route: 'recruiting', language: 'ja' });
  await until(() => f.runs.length === 1);
});

test('failed candidate creation leaves the old conversation usable and releases the switch lock', async (t) => {
  const f = await fixture(t, { create: (_input, count) => {
    if (count === 2) throw Object.assign(new Error('synthetic provider unavailable'), { status: 503 });
    return { session: { id: `live-${count}` }, transport: { sdp: 'v=0\r\nanswer' } };
  } });
  const started = await f.start();
  const oldId = started.body.session.id;
  assert.equal((await f.prepare(oldId)).status, 502);
  assert.equal(f.sockets.get(oldId).readyState, 1);
  assert.deepEqual(f.closedCases, []);
  const retry = await f.prepare(oldId);
  assert.equal(retry.status, 200);
  await f.api(`/api/live/session/${retry.body.session.id}`, undefined, 'DELETE');
  f.sockets.get(oldId).receive({ type: 'session.input_transcript.delta', event_id: 'retry-speech', delta: '会話を続けます。' });
  f.sockets.get(oldId).receive({ type: 'session.delegation.created', delegation: { id: 'after-failure', target: 'client' } });
  await until(() => f.runs.length === 1);
  assert.match(f.runs[0].transcript, /会話を続け/);
});

test('a delegation arriving during preparation resumes on the original transport after rollback', async (t) => {
  const pending = deferred();
  const f = await fixture(t, { create: (_input, count) => count === 2 ? pending.promise
    : { session: { id: `live-${count}` }, transport: { sdp: 'v=0\r\nanswer' } } });
  const started = await f.start();
  const preparing = f.prepare(started.body.session.id);
  await until(() => f.creates.length === 2);
  const socket = f.sockets.get(started.body.session.id);
  socket.receive({ type: 'session.input_transcript.delta', event_id: 'late-speech', delta: '質問を続けます。' });
  socket.receive({ type: 'session.delegation.created', delegation: { id: 'late-delegation', target: 'client' } });
  assert.equal(f.runs.length, 0);
  pending.reject(Object.assign(new Error('synthetic unavailable'), { status: 503 }));
  assert.equal((await preparing).status, 502);
  await until(() => f.runs.length === 1);
  assert.match(f.runs[0].transcript, /質問を続け/);
  assert.ok(socket.sent.some((event) => event.type === 'session.commentary.append' && event.delegation_id === 'late-delegation'));
});

test('the case id remains reserved until main-call Agents cleanup finishes', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  const cleaning = deferred();
  let entered = false;
  f.app.backend.closeCase = async () => { entered = true; await cleaning.promise; return []; };
  const closing = f.api(`/api/live/session/${started.body.session.id}`, undefined, 'DELETE');
  await until(() => entered);
  assert.equal((await f.start()).status, 409);
  assert.equal(f.creates.length, 1);
  cleaning.resolve();
  assert.equal((await closing).status, 200);
  assert.equal((await f.start()).status, 200);
});

test('candidate expiry restores the original session and a second in-flight switch is rejected', async (t) => {
  const f = await fixture(t, { handoffTimeoutMs: 100 });
  const started = await f.start();
  const oldId = started.body.session.id;
  const prepared = await f.prepare(oldId);
  const second = await f.prepare(oldId, 'recruiting');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'handoff_in_progress');
  await until(() => f.sockets.get(prepared.body.session.id).readyState === 3);
  const late = await f.activate(prepared);
  assert.ok([404, 409].includes(late.status));
  assert.equal(f.sockets.get(oldId).readyState, 1);
  assert.deepEqual(f.closedCases, []);
  assert.equal((await f.prepare(oldId, 'recruiting')).status, 200);
});

test('closing the main call also discards its candidate and cleans backend context only once', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  const prepared = await f.prepare(started.body.session.id);
  await f.api(`/api/live/session/${started.body.session.id}`, undefined, 'DELETE');
  await until(() => f.sockets.get(prepared.body.session.id).readyState === 3);
  assert.deepEqual(f.closedCases, ['case-switch']);
  assert.ok([404, 409].includes((await f.activate(prepared)).status));
});

test('retired-session close events identify their transport and never delete a shared backend case', async () => {
  const emitted = [];
  const state = createCaseState('shared-case');
  state.activeSessionId = 'old-live';
  let closed = 0;
  const session = new LiveConversation({ id: 'old-live', caseId: state.id, language: 'ja', caseState: state,
    backend: { closeCase: async () => { closed++; return []; } }, emit: (event) => emitted.push(event),
    handoffs: () => [], onClose: () => {}, remember: () => {}, closeTimeoutMs: 20,
    socketFactory: () => new FakeSocket() });
  await session.ready;
  state.activeSessionId = 'new-live';
  await session.close();
  assert.equal(closed, 0);
  assert.deepEqual(emitted.find((event) => event.type === 'live.closed'), {
    type: 'live.closed', case_id: 'shared-case', session_id: 'old-live',
  });
});

test('startup history preserves user authority and is bounded for long Unicode transcripts', () => {
  const history = Array.from({ length: 100 }, (_, index) => ({
    type: index % 2 ? 'session.output_transcript.delta' : 'session.input_transcript.delta',
    delta: `${index}:` + '日本語🙂'.repeat(500),
  }));
  const input = initialHistory(history);
  assert.ok(input.length <= 32);
  assert.ok(input.reduce((sum, item) => sum + Buffer.byteLength(item.content[0].text), 0) <= 6000);
  assert.ok(input.every((item) => ['user', 'assistant'].includes(item.role)));
  assert.equal(input.at(-1).role, 'assistant');
  assert.ok(input.every((item) => !item.content[0].text.includes('\ufffd')));
});
