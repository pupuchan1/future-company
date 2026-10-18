import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyVisitorApi, WORKER_ORIGIN } from './proxy.mjs';
const site = 'https://haas.example.test';
const env = { CF_ACCESS_CLIENT_ID: 'server-id', CF_ACCESS_CLIENT_SECRET: 'server-secret' };
const visitor = `future_company_visitor=${'a'.repeat(64)}`;

test('Sites forwards case creation and cookie ownership with only server Access credentials', async () => {
  let seen;
  const response = await proxyVisitorApi(new Request(`${site}/api/v1/cases`, {
    method: 'POST', headers: { Origin: site, 'Content-Type': 'application/json', Cookie: `${visitor}; future_company_staff=private`,
      'CF-Access-Client-Secret': 'attacker', Authorization: 'Bearer private' }, body: '{"locale":"ja"}',
  }), env, async (url, options) => {
    seen = { url, options };
    return Response.json({ case: { id: 'case-a' } }, { status: 201, headers: { 'Set-Cookie': `${visitor}; Domain=upstream.test; Path=/api/v1`, 'CF-Access-Client-Secret': 'must-not-leak' } });
  });
  assert.equal(response.status, 201);
  assert.equal(seen.url, `${WORKER_ORIGIN}/api/v1/cases`);
  assert.equal(seen.options.headers.get('Origin'), WORKER_ORIGIN);
  assert.equal(seen.options.headers.get('Cookie'), visitor);
  assert.equal(seen.options.headers.get('Authorization'), null);
  assert.equal(seen.options.headers.get('CF-Access-Client-Secret'), env.CF_ACCESS_CLIENT_SECRET);
  assert.equal(new TextDecoder().decode(seen.options.body), '{"locale":"ja"}');
  assert.equal(response.headers.get('CF-Access-Client-Secret'), null);
  assert.equal(response.headers.get('set-cookie'), `${visitor}; Path=/api/v1; HttpOnly; Secure; SameSite=Strict`);
});

test('public gateway rejects staff, arbitrary targets, cross-origin writes and oversized bodies', async () => {
  const unexpected = () => { throw new Error('Must not reach Worker'); };
  for (const path of ['/api/v1/staff/login', '/api/v1/cases?target=https://other.test', '/mcp']) {
    assert.equal((await proxyVisitorApi(new Request(site + path), env, unexpected)).status, 404);
  }
  assert.equal((await proxyVisitorApi(new Request(`${site}/api/v1/cases`, { method: 'POST', headers: { Origin: 'https://other.test' } }), env, unexpected)).status, 403);
  assert.equal((await proxyVisitorApi(new Request(`${site}/api/v1/cases`, { method: 'POST', headers: { Origin: site }, body: 'x'.repeat(512 * 1024 + 1) }), env, unexpected)).status, 413);
});

test('SSE remains streamed and redirects do not expose upstream login', async () => {
  const request = () => new Request(`${site}/api/v1/cases/case-a/voice/events`, { headers: { Cookie: visitor } });
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"routing.updated"}\n\n')); controller.close(); } });
  const response = await proxyVisitorApi(request(), env, async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.match(await response.text(), /routing.updated/);
  const redirect = await proxyVisitorApi(request(), env, async () => new Response(null, { status: 302, headers: { Location: 'https://login.test' } }));
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get('location'), null);
});
