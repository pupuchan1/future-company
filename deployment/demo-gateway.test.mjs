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
    const response = await fetch(`${f.origin}/api/v1/cases/private`, { headers: { Authorization: header } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /^Basic /);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.requests.length, 0);
});

async function login(f, fields = { username, password }, headers = {}) {
  return fetch(`${f.origin}/auth`, { method: 'POST', redirect: 'manual', headers: { Origin: f.origin, 'Content-Type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(fields) });
}

test('only the unauthenticated root renders a login form; assets and APIs stay private', async t => {
  const f = await fixture(t, (_req, res) => res.end('private app'));
  const root = await fetch(f.origin);
  assert.equal(root.status, 200); assert.equal(root.headers.get('www-authenticate'), null);
  assert.equal(root.headers.get('referrer-policy'), 'same-origin');
  const html = await root.text();
  assert.match(html, /<form action="\/auth" method="post">/);
  assert.equal(html.includes(password), false); assert.equal(html.includes('private app'), false);
  for (const path of ['/assets/app.js', '/api/v1/cases', '/favicon.ico']) assert.equal((await fetch(`${f.origin}${path}`)).status, 401);
  assert.equal(f.requests.length, 0);
});

test('same-origin form login issues an HttpOnly Secure Strict cookie and never sends it to Worker', async t => {
  const f = await fixture(t, (_req, res) => res.end('private app'));
  const response = await login(f);
  assert.equal(response.status, 303); assert.equal(response.headers.get('location'), '/');
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /^__Host-haas_demo=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=28[0-9]{3}; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(setCookie.includes(password), false);
  const cookie = setCookie.split(';')[0];
  const page = await fetch(f.origin, { headers: { Cookie: `${cookie}; visitor=owned` } });
  assert.equal(page.status, 200); assert.equal(await page.text(), 'private app');
  assert.equal(f.requests[0].headers.cookie, 'visitor=owned');
  assert.equal(f.requests[0].headers.authorization, undefined);
  const logout = await fetch(`${f.origin}/logout`, { method: 'POST', redirect: 'manual', headers: { Origin: f.origin, Cookie: cookie } });
  assert.equal(logout.status, 303); assert.match(logout.headers.get('set-cookie'), /__Host-haas_demo=; Path=\/; Max-Age=0;/);
});

test('form login rejects wrong credentials, cross-origin forms and oversized request bodies', async t => {
  const f = await fixture(t, (_req, res) => res.end('private'));
  const wrong = await login(f, { username, password: 'incorrect' });
  assert.equal(wrong.status, 401); assert.equal(wrong.headers.get('set-cookie'), null);
  assert.equal(wrong.headers.get('www-authenticate'), null);
  assert.equal((await wrong.text()).includes('incorrect'), false);
  assert.equal((await login(f, { username, password }, { Origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await login(f, { username, password }, { Origin: '' })).status, 403);
  assert.equal((await login(f, { username, password }, { Origin: 'null' })).status, 403);
  assert.equal((await login(f, { username, password: 'x'.repeat(5000) })).status, 413);
  assert.equal(f.requests.length, 0);
});

test('demo cookie expires after eight hours and old cookies do not revive after a new login', async t => {
  let now = 0;
  const f = await fixture(t, (_req, res) => res.end('private'), { clock: () => now });
  const first = await login(f); const cookie = first.headers.get('set-cookie').split(';')[0];
  now = 8 * 60 * 60 * 1000;
  const expired = await fetch(`${f.origin}/api/v1/cases`, { headers: { Cookie: cookie } });
  assert.equal(expired.status, 401);
  const next = await login(f); const nextCookie = next.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, nextCookie);
  assert.equal((await fetch(`${f.origin}/api/v1/cases`, { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(`${f.origin}/api/v1/cases`, { headers: { Cookie: nextCookie } })).status, 200);
});

test('form session cookie authorizes WebSocket without relying on browser Basic caches', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); });
  const response = await login(f); const cookie = response.headers.get('set-cookie').split(';')[0];
  const ws = f.socket('/api/v1/cases/case-a/voice/events', { Authorization: '', Cookie: `${cookie}; visitor=owner` });
  await once(ws, 'open');
  assert.equal(f.requests[0].headers.cookie, 'visitor=owner');
  assert.equal(f.requests[0].headers.authorization, undefined);
  const ended = once(ws, 'close'); ws.close(); await ended;
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
