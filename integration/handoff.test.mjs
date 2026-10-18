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
import { mcpCall } from './mcp-client.mjs';

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

async function fixture(t, { create, handoffTimeoutMs = 30000, prewarmTimeoutMs = 60000, slackFetch, extraEnv = {} } = {}) {
  const sockets = new Map();
  const creates = [];
  const runs = [];
  const closedCases = [];
  const stateDir = await mkdtemp(join(tmpdir(), 'future-company-handoff-'));
  const app = createIntegration({ stateDir, handoffTimeoutMs, prewarmTimeoutMs, closeTimeoutMs: 20, slackFetch,
    env: { HUMAN_MCP_TOKEN: 'local-handoff-test-token', HUMAN_MCP_URL: 'https://mcp.example.invalid/mcp', ...extraEnv },
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

test('automatic voice handoff preserves the completed business turn without running it again', async (t) => {
  const f = await fixture(t);
  const started = await f.start();
  const oldId = started.body.session.id;
  f.app.backend.classify = async () => ({ route: 'haas', language: 'ja' });
  f.sockets.get(oldId).receive({ type: 'session.input_transcript.delta', event_id: 'automatic-input', delta: '担当者に確認をお願いします。' });
  f.sockets.get(oldId).receive({ type: 'session.delegation.created', delegation: { id: 'automatic-work', target: 'client' } });
  await until(() => f.runs.length === 1);
  await pause(0);
  assert.equal((await f.api(`/api/live/session/${oldId}/handoff`, { sdp: 'v=0\r\n', route: 'haas', automatic: 'true' })).status, 400);
  const prepared = await f.api(`/api/live/session/${oldId}/handoff`, { sdp: 'v=0\r\n', route: 'haas', automatic: true });
  assert.equal(prepared.status, 200);
  assert.equal((await f.activate(prepared)).status, 200);
  await pause(0);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0].route, 'haas');
  assert.equal(f.sockets.get(oldId).readyState, 3);
  const candidate = f.sockets.get(prepared.body.session.id);
  assert.ok(candidate.sent.some(event => event.type === 'session.instructions.append' && /handoff is complete/.test(event.content)));
  candidate.receive({ type: 'session.input_transcript.delta', event_id: 'next-input', delta: 'ありがとうございます。' });
  candidate.receive({ type: 'session.delegation.created', delegation: { id: 'next-work', target: 'client' } });
  await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].source, 'delegation');
});

test('early handoff runs the first business turn on the new voice, without waiting for its answer', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/live/session', { sdp: 'v=0\r\n', handoff_before_work: 'true' })).status, 400);
  const started = await f.api('/api/live/session', { sdp: 'v=0\r\n', case_id: 'case-switch', handoff_before_work: true });
  const oldId = started.body.session.id;
  f.app.backend.classify = async () => ({ route: 'recruiting', language: 'ja' });
  const old = f.sockets.get(oldId);
  old.receive({ type: 'session.input_transcript.delta', event_id: 'early-input', delta: '採用面談をお願いします。' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'early-work', target: 'client' } });
  await pause(20);
  assert.equal(f.runs.length, 0, 'The reception voice must not start the specialist business turn');
  const prepared = await f.api(`/api/live/session/${oldId}/handoff`, { sdp: 'v=0\r\n', route: 'recruiting', automatic: true, prewarm: true });
  assert.equal(prepared.status, 200);
  assert.equal((await f.activate(prepared)).status, 200);
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].liveSessionId, prepared.body.session.id);
  assert.equal(f.runs[0].route, 'recruiting');
  assert.equal((await f.activate(prepared)).status, 200);
  await pause(10);
  assert.equal(f.runs.length, 1, 'Activation replay cannot repeat the business turn');
  assert.equal(old.readyState, 3);
});

