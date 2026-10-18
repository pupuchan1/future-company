import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_BODY_BYTES, readBoundedBody } from './protocol.mjs';
import { filterEvent } from './relay.mjs';

const eventsPath = /^\/api\/v1\/cases\/([A-Za-z0-9_-]{1,100})\/voice\/events$/;
const marker = '<meta name="future-company-events" content="websocket">';
const safeHeaders = ['accept', 'content-type', 'cookie', 'sec-fetch-site', 'last-event-id'];
const replyHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
const sessionCookieName = '__Host-haas_demo';
const sessionLifetimeMs = 8 * 60 * 60 * 1000;

function cookiePairs(value = '') {
  return value.split(';').map(part => part.trim()).filter(Boolean);
}
function sessionCookie(token, maxAge) {
  return `${sessionCookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}
function loginPage(res, failed = false) {
  res.writeHead(failed ? 401 : 200, { ...replyHeaders, 'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
  res.end(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HaaS デモにログイン</title><style>body{margin:0;background:#f5f7fb;color:#101820;font:16px system-ui;display:grid;place-items:center;min-height:100svh}main{width:min(340px,calc(100% - 64px));padding:32px;background:white;border:1px solid #dce2eb}h1{font-size:24px;margin:0 0 10px}p{line-height:1.6;color:#536174}label{display:block;margin-top:20px}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin-top:7px;border:1px solid #bec8d6;font:inherit}button{margin-top:24px;width:100%;padding:13px;border:0;background:#125bf5;color:white;font:inherit;cursor:pointer}[role=alert]{color:#a51d2d}</style></head><body><main><h1>HaaS デモにログイン</h1><p>共有されたデモ用の認証情報を入力してください。</p>${failed ? '<p role="alert">認証情報を確認して、もう一度お試しください。</p>' : ''}<form action="/auth" method="post"><label>ユーザー名<input name="username" autocomplete="username" required maxlength="64" autofocus></label><label>パスワード<input name="password" type="password" autocomplete="current-password" required maxlength="200"></label><button type="submit">デモを開く</button></form></main></body></html>`);
}

