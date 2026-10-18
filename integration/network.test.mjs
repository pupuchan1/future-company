import test from 'node:test';
import assert from 'node:assert/strict';
import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import OpenAI from 'openai';
import { BusinessBackend, configureConnectionNetworking, connectionDiagnostic, retryConnection } from './backend.mjs';

function connectError(code = 'ETIMEDOUT') {
  const cause = Object.assign(new Error('private endpoint or credential'), { code, syscall: 'connect' });
  return new OpenAI.APIConnectionError({ cause: new TypeError('fetch failed', {
    cause: new AggregateError([cause], 'private input'),
  }) });
}

test('diagnostics recognize real SDK errors and nested network causes without logging input', () => {
  const error = connectError();
  assert.equal(error.name, 'Error');
  const diagnostic = connectionDiagnostic(error);
  assert.equal(diagnostic.name, 'APIConnectionError');
  assert.equal(diagnostic.connection_error, true);
  assert.equal(diagnostic.preconnect_failure, true);
  assert.deepEqual(diagnostic.cause_codes, ['ETIMEDOUT']);
  assert.doesNotMatch(JSON.stringify(diagnostic), /private|endpoint|credential|fetch failed/);
});

test('the address-selection budget is at least two seconds and preserves longer configured budgets', () => {
  const previous = getDefaultAutoSelectFamilyAttemptTimeout();
  try {
    setDefaultAutoSelectFamilyAttemptTimeout(250);
    assert.equal(configureConnectionNetworking(), 2000);
    setDefaultAutoSelectFamilyAttemptTimeout(3000);
    assert.equal(configureConnectionNetworking(), 3000);
  } finally { setDefaultAutoSelectFamilyAttemptTimeout(previous); }
});

test('pre-connect failures retry a bounded number of times and can recover', async () => {
  let calls = 0;
  const retries = [], waits = [];
  const result = await retryConnection(async () => {
    if (++calls < 3) throw connectError();
    return 'connected';
  }, { onRetry: (entry) => retries.push(entry), wait: async (ms) => waits.push(ms) });
  assert.equal(result, 'connected');
  assert.equal(calls, 3);
  assert.deepEqual(retries.map((entry) => entry.attempt), [1, 2]);
  assert.deepEqual(waits, [250, 500]);
  calls = 0;
  await assert.rejects(retryConnection(async () => { calls++; throw connectError(); }, { wait: async () => {} }));
  assert.equal(calls, 3);
});

test('a socket reset or ordinary API error never replays an ambiguous POST', async () => {
  for (const error of [connectError('ECONNRESET'), new TypeError('invalid request'),
    new OpenAI.APIConnectionTimeoutError()]) {
    let calls = 0;
    await assert.rejects(retryConnection(async () => { calls++; throw error; }, { wait: async () => {} }));
    assert.equal(calls, 1);
  }
});

test('closing during a retry delay prevents another provider request', async () => {
  let closed = false, calls = 0;
  await assert.rejects(retryConnection(async () => { calls++; throw connectError(); }, {
    shouldStop: () => closed, wait: async () => { closed = true; },
  }), /Conversation closed/);
  assert.equal(calls, 1);
});

test('failed Agents cleanup retains the known resource for a subsequent cleanup attempt', async () => {
  let calls = 0;
  const remembered = [];
  const backend = new BusinessBackend({ mcpUrl: 'https://mcp.example.invalid/mcp', token: 'test',
    client: { beta: { agents: { sessions: {
      async delete() { if (++calls === 1) throw connectError('ECONNRESET'); },
    } } } }, remember: (entry) => remembered.push(entry) });
  backend.sessions.set('case-cleanup:haas', { id: 'agent-known', active: false });
  assert.deepEqual(await backend.closeCase('case-cleanup'), ['agent-known']);
  assert.equal(backend.sessions.get('case-cleanup:haas').closing, true);
  assert.deepEqual(await backend.closeCase('case-cleanup'), []);
  assert.equal(backend.sessions.size, 0);
  assert.deepEqual(remembered.filter((entry) => entry.type === 'agent').map((entry) => entry.cleanup), ['pending', 'deleted']);
});