test('a current native department decision starts handoff without waiting for model delegation', async t => {
  const f = await fixture(t);
  const started = await f.api('/api/live/session', { sdp: 'v=0\r\n', case_id: 'case-switch', handoff_before_work: true });
  const old = f.sockets.get(started.body.session.id);
  old.receive({ type: 'session.input_transcript.delta', event_id: 'call-recruiter', delta: '採用担当を呼んでください。' });
  old.receive({ type: 'decision.event', source_event_id: 'call-recruiter', source_event_type: 'session.input_transcript.delta',
    event: { type: 'decision.completed', decision: { answers: [{ name: 'route', type: 'choice', choice: 'recruiting', confidence: .99 }] } } });
  f.app.backend.classify = async () => ({ route: 'recruiting', language: 'ja' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'late-delegation', target: 'client' } });
  await pause(20);
  const prepared = await f.api(`/api/live/session/${started.body.session.id}/handoff`, { sdp: 'v=0\r\n', route: 'recruiting', automatic: true, prewarm: true });
  assert.equal(prepared.status, 200);
  assert.equal(f.runs.length, 0);
  assert.equal((await f.activate(prepared)).status, 200);
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].liveSessionId, prepared.body.session.id);
  assert.equal(f.runs[0].route, 'recruiting');
});

test('failed early candidate continues the unstarted task once on the original voice', async t => {
  const f = await fixture(t, { create: (_input, count) => {
    if (count > 1) throw new OpenAI.APIConnectionError({ cause: new TypeError('Candidate unavailable') });
    return { session: { id: 'original' }, transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' } };
  } });
  const started = await f.api('/api/live/session', { sdp: 'v=0\r\n', case_id: 'case-switch', handoff_before_work: true });
  const old = f.sockets.get(started.body.session.id);
  f.app.backend.classify = async () => ({ route: 'recruiting', language: 'ja' });
  old.receive({ type: 'session.input_transcript.delta', event_id: 'request', delta: '採用担当を呼んでください。' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'work', target: 'client' } });
  await pause(20);
  assert.equal(f.runs.length, 0);
  assert.equal((await f.api('/api/live/session/original/handoff', { sdp: 'v=0\r\n', route: 'recruiting', automatic: true, prewarm: true })).status, 502);
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].liveSessionId, 'original');
  assert.equal(old.readyState, 1);
});

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
  assert.equal(status.body.prewarm_configured, true);
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
  const started = await f.start('haas');
  const oldId = started.body.session.id;
  const oldSocket = f.sockets.get(oldId);
  oldSocket.receive({ type: 'session.input_transcript.delta', event_id: 'heard-1', delta: '開発環境を人間に確認してください。' });
  oldSocket.receive({ type: 'session.output_transcript.delta', event_id: 'said-1', delta: '担当者に確認します。' });
  const agentsState = { id: 'agents-haas', active: false };
  f.app.backend.sessions.set('case-switch:haas', agentsState);
  const commands = [];
  const device = f.app.gateway.service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop'] }, (command) => { commands.push(command); return true; });
  const request = f.app.gateway.service.requestHuman({ case_id: 'case-switch', reason: 'human_requested',
    summary: '架空の開発環境の確認', language: 'ja', idempotency_key: 'question-1' });
  const command = commands.find((entry) => entry.type === 'ring.start');
  const prepared = await f.prepare(oldId, 'recruiting');
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.old_session_id, oldId);
  assert.equal(prepared.body.voice, 'harema');
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
  assert.equal(f.runs[0].route, 'haas');
  assert.match(f.runs[0].transcript, /架空回答: TypeScript/);
  assert.match(f.runs[0].transcript, /開発環境を人間に確認/);
  assert.equal(f.app.backend.sessions.get('case-switch:haas'), agentsState);
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
    type: 'live.closed', case_id: 'shared-case', session_id: 'old-live', reason: 'unknown',
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

