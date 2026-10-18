import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHumanGateway } from './gateway.mjs';

test('auto simulator returns an explicitly fictional consultation answer through MCP', { timeout: 10_000 }, async (t) => {
  let resolveCompleted;
  const completion = new Promise((resolve) => { resolveCompleted = resolve; });
  const gateway = createHumanGateway({ token: 'local-simulator-test', onEvent: (event) => {
    if (event.name === 'human.completed') resolveCompleted(event);
  } });
  const server = createServer(async (req, res) => { if (!await gateway.handleRequest(req, res)) res.writeHead(404).end(); });
  server.on('upgrade', (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./simulate-phone.mjs', import.meta.url)), '--auto'], {
    env: { ...process.env, HUMAN_MCP_TOKEN: 'local-simulator-test', HUMAN_DEVICE_ID: 'test-simulator',
      HUMAN_BRIDGE_URL: `ws://127.0.0.1:${port}/bridge` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const childExit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  t.after(async () => {
    child.kill('SIGTERM');
    await childExit;
    await gateway.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  for (let attempt = 0; attempt < 100 && gateway.service.listDevices().length === 0; attempt++) await delay(10);
  assert.equal(gateway.service.listDevices()[0]?.device_id, 'test-simulator', output);
  const request = { case_id: 'consultation-demo', reason: 'agent_unable', summary: '開発環境の質問を確認', language: 'ja',
    device_id: 'test-simulator', idempotency_key: 'consultation-demo', target_role: '開発チーム',
    task: '開発環境とレビュー方法を教えてください。', expected_result: '使用技術とレビュー方法の説明' };
  async function call(name, args) {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer local-simulator-test',
        'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': 'tools/call', 'MCP-Name': name },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'simulator-test', version: '1.0' },
          'io.modelcontextprotocol/clientCapabilities': {} } } }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).result.structuredContent;
  }
  const started = await call('request_human', request);
  assert.equal(started.target_role, request.target_role);
  const event = await completion;
  assert.equal(event.data.simulated, true);
  assert.equal(event.data.result.language, 'ja');
  assert.match(event.data.result.text, /架空/);
  assert.match(event.data.result.text, /TypeScript.*React/);
  assert.match(event.data.result.text, /実在する企業の情報ではありません/);
  const completed = await call('get_human_request', { handoff_id: started.handoff_id });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, event.data.result);
  assert.equal(completed.simulated, true);
});
