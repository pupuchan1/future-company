import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createHumanGateway } from './gateway.mjs';

async function start(t, options = {}) {
  const gateway = createHumanGateway(options);
  const server = createServer(async (req, res) => {
    if (!await gateway.handleRequest(req, res)) res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await gateway.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { gateway, base };
}

async function rpc(base, body, token, extraHeaders = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body.params?._meta?.['io.modelcontextprotocol/protocolVersion']
        ? { 'MCP-Protocol-Version': body.params._meta['io.modelcontextprotocol/protocolVersion'], 'MCP-Method': body.method,
          ...(body.params.name ? { 'MCP-Name': body.params.name } : {}) } : {}),
      ...extraHeaders }, body: JSON.stringify(body),
  });
  const text = await response.text();
  // Legacy clients may receive a single Streamable HTTP SSE event.
  const bodyText = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').find((line) => line.startsWith('data: ')).slice(6) : text;
  return { status: response.status, body: bodyText ? JSON.parse(bodyText) : null };
}

const request = { case_id: 'mcp-case', reason: 'agent_unable', summary: 'Human confirmation needed.', language: 'en', idempotency_key: 'mcp-case-1' };
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'gateway-test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

test('HTTP MCP tools and Events discovery use the SDK; auth covers both', async (t) => {
  const { base } = await start(t, {
    token: 'test-token',
    handleEventRpc: async (body) => body.method === 'events/list'
      ? { jsonrpc: '2.0', id: body.id, result: { events: [] } } : undefined,
  });
  assert.equal((await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await rpc(base, { jsonrpc: '2.0', id: 1, method: 'events/list' })).status, 401);
  const discover = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'server/discover', params: {
    _meta: modernMeta,
  } }, 'test-token');
  assert.equal(discover.status, 200, JSON.stringify(discover.body));
  assert.ok(discover.body.result, JSON.stringify(discover.body));
  assert.deepEqual(discover.body.result.capabilities.events, {});
  assert.ok(discover.body.result.supportedVersions.includes('2026-07-28'));
  const tools = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'test-token');
  assert.deepEqual(tools.body.result.tools.map((tool) => tool.name).sort(), ['cancel_human_request', 'find_human_experts', 'get_human_request', 'get_interview_template', 'lookup_demo_order', 'request_human']);
  const experts = await rpc(base, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: {
    name: 'find_human_experts', arguments: { required_skills: ['hardware'] },
  } }, 'test-token');
  assert.equal(experts.body.result.structuredContent.candidates[0].name, 'GOROman');
  assert.equal(experts.body.result.structuredContent.candidates[0].availability, 'unknown');
  assert.equal(experts.body.result.structuredContent.dispatch.online, false);
  const handoff = await rpc(base, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_human', arguments: request } }, 'test-token');
  assert.equal(handoff.body.result.structuredContent.status, 'unavailable');
  assert.equal(handoff.body.result.structuredContent.unavailable_reason, 'device_offline');
  const events = await rpc(base, { jsonrpc: '2.0', id: 4, method: 'events/list' }, 'test-token');
  assert.deepEqual(events.body.result.events, []);
  const order = await rpc(base, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
    _meta: modernMeta, name: 'lookup_demo_order', arguments: { order_id: 'DEMO-1001' },
  } }, 'test-token');
  assert.equal(order.body.result.structuredContent.refund_requires_human, true);
  assert.equal(order.body.result.structuredContent.is_demo, true);
  const missing = await rpc(base, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
    name: 'lookup_demo_order', arguments: { order_id: 'ACTUAL-ORDER' },
  } }, 'test-token');
  assert.equal(missing.body.result.structuredContent.status, 'not_found');
  for (const language of ['ja', 'en']) {
    const interview = await rpc(base, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {
      name: 'get_interview_template', arguments: { language },
    } }, 'test-token');
    const template = interview.body.result.structuredContent;
    assert.equal(template.questions.length, 3);
    assert.equal(template.language, language);
    assert.equal(template.is_demo, true);
    assert.equal(template.data_source, 'hackathon_fixture');
    assert.doesNotMatch(`${template.role} ${template.introduction}`, /架空|デモ|模擬|fictional|demo|simulat/i);
    assert.equal(template.decision_maker, 'human');
    assert.equal(template.candidate_ranking, false);
    assert.equal(template.selection_commitment, false);
  }
});

test('loopback development rejects hostile origins and proxy access', async (t) => {
  const { base } = await start(t);
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await rpc(base, body, undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await rpc(base, body, undefined, { 'X-Forwarded-For': '203.0.113.5' })).status, 403);
  assert.equal((await rpc(base, body)).status, 200);
});

test('authenticated WebSocket ACKs drive real gateway state; disconnect is unavailable', async (t) => {
  let resolveUnavailable;
  const unavailable = new Promise((resolve) => { resolveUnavailable = resolve; });
  const { base, gateway } = await start(t, { token: 'bridge-token', onEvent: (event) => {
    if (event.name === 'human.unavailable') resolveUnavailable();
  } });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/bridge`, { headers: { Authorization: 'Bearer bridge-token' } });
  const messages = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  const helloAck = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'hello', device_id: 'black-phone-1', simulated: true,
    capabilities: ['ring.start', 'ring.stop', 'handset.events'] }));
  await helloAck;
  const commandArrives = once(ws, 'message');
  const mcp = await rpc(base, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'request_human', arguments: request,
  } }, 'bridge-token');
  const handoff = mcp.body.result.structuredContent;
  assert.equal(handoff.status, 'requested');
  await commandArrives;
  const command = messages.find((message) => message.type === 'ring.start');
  assert.ok(command);
  const eventAck = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'ring.started', handoff_id: command.handoff_id, command_id: command.command_id }));
  await eventAck;
  const current = await rpc(base, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
    name: 'get_human_request', arguments: { handoff_id: handoff.handoff_id },
  } }, 'bridge-token');
  assert.equal(current.body.result.structuredContent.status, 'ringing');
  assert.equal(current.body.result.structuredContent.simulated, true);
  ws.close();
  await once(ws, 'close');
  await unavailable;
  assert.equal(gateway.service.getHumanRequest(handoff.handoff_id).status, 'unavailable');
});

test('bridge rejects a missing bearer token', async (t) => {
  const { base } = await start(t, { token: 'bridge-token' });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/bridge`);
  ws.on('error', () => {});
  const [, response] = await once(ws, 'unexpected-response');
  assert.equal(response.statusCode, 401);
  response.resume();
  ws.terminate();
});