test('automatic voice handoff preserves a confirmed task without starting another Agent turn', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const oldId = started.body.session.id;
  f.app.backend.classify = async () => ({ route: 'haas', language: 'en' });
  f.sockets.get(oldId).receive({ type: 'session.input_transcript.delta', event_id: 'confirmed-input', delta: 'Find an engineer for this task.' });
  f.sockets.get(oldId).receive({ type: 'session.delegation.created', delegation: { id: 'first-task', target: 'client' } });
  await until(() => f.runs.length === 1);
  await pause(0);
  const wrong = await f.api(`/api/live/session/${oldId}/handoff`, { sdp: 'v=0\r\n', route: 'recruiting', automatic: true });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, 'routing_changed');
  assert.equal(f.creates.length, 1);
  const prepared = await f.api(`/api/live/session/${oldId}/handoff`, { sdp: 'v=0\r\n', route: 'haas', automatic: true });
  assert.equal(prepared.status, 200);
  assert.equal((await f.activate(prepared)).status, 200);
  const next = f.sockets.get(prepared.body.session.id);
  next.receive({ type: 'session.delegation.created', delegation: { id: 'stale-history-request', target: 'client' } });
  await pause(0);
  assert.equal(f.runs.length, 1, 'Changing voice must not repeat a completed business task');
  assert.match(next.sent.find(event => event.type === 'session.instructions.append').content, /automatic change only selects the department voice/);
  assert.equal(next.sent.filter(event => event.type === 'session.commentary.append').length, 1,
    'The new voice announces itself without requiring another caller utterance');
  assert.equal((await f.activate(prepared)).status, 200);
  assert.equal(next.sent.filter(event => event.type === 'session.commentary.append').length, 1,
    'An activation retry must not repeat the voice introduction');
  next.receive({ type: 'session.input_transcript.delta', event_id: 'new-input', delta: 'I have another question.' });
  next.receive({ type: 'session.delegation.created', delegation: { id: 'new-task', target: 'client' } });
  await until(() => f.runs.length === 2);
  assert.match(f.runs[1].transcript, /another question/);
});

test('a human answer queued during automatic handoff resumes once even before fresh caller speech', async t => {
  const f = await fixture(t);
  const started = await f.start('haas');
  const commands = [];
  const device = f.app.gateway.service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop'] }, command => { commands.push(command); return true; });
  const request = f.app.gateway.service.requestHuman({ case_id: 'case-switch', reason: 'human_requested',
    summary: 'Fictional engineering answer', language: 'en', idempotency_key: 'auto-human' });
  const command = commands[0];
  const prepared = await f.api(`/api/live/session/${started.body.session.id}/handoff`, { sdp: 'v=0\r\n', route: 'haas', automatic: true });
  for (const type of ['ring.started', 'handset.off_hook', 'handset.on_hook']) {
    device.handleEvent({ type, handoff_id: request.handoff_id, command_id: command.command_id,
      ...(type === 'handset.on_hook' ? { result: { text: 'Fictional answer: TypeScript.', language: 'en' } } : {}) });
  }
  assert.equal(f.runs.length, 0);
  const active = await f.activate(prepared);
  assert.equal(active.status, 200);
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].source, 'human_event');
  assert.equal(f.runs[0].route, 'haas');
  assert.match(f.runs[0].transcript, /Fictional answer: TypeScript/);
  await until(() => f.sockets.get(prepared.body.session.id).sent.some(event => event.type === 'session.commentary.append'));
  assert.equal(f.sockets.get(prepared.body.session.id).sent.filter(event => event.type === 'session.commentary.append').length, 1,
    'A queued human answer is delivered directly without an extra greeting');
  f.sockets.get(prepared.body.session.id).receive({ type: 'session.delegation.created', delegation: { id: 'duplicate-old-work', target: 'client' } });
  await pause(0);
  assert.equal(f.runs.length, 1);
});

