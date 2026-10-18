import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createDemoGateway } from './demo-gateway.mjs';

const username = 'test';
const password = 'local-test-password-00000000000000000000';
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
async function fixture(t, handler, options = {}) {
  const requests = [];
  const worker = createServer((req, res) => { requests.push(req); void handler(req, res); });
  worker.listen(0, '127.0.0.1'); await once(worker, 'listening');
  const workerOrigin = `http://127.0.0.1:${worker.address().port}`;
  const gateway = createDemoGateway({ workerOrigin, username, password, ...options });
  gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  t.after(async () => { await gateway.shutdown(); worker.closeAllConnections(); await new Promise(resolve => worker.close(resolve)); });
  return { requests, origin, workerOrigin,
    request: (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { Authorization: authorization, ...init.headers } }),
    socket: (path, headers = {}) => new WebSocket(`${origin.replace('http:', 'ws:')}${path}`, { headers: { Authorization: authorization, Origin: origin, Cookie: 'visitor=owner', ...headers } }),
  };
}
async function denied(socket) {
  socket.on('error', () => {});
  return new Promise((resolve, reject) => {
    socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected authorized socket')); });
    socket.once('unexpected-response', (_req, res) => { res.resume(); socket.terminate(); resolve(res.statusCode); });
  });
}

test('gateway challenges unauthenticated requests before reaching the Worker', async t => {
  const f = await fixture(t, (_req, res) => res.end('private'));
  for (const header of ['', 'Basic invalid']) {
    const response = await fetch(f.origin, { headers: { Authorization: header } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.requests.length, 0);
});

test('HTML opts into WS while assets, visitor cookies and same-origin request bodies are proxied', async t => {
  let receivedBody;
  const f = await fixture(t, async (req, res) => {
    if (req.method === 'POST') { const chunks = []; for await (const chunk of req) chunks.push(chunk); receivedBody = Buffer.concat(chunks).toString(); }
    res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html' : 'application/json', 'Set-Cookie': ['visitor=signed; Path=/api/v1; HttpOnly; SameSite=Strict'] });
    res.end(req.url === '/' ? '<html><head></head><body>pupu</body></html>' : '{"ok":true}');
  });
  const html = await f.request('/');
  assert.match(await html.text(), /<meta name="future-company-events" content="websocket"><\/head>/);
  assert.equal(html.headers.get('set-cookie'), 'visitor=signed; Path=/api/v1; HttpOnly; SameSite=Strict');
  const result = await f.request('/api/v1/cases', { method: 'POST', headers: { Origin: f.origin, Cookie: 'visitor=owner', 'Content-Type': 'application/json' }, body: '{"kind":"haas"}' });
  assert.equal(result.status, 200);
  assert.equal(receivedBody, '{"kind":"haas"}');
  assert.equal(f.requests[1].headers.origin, f.workerOrigin);
  assert.equal(f.requests[1].headers.cookie, 'visitor=owner');
  assert.equal(f.requests[1].headers.authorization, undefined);
});

test('cross-origin writes and sockets cannot reuse Basic credentials', async t => {
  const f = await fixture(t, (_req, res) => res.end('never'));
  for (const headers of [{ Origin: 'https://elsewhere.test' }, {}, { Origin: f.origin, 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await f.request('/api/v1/cases', { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
  }
  assert.equal(await denied(f.socket('/api/v1/cases/case-a/voice/events', { Origin: 'https://elsewhere.test' })), 403);
  assert.equal(await denied(f.socket('/api/v1/cases/case-a/voice/events', { Authorization: 'Basic invalid' })), 401);
  assert.equal(f.requests.length, 0);
});

test('Worker ownership is checked before WebSocket upgrade, on every connection', async t => {
  const f = await fixture(t, (req, res) => {
    res.writeHead(req.headers.cookie === 'visitor=owner' ? 404 : 403, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  assert.equal(await denied(f.socket('/api/v1/cases/case-a/voice/events', { Cookie: 'visitor=someone-else' })), 403);
  assert.equal(await denied(f.socket('/api/v1/cases/case-a/voice/events')), 404);
  assert.equal(await denied(f.socket('/api/events')), 404);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(req => !req.headers.authorization && req.headers.origin === f.workerOrigin));
});

test('fragmented SSE becomes case-filtered WS messages and closing the browser releases upstream', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  const f = await fixture(t, (_req, res) => {
    res.on('close', upstreamClosed);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': connected\n\ndata: {"type":"backend.result","case_id":"case-b","content":"private"}\n\n');
    res.write('data: {"type":"backend.result","case_id":"case-a",');
    res.write('"content":"our result"}\r\n\r\n');
  });
  const ws = f.socket('/api/v1/cases/case-a/voice/events');
  const incoming = once(ws, 'message');
  const [bytes] = await incoming;
  assert.deepEqual(JSON.parse(bytes.toString()), { type: 'backend.result', case_id: 'case-a', content: 'our result' });
  ws.close(); await once(ws, 'close'); await closed;
});

test('events are receive-only and an ended upstream closes the browser for reauthorization', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); });
  const ws = f.socket('/api/v1/cases/case-a/voice/events');
  await once(ws, 'open');
  const ended = once(ws, 'close'); ws.send('not a command');
  const [code] = await ended; assert.equal(code, 1008);
});

test('upstream redirects are never followed with the visitor cookie', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { Location: 'https://elsewhere.test/private' }); res.end(); });
  const response = await f.request('/api/v1/cases/owned', { headers: { Cookie: 'visitor=owner' } });
  assert.equal(response.status, 502);
  assert.equal(f.requests.length, 1);
  assert.equal(response.headers.get('location'), null);
});

test('gateway configuration binds a fixed loopback Worker and validates private credentials', () => {
  assert.throws(() => createDemoGateway({ username, password: 'short' }), /password/);
  assert.throws(() => createDemoGateway({ username, password, workerOrigin: 'https://remote.test' }), /loopback/);
  assert.throws(() => createDemoGateway({ username, password, workerOrigin: 'http://127.0.0.1:8787/other' }), /loopback/);
  assert.throws(() => createDemoGateway({ username, password, publicOrigin: 'http://public.test' }), /HTTPS/);
});