function equal(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function respond(res, status, error) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { ...replyHeaders, 'Content-Type': 'application/json', ...(status === 401 ? { 'WWW-Authenticate': 'Basic realm="HaaS private demo", charset="UTF-8"' } : {}) });
  res.end(JSON.stringify({ error }));
}
function rejectUpgrade(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n${status === 401 ? 'WWW-Authenticate: Basic realm="HaaS private demo"\r\n' : ''}\r\n`);
}

/** Private, loopback-only gateway. No provider credentials or voice/case state are created here. */
export function createDemoGateway({ workerOrigin = 'http://127.0.0.1:8787', username, password,
  publicOrigin = '', fetchImpl = fetch, eventLifetimeMs = 60000, clock = Date.now } = {}) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(username)
    || typeof password !== 'string' || !/^[A-Za-z0-9_-]{32,200}$/.test(password)) throw new Error('Configure a demo username and a 32–200 character URL-safe password.');
  const worker = new URL(workerOrigin);
  if (worker.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(worker.hostname) || worker.pathname !== '/' || worker.search || worker.hash || worker.username || worker.password) throw new Error('Worker target must be a fixed loopback HTTP origin.');
  const published = publicOrigin ? new URL(publicOrigin) : null;
  if (published && (published.protocol !== 'https:' || published.pathname !== '/' || published.search || published.hash || published.username || published.password)) throw new Error('The public origin must be an HTTPS origin.');
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  let sessionToken = randomBytes(32).toString('base64url');
  let sessionExpiresAt = clock() + sessionLifetimeMs;
  const controllers = new Set();
  const websockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  let closing = false;

  function checkOrigin(req, requireOrigin = false) {
    const host = req.headers.host;
    if (typeof host !== 'string' || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) return 400;
    const protocol = req.headers['x-forwarded-proto'] === 'https' ? 'https:' : 'http:';
    const origin = published?.origin ?? `${protocol}//${host}`;
    if (published && host !== published.host) return 403;
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)
      || (requireOrigin && req.headers.origin !== origin)) return 403;
    return 0;
  }
  function authenticated(req) {
    if (equal(req.headers.authorization, expectedAuth)) return true;
    const candidates = cookiePairs(req.headers.cookie).filter(pair => pair.startsWith(`${sessionCookieName}=`));
    return candidates.length === 1 && clock() < sessionExpiresAt && equal(candidates[0].slice(sessionCookieName.length + 1), sessionToken);
  }
  function authorize(req, requireOrigin = false) {
    if (!authenticated(req)) return 401;
    return checkOrigin(req, requireOrigin);
  }
  function upstream(req) {
    const path = new URL(req.url, 'http://gateway.invalid');
    const target = new URL(worker.origin);
    target.pathname = path.pathname; target.search = path.search;
    const headers = new Headers();
    for (const name of safeHeaders) if (typeof req.headers[name] === 'string') {
      const value = name === 'cookie' ? cookiePairs(req.headers[name]).filter(pair => !pair.startsWith(`${sessionCookieName}=`)).join('; ') : req.headers[name];
      if (value) headers.set(name, value);
    }
    // Only requests that already passed the public same-origin check are rewritten.
    if (req.headers.origin) headers.set('Origin', worker.origin);
    return { target, headers, path };
  }
  function begin(socket, lifetime) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    controllers.add(controller); socket.on('close', abort);
    const timer = setTimeout(abort, lifetime); timer.unref();
    return { controller, cleanup() { clearTimeout(timer); socket.off('close', abort); controllers.delete(controller); } };
  }

  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://gateway.invalid');
    if (!closing && req.method === 'POST' && ['/auth', '/logout'].includes(path.pathname) && !path.search) {
      const denied = checkOrigin(req, true);
      if (denied) return respond(res, denied, 'same_origin_required');
      if (path.pathname === '/logout') {
        req.resume();
        res.writeHead(303, { ...replyHeaders, Location: '/', 'Set-Cookie': sessionCookie('', 0) });
        return res.end();
      }
      if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/x-www-form-urlencoded') return respond(res, 415, 'form_required');
      if (Number(req.headers['content-length']) > 4096) { req.resume(); return respond(res, 413, 'request_too_large'); }
      try {
        const body = new URLSearchParams(new TextDecoder().decode(await readBoundedBody(Readable.toWeb(req), 4096)));
        if (body.getAll('username').length !== 1 || body.getAll('password').length !== 1
          || !equal(body.get('username'), username) || !equal(body.get('password'), password)) return loginPage(res, true);
        if (clock() >= sessionExpiresAt) { sessionToken = randomBytes(32).toString('base64url'); sessionExpiresAt = clock() + sessionLifetimeMs; }
        res.writeHead(303, { ...replyHeaders, Location: '/', 'Set-Cookie': sessionCookie(sessionToken, Math.floor((sessionExpiresAt - clock()) / 1000)) });
        return res.end();
      } catch (error) { return respond(res, error?.status === 413 ? 413 : 400, error?.status === 413 ? 'request_too_large' : 'invalid_form'); }
    }
    if (!closing && req.method === 'GET' && path.pathname === '/' && !authenticated(req)) {
      const denied = checkOrigin(req);
      if (denied) return respond(res, denied, 'same_origin_required');
      return loginPage(res);
    }
    const denied = closing ? 503 : authorize(req, !['GET', 'HEAD'].includes(req.method));
    if (denied) return respond(res, denied, denied === 401 ? 'authentication_required' : 'same_origin_required');
    const { controller, cleanup } = begin(res, 45000);
    try {
      const { target, headers } = upstream(req);
      const bytes = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBoundedBody(Readable.toWeb(req));
      const response = await fetchImpl(target, { method: req.method, headers, ...(bytes ? { body: bytes } : {}), redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return respond(res, 502, 'upstream_redirect_rejected'); }
      const type = response.headers.get('Content-Type') || 'application/octet-stream';
      const outputHeaders = { ...replyHeaders, 'Content-Type': type };
      const isSecure = published?.protocol === 'https:' || req.headers['x-forwarded-proto'] === 'https';
      const cookies = response.headers.getSetCookie().map(cookie => isSecure && !/;\s*Secure(?:;|$)/i.test(cookie) ? `${cookie}; Secure` : cookie);
      if (cookies.length) outputHeaders['Set-Cookie'] = cookies;
      if (type.includes('text/html') && req.method !== 'HEAD') {
        const html = new TextDecoder().decode(await readBoundedBody(response.body, 2 * 1024 * 1024));
        res.writeHead(response.status, outputHeaders);
        res.end(html.includes('</head>') ? html.replace('</head>', `${marker}</head>`) : `${marker}${html}`);
      } else {
        res.writeHead(response.status, outputHeaders);
        if (response.body && req.method !== 'HEAD') await pipeline(Readable.fromWeb(response.body), res);
        else res.end();
      }
    } catch (error) {
      if (!res.headersSent) respond(res, error?.status === 413 ? 413 : 502, error?.status === 413 ? 'request_too_large' : 'worker_unavailable');
      else res.destroy();
    } finally { cleanup(); }
  });

  server.on('upgrade', async (req, socket, head) => {
    const denied = closing ? 503 : authorize(req, true);
    if (denied) return rejectUpgrade(socket, denied);
    const { target, headers, path } = upstream(req);
    const match = eventsPath.exec(path.pathname);
    if (!match || path.search || req.method !== 'GET') return rejectUpgrade(socket, 404);
    const { controller, cleanup } = begin(socket, eventLifetimeMs);
    let response;
    let ws;
    const stop = () => { controller.abort(); if (ws?.readyState === 1) ws.close(1000, 'Reconnect to verify case access'); };
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      headers.set('Accept', 'text/event-stream');
      response = await fetchImpl(target, { headers, redirect: 'manual', signal: controller.signal });
      if (socket.destroyed || controller.signal.aborted) return;
      if (!response.ok || !response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) {
        await response.body?.cancel(); return rejectUpgrade(socket, [401, 403, 404].includes(response.status) ? response.status : 502);
      }
      // Worker authorized this visitor cookie before a WebSocket is accepted.
      ws = await new Promise(resolve => websockets.handleUpgrade(req, socket, head, resolve));
      ws.on('close', stop); ws.on('error', stop);
      ws.on('message', () => ws.close(1008, 'Events are receive-only'));
      const heartbeat = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 15000); heartbeat.unref();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (!controller.signal.aborted && ws.readyState === 1) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          if (Buffer.byteLength(pending) > MAX_BODY_BYTES) throw new Error('Event frame too large');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (!data) continue;
            let event;
            try { event = filterEvent(JSON.parse(data), match[1]); } catch { continue; }
            if (!event) continue;
            if (ws.bufferedAmount > MAX_BODY_BYTES) throw new Error('Event reader too slow');
            ws.send(JSON.stringify(event));
          }
        }
      } finally { clearInterval(heartbeat); await reader.cancel().catch(() => {}); }
    } catch {
      if (!ws) rejectUpgrade(socket, 502);
    } finally {
      controller.signal.removeEventListener('abort', stop);
      controller.abort(); cleanup();
      if (ws?.readyState === 1) ws.close(1000, 'Event subscription ended');
    }
  });
  server.on('close', () => { closing = true; for (const controller of controllers) controller.abort(); for (const ws of websockets.clients) ws.terminate(); websockets.close(); });
  server.shutdown = async () => {
    closing = true;
    for (const controller of controllers) controller.abort();
    for (const ws of websockets.clients) ws.terminate();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.DEMO_GATEWAY_PORT || 4350);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid demo port.');
  const server = createDemoGateway({ username: process.env.DEMO_GATEWAY_USER, password: process.env.DEMO_GATEWAY_PASSWORD,
    workerOrigin: process.env.DEMO_GATEWAY_WORKER_ORIGIN || 'http://127.0.0.1:8787', publicOrigin: process.env.DEMO_GATEWAY_PUBLIC_ORIGIN || '' });
  server.listen(port, '127.0.0.1', () => console.log(`Private demo gateway listening on loopback port ${port}.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.shutdown().then(() => process.exit(0)); });
}