test('prewarm prepares harema during old work, then catches up only new history once before activation', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const oldId = started.body.session.id;
  const old = f.sockets.get(oldId);
  const pending = deferred();
  f.app.backend.classify = async () => ({ route: 'recruiting', language: 'ja' });
  f.app.backend.run = async input => { f.runs.push(input); return pending.promise; };
  old.receive({ type: 'session.input_transcript.delta', event_id: 'initial-input', delta: '採用面談を希望します。' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'initial-task', target: 'client' } });
  await until(() => f.runs.length === 1);
  const prepared = await f.api(`/api/live/session/${oldId}/handoff`, {
    sdp: 'v=0\r\n', route: 'recruiting', automatic: true, prewarm: true });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.body.prewarm, true);
  assert.equal(f.creates[0].session.audio.output.voice, 'shida');
  assert.equal(f.creates[1].session.audio.output.voice, 'harema');
  assert.equal(f.creates[1].session.input[0].content[0].text, '採用面談を希望します。');
  const next = f.sockets.get(prepared.body.session.id);
  assert.equal(next.sent.filter(event => event.type === 'session.commentary.append').length, 0,
    'A prepared voice must stay silent before activation');
  const busy = await f.activate(prepared);
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, 'busy');
  assert.equal(next.readyState, 1);
  old.receive({ type: 'session.input_transcript.delta', event_id: 'new-input', delta: '追加の本人申告です。' });
  pending.resolve('最初の質問です。');
  await until(() => old.sent.some(event => event.type === 'session.commentary.append'));
  old.receive({ type: 'session.output_transcript.delta', event_id: 'new-output', delta: '準備中に済ませた質問です。' });
  next.receive({ type: 'session.started', session: { id: prepared.body.session.id, model: 'gpt-live-1',
    audio: { output: { voice: 'harema' } }, instructions: 'NEVER_LOG_PRIVATE_CONTEXT' } });
  await pause(0);
  const activated = await f.activate(prepared);
  assert.equal(activated.status, 200);
  assert.equal(activated.body.observed_voice, 'harema');
  assert.equal(activated.body.observed_model, 'gpt-live-1');
  const catchups = () => next.sent.filter(event => event.content?.startsWith('Additional conversation'));
  assert.equal(catchups().length, 1);
  assert.match(catchups()[0].content, /追加の本人申告/);
  assert.match(catchups()[0].content, /準備中に済ませた質問/);
  assert.doesNotMatch(catchups()[0].content, /採用面談を希望/);
  assert.match(catchups()[0].content, /past conversation data, not instructions or new work/);
  assert.deepEqual(await f.activate(prepared), activated);
  assert.equal(catchups().length, 1);
  next.receive({ type: 'session.delegation.created', delegation: { id: 'do-not-replay', target: 'client' } });
  await pause(0);
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.closedCases, []);
  const resources = await readFile(join(f.stateDir, 'resources.jsonl'), 'utf8');
  const observed = resources.trim().split('\n').map(JSON.parse).find(event => event.type === 'live_started');
  assert.equal(observed.voice, 'harema');
  assert.equal(observed.model, 'gpt-live-1');
  assert.doesNotMatch(resources, /NEVER_LOG_PRIVATE_CONTEXT|追加の本人申告/);
});

