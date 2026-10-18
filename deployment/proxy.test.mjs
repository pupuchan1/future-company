import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createProductionVoiceProxy } from './worker-proxy.mjs';
import { createProductionRelay } from './relay.mjs';
import { MAX_BODY_BYTES, signRelayRequest } from './protocol.mjs';
import { createHumanGateway } from '../integration/human/gateway.mjs';
import { mcpCall } from '../integration/mcp-client.mjs';

const secret = 'relay_test_secret_'.repeat(3);
const machineToken = 'machine_test_token_'.repeat(3);
const publicOrigin = 'https://voice.example.test';
const prefix = (caseId) => `/api/v1/cases/${caseId}/voice`;
const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, options = {}) {
  const calls = [];
  const upstream = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const data = text ? JSON.parse(text) : {};
    calls.push({ path: req.url, method: req.method, headers: req.headers, data });
    // These checks exercise the existing integration's loopback-only contract.
    assert.ok(req.headers.host.startsWith('127.0.0.1:'));
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers.forwarded, undefined);
    assert.equal(req.headers['x-forwarded-for'], undefined);
    assert.equal(req.headers['x-future-signature'], undefined);
    if (req.url === '/api/status') return reply(res, 200, {
      live_configured: true, mcp_configured: true, decisions_enabled: true, handoff_configured: true,
      recruiting_human_transport: 'slack', slack_configured: true, slack_replies_configured: true,
      voice_map: { reception: 'shida', recruiting: 'harema' }, internal_secret: 'must-not-escape',
      requests: [{ case_id: 'case-a', device_id: 'phone-a', summary: 'ours' }, { case_id: 'case-b', device_id: 'phone-b', summary: 'private' }],
      devices: [{ device_id: 'phone-a', online: true, simulated: true, internal: 'private' }, { device_id: 'phone-b', online: true }],
    });
    if (req.url === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const frames = [
        { type: 'backend.result', case_id: 'case-b', content: 'private' },
        { type: 'backend.error', content: 'global-private' },
        { type: 'human.completed', data: { case_id: 'case-a', result: { text: '日本語の回答' } } },
        { type: 'backend.result', case_id: 'case-a', content: 'ours' },
        { type: 'human.completed', case_id: 'case-a', data: { case_id: 'case-b' } },
      ];
      const bytes = Buffer.from(`: heartbeat\r\n\r\n${frames.map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`).join('')}`);
      for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
      if (!options.holdEvents) res.end();
      return;
    }
    if (req.url === '/api/live/session') return reply(res, 200, { case_id: data.case_id, session: { id: `live-${data.case_id}` }, transport: { sdp: 'v=0\nanswer' } });
    if (req.url === '/api/worker/results') return reply(res, 202, { accepted: true });
    if (req.url.endsWith('/handoff')) return reply(res, 200, { case_id: data.case_id, session: { id: `next-${data.case_id}` }, old_session_id: `live-${data.case_id}`, handoff_token: 'fake-ticket', transport: { sdp: 'v=0\nanswer' } });
    if (req.url.endsWith('/activate')) {
      await options.beforeActivate?.();
      return reply(res, options.activationStatus ?? 200, { case_id: data.case_id, session: { id: `next-${data.case_id}` },
        old_session_id: `live-${data.case_id}`, active: true, ...options.activationValues });
    }
    if (req.url.endsWith('/language')) {
      await options.beforeLanguage?.();
      return reply(res, 200, { case_id: data.case_id, session: { id: req.url.split('/')[4] },
        language: data.language, language_preference: data.language_preference });
    }
    if (req.method === 'DELETE') return reply(res, 200, { closed: true });
    if (req.url === '/mcp') return reply(res, 200, { jsonrpc: '2.0', id: 1, result: { ok: true } });
    return reply(res, 404, { error: 'missing' });
  });
  const wsServer = new WebSocketServer({ noServer: true });
  upstream.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/bridge');
    assert.equal(req.headers.authorization, `Bearer ${machineToken}`);
    wsServer.handleUpgrade(req, socket, head, (ws) => ws.on('message', (message) => ws.send(message)));
  });
  const target = await listen(upstream);
  const relay = createProductionRelay({ target, secret, humanMcpToken: machineToken, eventLifetimeMs: options.holdEvents ? 60 : 60000 });
  const relayOrigin = await listen(relay.server);
  const authorizeCalls = [];
  const worker = createProductionVoiceProxy({ allowLoopbackTarget: true,
    authorizeCase: async (request, _env, caseId) => {
      authorizeCalls.push(caseId);
      if (request.headers.get('Cookie') !== `visitor=${caseId}`) throw { status: 404 };
    },
  });
  const env = { NODE_RELAY_ORIGIN: relayOrigin, NODE_RELAY_SECRET: secret, NODE_RELAY_EVENTS_TRANSPORT: 'sse' };
  async function browser(caseId, suffix, { method = 'GET', data, cookie = `visitor=${caseId}`, origin = publicOrigin, extraHeaders = {} } = {}) {
    return worker(new Request(`${publicOrigin}${prefix(caseId)}${suffix}`, {
      method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...extraHeaders },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }), env);
  }
  t.after(async () => {
    await relay.close();
    for (const ws of wsServer.clients) ws.terminate();
    wsServer.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });
  return { relay, relayOrigin, target, worker, env, browser, calls, authorizeCalls };
}

test('Worker authorizes the cookie on the case prefix and preserves #19 proof through the real relay', async (t) => {
  const f = await fixture(t);
  const response = await f.browser('case-a', '/session', { method: 'POST', data: { sdp: 'v=0', case_proof: 'case-bound-proof', extra: { preserved: true } }, extraHeaders: { Authorization: 'Bearer attacker', 'X-Future-Case-Id': 'case-b' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session.id, 'live-case-a');
  assert.deepEqual(f.calls[0].data, { sdp: 'v=0', case_proof: 'case-bound-proof', extra: { preserved: true }, case_id: 'case-a' });
  assert.equal(f.calls[0].headers.authorization, undefined);
  assert.deepEqual(f.authorizeCalls, ['case-a']);
  assert.equal(response.headers.get('x-future-signature'), null);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('cross-origin, foreign case, mismatching body and arbitrary relay routes are rejected before upstream', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.browser('case-a', '/session', { method: 'POST', data: { sdp: 'v=0' }, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.browser('case-a', '/status', { cookie: 'visitor=case-b' })).status, 404);
  assert.equal((await f.browser('case-a', '/session', { method: 'POST', data: { case_id: 'case-b' } })).status, 403);
  assert.equal(await f.browser('case-a', '/../../status'), undefined);
  assert.equal((await fetch(`${f.relayOrigin}/api/status`)).status, 404);
  assert.equal((await fetch(`${f.relayOrigin}/relay/voice/status`)).status, 403);
  assert.equal(f.calls.length, 0);
});

test('explicit result resync preserves the bridge token and case authorization; 202 remains acceptance only', async (t) => {
  const f = await fixture(t);
  const response = await f.browser('case-a', '/results', { method: 'POST', data: { bridge_token: 'case-a-bridge-token' } });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.deepEqual(f.calls.map(({ path, data }) => ({ path, data })), [{ path: '/api/worker/results', data: { bridge_token: 'case-a-bridge-token', case_id: 'case-a' } }]);
  assert.equal((await f.browser('case-a', '/results', { method: 'POST', data: { bridge_token: 'foreign' }, cookie: 'visitor=case-b' })).status, 404);
  assert.equal((await f.browser('case-a', '/results', { method: 'POST', data: { case_id: 'case-b', bridge_token: 'foreign' } })).status, 403);
  assert.equal((await f.browser('case-a', '/results')).status, 404);
  assert.equal(f.calls.length, 1);
});

test('Worker uses its supported manual redirect mode and rejects redirects without forwarding credentials', async () => {
  let attempts = 0;
  const worker = createProductionVoiceProxy({ authorizeCase: async () => {}, fetchImpl: async (_url, options) => {
    attempts++;
    // workerd rejects redirect:error with TypeError before any upstream request.
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example.test/' } });
  } });
  const response = await worker(new Request(`${publicOrigin}${prefix('case-a')}/status`), {
    NODE_RELAY_ORIGIN: 'https://relay.example.test', NODE_RELAY_SECRET: secret,
  });
  assert.equal(response.status, 502);
  assert.equal(attempts, 1);
  assert.equal(response.headers.get('Location'), null);
  assert.equal((await response.json()).error, 'voice_relay_unavailable');
});

test('status and fragmented SSE expose only the authorized case', async (t) => {
  const f = await fixture(t);
  const status = await (await f.browser('case-a', '/status')).json();
  assert.equal(status.internal_secret, undefined);
  assert.equal(status.recruiting_human_transport, 'slack');
  assert.equal(status.slack_configured, true);
  assert.equal(status.slack_replies_configured, true);
  assert.deepEqual(status.requests.map((item) => item.case_id), ['case-a']);
  assert.deepEqual(status.devices, [{ device_id: 'phone-a', online: true, simulated: true }]);
  const response = await f.browser('case-a', '/events');
  const stream = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!stream.includes('private') && !stream.includes('case-b'));
  const events = stream.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)));
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.case_id === 'case-a'));
  assert.equal(events[0].data.result.text, '日本語の回答');
});

test('voice ownership survives a handoff and rejects foreign IDs and IDs after relay restart', async (t) => {
  const f = await fixture(t);
  await (await f.browser('case-a', '/session', { method: 'POST', data: { sdp: 'v=0' } })).json();
  assert.equal((await f.browser('case-b', '/session/live-case-a', { method: 'DELETE' })).status, 404);
  const handoff = await f.browser('case-a', '/session/live-case-a/handoff', { method: 'POST', data: { sdp: 'v=0', case_proof: 'still-preserved', route: 'haas' } });
  assert.equal((await handoff.json()).session.id, 'next-case-a');
  assert.equal((await f.browser('case-a', '/session/next-case-a/activate', { method: 'POST', data: { handoff_token: 'fake-ticket' } })).status, 200);
  assert.equal((await f.browser('case-a', '/session/next-case-a', { method: 'DELETE' })).status, 200);
  assert.equal((await f.browser('case-a', '/session/next-case-a', { method: 'DELETE' })).status, 404);
  const restarted = createProductionRelay({ target: f.target, secret });
  const origin = await listen(restarted.server);
  t.after(() => restarted.close());
  const path = '/relay/voice/session/live-case-a';
  const headers = await signRelayRequest({ secret, path, method: 'DELETE', caseId: 'case-a' });
  const before = f.calls.length;
  assert.equal((await fetch(`${origin}${path}`, { method: 'DELETE', headers })).status, 404);
  assert.equal(f.calls.length, before);
});

test('confirmed activation retires only the old binding and remains safe to retry', async (t) => {
  const f = await fixture(t);
  for (const caseId of ['case-a', 'case-b']) {
    assert.equal((await f.browser(caseId, '/session', { method: 'POST', data: { sdp: 'v=0' } })).status, 200);
  }
  assert.equal((await f.browser('case-a', '/session/live-case-a/handoff', { method: 'POST', data: { sdp: 'v=0', route: 'haas' } })).status, 200);
  for (let retry = 0; retry < 2; retry++) {
    assert.equal((await f.browser('case-a', '/session/next-case-a/activate', { method: 'POST', data: { handoff_token: 'fake-ticket' } })).status, 200);
  }
  const before = f.calls.length;
  assert.equal((await f.browser('case-a', '/session/live-case-a', { method: 'DELETE' })).status, 404);
  assert.equal((await f.browser('case-b', '/session/next-case-a', { method: 'DELETE' })).status, 404);
  assert.equal(f.calls.length, before, 'Retired/foreign bindings cannot reach Node');
  assert.equal((await f.browser('case-b', '/session/live-case-b', { method: 'DELETE' })).status, 200);
  assert.equal((await f.browser('case-a', '/session/next-case-a', { method: 'DELETE' })).status, 200);
});

test('failed or incomplete activation evidence preserves old, candidate and foreign bindings', async (t) => {
  const options = {};
  const f = await fixture(t, options);
  for (const caseId of ['case-a', 'case-b']) await f.browser(caseId, '/session', { method: 'POST', data: { sdp: 'v=0' } });
  await f.browser('case-a', '/session/live-case-a/handoff', { method: 'POST', data: { sdp: 'v=0', route: 'haas' } });
  for (const [status, values] of [
    [409, {}], [200, { active: false }], [200, { old_session_id: undefined }],
    [200, { old_session_id: 'next-case-a' }], [200, { old_session_id: 'live-case-b' }],
  ]) {
    options.activationStatus = status; options.activationValues = values;
    assert.equal((await f.browser('case-a', '/session/next-case-a/activate', { method: 'POST', data: { handoff_token: 'fake-ticket' } })).status, status);
    for (const [caseId, id] of [['case-a', 'live-case-a'], ['case-a', 'next-case-a'], ['case-b', 'live-case-b']]) {
      assert.equal((await f.browser(caseId, `/session/${id}/language`, { method: 'POST', data: { language: 'ja', language_preference: 'ja' } })).status, 200);
    }
  }
});

test('completed handoffs release capacity after 128 calls instead of rejecting the next caller', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 128; index++) {
    const caseId = `case-finished-${index}`;
    assert.equal((await f.browser(caseId, '/session', { method: 'POST', data: { sdp: 'v=0' } })).status, 200);
    assert.equal((await f.browser(caseId, `/session/live-${caseId}/handoff`, { method: 'POST', data: { sdp: 'v=0', route: 'haas' } })).status, 200);
    assert.equal((await f.browser(caseId, `/session/next-${caseId}/activate`, { method: 'POST', data: { handoff_token: 'fake-ticket' } })).status, 200);
    assert.equal((await f.browser(caseId, `/session/next-${caseId}`, { method: 'DELETE' })).status, 200);
  }
  assert.equal((await f.browser('case-new', '/session', { method: 'POST', data: { sdp: 'v=0' } })).status, 200);
});

test('128 currently registered sessions still enforce the relay limit until one closes', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 128; index++) {
    assert.equal((await f.browser(`case-active-${index}`, '/session', { method: 'POST', data: { sdp: 'v=0' } })).status, 200);
  }
  const full = await f.browser('case-overflow', '/session', { method: 'POST', data: { sdp: 'v=0' } });
  assert.equal(full.status, 503);
  assert.equal((await full.json()).error, 'relay_session_limit');
  assert.equal((await f.browser('case-active-0', '/session/live-case-active-0', { method: 'DELETE' })).status, 200);
  assert.equal((await f.browser('case-overflow', '/session', { method: 'POST', data: { sdp: 'v=0' } })).status, 200);
});

test('a delayed language reply cannot recreate a retired old binding after activation', async (t) => {
  const arrived = deferred(), release = deferred();
  const f = await fixture(t, { beforeLanguage: async () => { arrived.resolve(); await release.promise; } });
  await f.browser('case-a', '/session', { method: 'POST', data: { sdp: 'v=0' } });
  await f.browser('case-a', '/session/live-case-a/handoff', { method: 'POST', data: { sdp: 'v=0', route: 'haas' } });
  const pending = f.browser('case-a', '/session/live-case-a/language', { method: 'POST', data: { language: 'ja', language_preference: 'ja' } });
  try {
    await arrived.promise;
    assert.equal((await f.browser('case-a', '/session/next-case-a/activate', { method: 'POST', data: { handoff_token: 'fake-ticket' } })).status, 200);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal((await f.browser('case-a', '/session/live-case-a', { method: 'DELETE' })).status, 404);
  assert.equal((await f.browser('case-a', '/session/next-case-a', { method: 'DELETE' })).status, 200);
});

test('a delayed activation reply cannot recreate a candidate already closed by Stop', async (t) => {
  const arrived = deferred(), release = deferred();
  const f = await fixture(t, { beforeActivate: async () => { arrived.resolve(); await release.promise; } });
  await f.browser('case-a', '/session', { method: 'POST', data: { sdp: 'v=0' } });
  await f.browser('case-a', '/session/live-case-a/handoff', { method: 'POST', data: { sdp: 'v=0', route: 'haas' } });
  const pending = f.browser('case-a', '/session/next-case-a/activate', { method: 'POST', data: { handoff_token: 'fake-ticket' } });
  try {
    await arrived.promise;
    assert.equal((await f.browser('case-a', '/session/next-case-a', { method: 'DELETE' })).status, 200);
  } finally { release.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal((await f.browser('case-a', '/session/next-case-a', { method: 'DELETE' })).status, 404);
});

test('HMAC rejects replay, expiration, path and body tampering; a new nonce permits safe retry', async (t) => {
  const f = await fixture(t);
  const path = '/relay/voice/status';
  const headers = await signRelayRequest({ secret, path, method: 'GET', caseId: 'case-a' });
  assert.equal((await fetch(`${f.relayOrigin}${path}`, { headers })).status, 200);
  assert.equal((await fetch(`${f.relayOrigin}${path}`, { headers })).status, 409);
  const fresh = await signRelayRequest({ secret, path, method: 'GET', caseId: 'case-a' });
  assert.equal((await fetch(`${f.relayOrigin}${path}`, { headers: fresh })).status, 200);
  assert.equal((await fetch(`${f.relayOrigin}/relay/voice/events`, { headers: fresh })).status, 403);
  const expired = await signRelayRequest({ secret, path, method: 'GET', caseId: 'case-a', now: Date.now() - 60000 });
  assert.equal((await fetch(`${f.relayOrigin}${path}`, { headers: expired })).status, 403);
  const postPath = '/relay/voice/session';
  const signedBody = new TextEncoder().encode('{"case_id":"case-a"}');
  const postHeaders = await signRelayRequest({ secret, path: postPath, method: 'POST', caseId: 'case-a', body: signedBody });
  assert.equal((await fetch(`${f.relayOrigin}${postPath}`, { method: 'POST', headers: postHeaders, body: '{"case_id":"case-b"}' })).status, 403);
  assert.equal(f.calls.length, 2);
});

test('SSE has a finite lifetime and body limits do not forward oversized input', async (t) => {
  const f = await fixture(t, { holdEvents: true });
  const response = await f.browser('case-a', '/events');
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('日本語'));
  const before = f.calls.length;
  assert.equal((await f.browser('case-a', '/session', { method: 'POST', data: { sdp: 'x'.repeat(MAX_BODY_BYTES + 1) } })).status, 413);
  assert.equal((await fetch(`${f.relayOrigin}/relay/voice/session`, { method: 'POST', body: 'x'.repeat(MAX_BODY_BYTES + 1) })).status, 413);
  assert.equal(f.calls.length, before);
});

test('MCP and a real WebSocket bridge use machine auth, with no public route to the development UI', async (t) => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.relayOrigin}/mcp`, { method: 'POST', body: '{}' })).status, 401);
  const response = await fetch(`${f.relayOrigin}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${machineToken}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].headers.authorization, `Bearer ${machineToken}`);
  const ws = new WebSocket(f.relayOrigin.replace('http:', 'ws:') + '/bridge', { headers: { Authorization: `Bearer ${machineToken}` } });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  const message = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'device.hello' }));
  assert.equal((await message)[0].toString(), '{"type":"device.hello"}');
  ws.close();
  await once(ws, 'close');
  assert.equal((await fetch(`${f.relayOrigin}/`)).status, 404);
});

test('MCP v2 discovery and tool calls reach the installed gateway SDK with required headers intact', async (t) => {
  const gateway = createHumanGateway({ token: machineToken });
  const calls = [];
  const upstream = createServer(async (req, res) => {
    calls.push({ ...req.headers });
    if (!await gateway.handleRequest(req, res)) res.writeHead(404).end();
  });
  const target = await listen(upstream);
  const relay = createProductionRelay({ target, secret, humanMcpToken: machineToken });
  const origin = await listen(relay.server);
  t.after(async () => {
    await relay.close(); await gateway.close();
    upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
  });
  const discovery = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${machineToken}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'server/discover' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'relay-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {} },
    } }),
  });
  assert.equal(discovery.status, 200);
  assert.ok((await discovery.json()).result.supportedVersions.includes('2026-07-28'));
  const template = await mcpCall(`${origin}/mcp`, machineToken, 'get_interview_template', { language: 'ja' });
  assert.equal(template.language, 'ja');
  assert.equal(template.questions.length, 3);
  assert.equal(template.decision_maker, 'human');
  assert.equal(calls[1]['mcp-method'], 'tools/call');
  assert.equal(calls[1]['mcp-name'], 'get_interview_template');
});

test('MCP parameter header namespace is preserved while unrelated client headers are dropped', async (t) => {
  const f = await fixture(t);
  const response = await fetch(`${f.relayOrigin}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${machineToken}`, 'Content-Type': 'application/json',
      'Mcp-Method': 'tools/call', 'Mcp-Name': 'declared-tool', 'Mcp-Param-Case_Id': 'case-a',
      'Mcp-Param-Custom.Value': '=?base64?5pel5pys6Kqe?=', 'X-Private-Header': 'must-not-forward',
      'X-Forwarded-For': '203.0.113.1' }, body: '{}',
  });
  assert.equal(response.status, 200);
  const headers = f.calls[0].headers;
  assert.equal(headers['mcp-param-case_id'], 'case-a');
  assert.equal(headers['mcp-param-custom.value'], '=?base64?5pel5pys6Kqe?=');
  assert.equal(headers['x-private-header'], undefined);
  assert.equal(headers['x-forwarded-for'], undefined);
});

test('WebSocket backhaul returns case-filtered browser SSE and rejects unsigned/replayed upgrades', async (t) => {
  const f = await fixture(t);
  const worker = createProductionVoiceProxy({ allowLoopbackTarget: true, authorizeCase: async () => {},
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.get('Upgrade'), 'websocket');
      const socket = new WebSocket(String(url).replace('http:', 'ws:'), { headers: Object.fromEntries(options.headers) });
      const target = new EventTarget();
      const queued = [];
      let accepted = false;
      const emit = (event) => accepted ? target.dispatchEvent(event) : queued.push(event);
      socket.on('message', (data) => emit(new MessageEvent('message', { data: data.toString() })));
      socket.on('close', () => emit(new Event('close')));
      socket.on('error', () => emit(new Event('error')));
      await once(socket, 'open');
      target.accept = () => { accepted = true; queueMicrotask(() => queued.splice(0).forEach((event) => target.dispatchEvent(event))); };
      target.close = (code, reason) => socket.close(code, reason);
      t.after(() => socket.terminate());
      return { status: 101, webSocket: target };
    },
  });
  const response = await worker(new Request(`${publicOrigin}${prefix('case-a')}/events`), { ...f.env, NODE_RELAY_EVENTS_TRANSPORT: 'websocket' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  const text = await response.text();
  assert.ok(text.includes('日本語の回答'));
  assert.ok(!text.includes('private') && !text.includes('case-b'));
  async function denied(headers, status) {
    const socket = new WebSocket(f.relayOrigin.replace('http:', 'ws:') + '/relay/voice/events', { headers });
    socket.on('error', () => {});
    const [, response] = await once(socket, 'unexpected-response');
    assert.equal(response.statusCode, status);
    socket.terminate();
  }
  await denied({}, 403);
  const path = '/relay/voice/events';
  const signed = await signRelayRequest({ secret, path, method: 'GET', caseId: 'case-a' });
  await (await fetch(`${f.relayOrigin}${path}`, { headers: signed })).text();
  await denied(signed, 409);
});