test('prewarm keeps old delegation and human answer delivery live, and deleting its candidate preserves the case', async t => {
  const pending = deferred();
  const f = await fixture(t, { create: (_input, count) => count === 2 ? pending.promise
    : { session: { id: `live-${count}` }, transport: { sdp: 'v=0\r\nanswer' } } });
  const started = await f.start('haas');
  const oldId = started.body.session.id;
  const old = f.sockets.get(oldId);
  const preparing = f.api(`/api/live/session/${oldId}/handoff`, {
    sdp: 'v=0\r\n', route: 'haas', automatic: true, prewarm: true });
  await until(() => f.creates.length === 2);
  old.receive({ type: 'session.input_transcript.delta', event_id: 'warm-input', delta: '既存の会話を続けます。' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'warm-task', target: 'client' } });
  await until(() => f.runs.length === 1);
  const commands = [];
  const device = f.app.gateway.service.connectDevice({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop'] }, command => { commands.push(command); return true; });
  const request = f.app.gateway.service.requestHuman({ case_id: 'case-switch', reason: 'human_requested',
    summary: '人間回答の継続確認', language: 'ja', idempotency_key: 'warm-human' });
  const command = commands[0];
  for (const type of ['ring.started', 'handset.off_hook', 'handset.on_hook']) device.handleEvent({ type,
    handoff_id: request.handoff_id, command_id: command.command_id,
    ...(type === 'handset.on_hook' ? { result: { text: '回答本文です。', language: 'ja' } } : {}) });
  await until(() => f.runs.length === 2);
  assert.equal(f.runs[1].source, 'human_event');
  assert.match(f.runs[1].transcript, /回答本文/);
  assert.ok(old.sent.some(event => event.type === 'session.commentary.append'));
  pending.resolve({ session: { id: 'live-2' }, transport: { sdp: 'v=0\r\nanswer' } });
  const prepared = await preparing;
  assert.equal(prepared.status, 200);
  assert.equal((await f.api(`/api/live/session/${prepared.body.session.id}`, undefined, 'DELETE')).status, 200);
  assert.equal(old.readyState, 1);
  assert.deepEqual(f.closedCases, []);
  old.receive({ type: 'session.input_transcript.delta', event_id: 'after-cancel', delta: '候補を取り消しても続けます。' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'after-cancel-task', target: 'client' } });
  await until(() => f.runs.length === 3);
});

test('prewarm validates the confirmed route and keeps only one bounded candidate', async t => {
  const f = await fixture(t, { prewarmTimeoutMs: 120000 });
  const started = await f.start();
  const path = `/api/live/session/${started.body.session.id}/handoff`;
  assert.equal((await f.api(path, { sdp: 'v=0\r\n', route: 'reception', prewarm: true })).status, 400);
  assert.equal((await f.api(path, { sdp: 'v=0\r\n', route: 'recruiting', automatic: true, prewarm: true })).body.code, 'routing_changed');
  const prepared = await f.api(path, { sdp: 'v=0\r\n', route: 'reception', automatic: true, prewarm: true });
  assert.equal(prepared.status, 200);
  assert.ok(Date.parse(prepared.body.expires_at) - Date.now() <= 60000);
  assert.ok(Date.parse(prepared.body.expires_at) > Date.now());
  assert.equal((await f.api(path, { sdp: 'v=0\r\n', route: 'reception', automatic: true, prewarm: true })).body.code, 'handoff_in_progress');
  await f.api(`/api/live/session/${started.body.session.id}`, undefined, 'DELETE');
  await until(() => f.sockets.get(prepared.body.session.id).readyState === 3);
  assert.deepEqual(f.closedCases, ['case-switch']);
});

test('a changed route rejects and discards a prewarmed candidate without stopping the original call', async t => {
  const f = await fixture(t);
  const started = await f.start();
  const old = f.sockets.get(started.body.session.id);
  const prepared = await f.api(`/api/live/session/${started.body.session.id}/handoff`, {
    sdp: 'v=0\r\n', route: 'reception', automatic: true, prewarm: true });
  f.app.backend.classify = async () => ({ route: 'recruiting', language: 'ja' });
  old.receive({ type: 'session.input_transcript.delta', event_id: 'change-route', delta: '採用面談へお願いします。' });
  old.receive({ type: 'session.delegation.created', delegation: { id: 'change-route-task', target: 'client' } });
  await until(() => f.runs.length === 1);
  const activated = await f.activate(prepared);
  assert.equal(activated.status, 409);
  assert.equal(activated.body.code, 'routing_changed');
  await until(() => f.sockets.get(prepared.body.session.id).readyState === 3);
  assert.equal(old.readyState, 1);
  assert.deepEqual(f.closedCases, []);
});

test('an expired prewarm closes only the candidate and permits another preparation', async t => {
  const f = await fixture(t, { prewarmTimeoutMs: 40 });
  const started = await f.start();
  const input = { sdp: 'v=0\r\n', route: 'reception', automatic: true, prewarm: true };
  const path = `/api/live/session/${started.body.session.id}/handoff`;
  const prepared = await f.api(path, input);
  assert.equal(prepared.status, 200);
  await until(() => f.sockets.get(prepared.body.session.id).readyState === 3);
  assert.equal(f.sockets.get(started.body.session.id).readyState, 1);
  assert.deepEqual(f.closedCases, []);
  assert.ok([404, 409].includes((await f.activate(prepared)).status));
  assert.equal((await f.api(path, input)).status, 200);
});

test('closing while provider prewarm creation is pending discards the late candidate without reviving the case', async t => {
  const pending = deferred();
  const f = await fixture(t, { create: (_input, count) => count === 2 ? pending.promise
    : { session: { id: `live-${count}` }, transport: { sdp: 'v=0\r\nanswer' } } });
  const started = await f.start();
  const preparing = f.api(`/api/live/session/${started.body.session.id}/handoff`, {
    sdp: 'v=0\r\n', route: 'reception', automatic: true, prewarm: true });
  await until(() => f.creates.length === 2);
  await f.api(`/api/live/session/${started.body.session.id}`, undefined, 'DELETE');
  pending.resolve({ session: { id: 'live-2' }, transport: { sdp: 'v=0\r\nanswer' } });
  const prepared = await preparing;
  assert.equal(prepared.status, 409);
  assert.equal(prepared.body.code, 'handoff_expired');
  assert.equal(f.sockets.get('live-2').readyState, 3);
  assert.deepEqual(f.closedCases, ['case-switch']);
  assert.equal((await f.start()).status, 200);
});


test('language selection keeps the case, wins over classification and persists through voice handoff', async t => {
  const f = await fixture(t);
  const started = await f.api('/api/live/session', { sdp: 'v=0\r\n', case_id: 'case-language', language: 'ja', language_preference: 'en' });
  const oldId = started.body.session.id;
  assert.match(f.creates[0].session.instructions, /explicitly selected English/);
  const language = (id, value = 'ja', preference = value, caseId = 'case-language') => f.api(`/api/live/session/${id}/language`, { case_id: caseId, language: value, language_preference: preference });
  assert.equal((await language(oldId, 'ja', 'ja', 'foreign-case')).status, 403);
  assert.equal((await language(oldId, 'ja', 'en')).status, 400);
  assert.equal((await language(oldId, 'ja')).status, 200);
  f.app.backend.classify = async () => ({ route: 'recruiting', language: 'en' });
  f.sockets.get(oldId).receive({ type: 'session.input_transcript.delta', event_id: 'language-input', delta: 'I would like an interview.' });
  f.sockets.get(oldId).receive({ type: 'session.delegation.created', delegation: { target: 'client', id: 'language-delegation' } });
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].language, 'ja');
  const prepared = await f.prepare(oldId, 'recruiting');
  assert.equal((await language(oldId, 'en')).status, 409);
  assert.match(f.creates[1].session.instructions, /explicitly selected Japanese/);
  const newId = prepared.body.session.id;
  await f.activate(prepared);
  assert.equal((await language(oldId)).status, 404);
  const automatic = await language(newId, 'en', 'auto');
  assert.equal(automatic.status, 200);
  assert.equal(automatic.body.language_preference, 'auto');
  assert.equal(automatic.body.case_id, 'case-language');
  assert.match(f.sockets.get(newId).sent.at(-1).content, /automatic language/);
});

test('recruiting MCP arrival and consultation share a Slack thread; explicit reply resumes the original Agent once', async t => {
  const posts = [];
  const f = await fixture(t, { extraEnv: { SLACK_BOT_TOKEN: 'fixture-bot', SLACK_CHANNEL_ID: 'C123' },
    slackFetch: async (url, options) => {
      if (new URL(url).pathname.endsWith('chat.postMessage')) {
        posts.push(JSON.parse(options.body));
        return Response.json({ ok: true, channel: 'C123', ts: posts.length === 1 ? '100.000001' : '100.000003' });
      }
      return Response.json({ ok: true, messages: [{ user: 'U123', ts: '100.000002', thread_ts: '100.000001', text: '回答: これは質問より前の古い回答です。' }, { user: 'U123', ts: '100.000004', thread_ts: '100.000001', text: '回答: 開発にはTypeScriptを使用しています。' }] });
    } });
  await f.start('recruiting');
  const url = `http://127.0.0.1:${f.app.server.address().port}/mcp`;
  const arrived = await mcpCall(url, 'local-handoff-test-token', 'notify_recruiter', { case_id: 'case-switch', applicant_summary: '本人はReactの経験があると話しました。' });
  assert.equal(arrived.notification_status, 'sent'); assert.equal(arrived.kind, 'recruiting_arrival');
  assert.equal(f.app.gateway.service.listRequests().length, 0);
  const request = await mcpCall(url, 'local-handoff-test-token', 'request_human', { case_id: 'case-switch', reason: 'agent_unable', summary: '開発環境への質問', task: '利用言語は何ですか', expected_result: '利用言語', idempotency_key: 'slack-question' });
  assert.equal(request.transport, 'slack'); assert.equal(request.device_id, 'slack-ai');
  await until(() => posts.length === 2 && f.app.gateway.service.getHumanRequest(request.handoff_id).notification_status === 'sent');
  assert.equal(posts[1].thread_ts, '100.000001');
  await f.app.slack.pollOnce();
  await until(() => f.runs.length === 1);
  assert.equal(f.runs[0].route, 'recruiting'); assert.equal(f.runs[0].source, 'human_event');
  assert.match(f.runs[0].transcript, /untrusted answer data/); assert.match(f.runs[0].transcript, /TypeScript/);
  const saved = f.app.gateway.service.getHumanRequest(request.handoff_id);
  assert.equal(saved.status, 'completed'); assert.equal(saved.simulated, false); assert.equal(saved.result_source, 'slack_thread');
  await f.app.slack.pollOnce(); assert.equal(f.runs.length, 1);
});

test('interview report requires latest caller end request and sends only once through MCP', async t => {
  const posts = [];
  const f = await fixture(t, { extraEnv: { SLACK_BOT_TOKEN: 'fixture-bot', SLACK_CHANNEL_ID: 'C123' },
    slackFetch: async (_url, options) => {
      posts.push(JSON.parse(options.body));
      return Response.json({ ok: true, channel: 'C123', ts: '100.000001' });
    } });
  const started = await f.start('recruiting');
  const socket = f.sockets.get(started.body.session.id);
  const url = `http://127.0.0.1:${f.app.server.address().port}/mcp`;
  const input = { case_id: 'case-switch', applicant_summary: 'React経験', interview_summary: '予約画面の開発について話しました。', next_actions: ['採用担当が内容を確認する'] };
  const report = () => mcpCall(url, 'local-handoff-test-token', 'complete_interview', input);
  socket.receive({ type: 'session.output_transcript.delta', event_id: 'ai-end', delta: '面接終了してください。' });
  assert.equal((await report()).error, 'interview_end_not_requested');
  socket.receive({ type: 'session.input_transcript.delta', event_id: 'user-end', delta: '面接終了してください。' });
  assert.equal((await report()).notification_status, 'sent');
  assert.equal((await report()).notification_status, 'sent');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].thread_ts, undefined);
  assert.equal(f.app.gateway.service.listRequests().length, 0);
  socket.receive({ type: 'session.output_transcript.delta', event_id: 'ai-thanks', delta: 'ありがとうございます。' });
  socket.receive({ type: 'session.input_transcript.delta', event_id: 'new-topic', delta: 'まだ面接を続けたいです。' });
  assert.equal((await report()).error, 'interview_end_not_requested');
  assert.equal(posts.length, 1);
});
