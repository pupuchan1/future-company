import { createServer, request as httpRequest } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { MAX_BODY_BYTES, readBoundedBody, requireRelaySecret, verifyRelayRequest, voiceRoute } from './protocol.mjs';

const sessionPattern = /^[A-Za-z0-9_-]{1,200}$/;
const mcpRequestHeaders = new Set(['content-type', 'accept', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id']);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function sameSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); };
    const error = (error) => { cleanup(); reject(error); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        cleanup(); req.resume();
        reject(Object.assign(new Error('Body too large.'), { status: 413 }));
      } else chunks.push(chunk);
    };
    req.on('data', data); req.on('end', end); req.on('error', error);
  });
}
function headersFrom(req) {
  return new Headers(Object.entries(req.headers).filter(([, value]) => typeof value === 'string'));
}

export function filterStatus(value, caseId) {
  const requests = (Array.isArray(value?.requests) ? value.requests : []).filter((item) => item?.case_id === caseId);
  const deviceIds = new Set(requests.map((item) => item.device_id));
  const devices = (Array.isArray(value?.devices) ? value.devices : [])
    .filter((item) => deviceIds.has(item.device_id))
    .map((item) => ({ device_id: item.device_id, online: item.online === true, simulated: item.simulated === true }));
  const voiceMap = {};
  for (const name of ['reception', 'recruiting', 'haas']) {
    if (typeof value?.voice_map?.[name] === 'string') voiceMap[name] = value.voice_map[name];
  }
  return { case_id: caseId, live_configured: value?.live_configured === true,
    mcp_configured: value?.mcp_configured === true, decisions_enabled: value?.decisions_enabled === true,
    recruiting_human_transport: value?.recruiting_human_transport === 'slack' ? 'slack' : null,
    slack_configured: value?.slack_configured === true, slack_replies_configured: value?.slack_replies_configured === true,
    handoff_configured: value?.handoff_configured === true, prewarm_configured: value?.prewarm_configured === true,
    voice_map: voiceMap, requests, devices };
}

/** Reject global and conflicting-case events; normalize the top-level case for clients. */
export function filterEvent(value, caseId) {
  if (!object(value)) return null;
  const ids = [value.case_id, value.data?.case_id, value.request?.case_id, value.handoff?.case_id].filter((id) => id !== undefined);
  if (!ids.length || ids.some((id) => id !== caseId)) return null;
  return { ...value, case_id: caseId };
}

export function createProductionRelay({ target = 'http://127.0.0.1:4320', secret,
  humanMcpToken = '', fetchImpl = fetch, clock = Date.now, eventLifetimeMs = 60000, requestTimeoutMs = 45000 } = {}) {
  requireRelaySecret(secret);
  if (humanMcpToken && !/^[A-Za-z0-9_-]{32,200}$/.test(humanMcpToken)) throw new Error('HUMAN_MCP_TOKEN must contain 32–200 URL-safe characters.');
  const upstream = new URL(target);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(upstream.hostname)
    || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('The integration target must be a fixed loopback HTTP origin.');
  }
  const sessionCases = new Map();
  const nonces = new Map();
  const controllers = new Set();
  const sockets = new Set();
  const eventConnections = new Map();
  let closing = false;
  const eventWebSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES, perMessageDeflate: false });

  function acceptNonce(principal) {
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= clock()) nonces.delete(nonce);
    if (nonces.has(principal.nonce)) return 409;
    if (nonces.size >= 10000) return 503;
    // No await between duplicate check and insertion: concurrent replay has one winner.
    nonces.set(principal.nonce, principal.expiresAt);
    return 0;
  }

  function authorizedMachine(req) {
    if (!sameSecret(req.headers.authorization, `Bearer ${humanMcpToken}`) || !humanMcpToken) return false;
    if (req.headers.origin) {
      try { if (new URL(req.headers.origin).host !== req.headers.host) return false; }
      catch { return false; }
    }
    return true;
  }

  function beginRequest(res, lifetime) {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    res.on('close', abort);
    const timer = setTimeout(abort, lifetime);
    timer.unref?.();
    return { controller, cleanup() { clearTimeout(timer); res.off('close', abort); controllers.delete(controller); } };
  }

  async function streamEvents(response, res, caseId, controller) {
    if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error('Expected SSE.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    res.write(': connected\n\n');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (!controller.signal.aborted && !res.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        if (Buffer.byteLength(pending) > MAX_BODY_BYTES) throw new Error('Oversized SSE frame.');
        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) {
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
          if (!data) { if (frame.startsWith(':')) res.write(': heartbeat\n\n'); continue; }
          let value;
          try { value = filterEvent(JSON.parse(data), caseId); } catch { continue; }
          if (value && !res.write(`data: ${JSON.stringify(value)}\n\n`)) {
            // Bound slow readers instead of retaining an unbounded audio/transcript queue.
            controller.abort();
            return;
          }
        }
      }
    } finally { await reader.cancel().catch(() => {}); if (!res.destroyed) res.end(); }
  }

  async function forwardVoice(req, res, pathname, route, bytes, principal) {
    const caseId = principal.caseId;
    if (route.sessionId && sessionCases.get(route.sessionId) !== caseId) return json(res, 404, { error: 'voice_session_not_found' });
    if (route.kind === 'create' && sessionCases.size >= 128) return json(res, 503, { error: 'relay_session_limit' });
    if (req.method === 'POST') {
      let input;
      try { input = JSON.parse(bytes); } catch { return json(res, 400, { error: 'invalid_json' }); }
      if (!object(input) || input.case_id !== caseId) return json(res, 403, { error: 'case_mismatch' });
    } else if (bytes.length) return json(res, 400, { error: 'unexpected_body' });
    const isEvents = route.kind === 'events';
    if (isEvents && (eventConnections.get(caseId) || 0) >= 4) return json(res, 429, { error: 'event_connection_limit' });
    if (isEvents) eventConnections.set(caseId, (eventConnections.get(caseId) || 0) + 1);
    const operation = beginRequest(res, isEvents ? eventLifetimeMs : requestTimeoutMs);
    try {
      const response = await fetchImpl(new URL(route.upstream, upstream), { method: req.method,
        headers: { Accept: isEvents ? 'text/event-stream' : 'application/json', ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(req.method === 'POST' ? { body: bytes } : {}), redirect: 'error', signal: operation.controller.signal });
      if (isEvents) {
        if (!response.ok) { await response.body?.cancel(); return json(res, response.status, { error: 'voice_events_unavailable' }); }
        await streamEvents(response, res, caseId, operation.controller);
        return;
      }
      const responseBytes = await readBoundedBody(response.body);
      let value;
      try { value = JSON.parse(new TextDecoder().decode(responseBytes)); } catch { throw new Error('Invalid upstream JSON.'); }
      if (!object(value)) throw new Error('Invalid upstream JSON.');
      if (response.ok) {
        if (route.kind === 'status') value = filterStatus(value, caseId);
        else if (['create', 'handoff', 'activate', 'language'].includes(route.kind)) {
          const id = value.session?.id;
          if (value.case_id !== caseId || !sessionPattern.test(id || '') || (sessionCases.has(id) && sessionCases.get(id) !== caseId)) throw new Error('Invalid upstream session binding.');
          if (['activate', 'language'].includes(route.kind) && id !== route.sessionId) throw new Error('Invalid activation response.');
          sessionCases.set(id, caseId);
        } else if (route.kind === 'close') sessionCases.delete(route.sessionId);
      }
      json(res, response.status, value);
    } finally {
      operation.cleanup();
      if (isEvents) {
        const remaining = (eventConnections.get(caseId) || 1) - 1;
        if (remaining) eventConnections.set(caseId, remaining); else eventConnections.delete(caseId);
      }
    }
  }

  async function forwardMcp(req, res, bytes) {
    const operation = beginRequest(res, requestTimeoutMs);
    try {
      const headers = new Headers({ Authorization: `Bearer ${humanMcpToken}` });
      // MCP 2026-07-28 (SEP-2243) requires method/name and mirrors declared tool
      // arguments in Mcp-Param-* headers. Node has already validated header names;
      // preserve this namespace verbatim so the SDK can cross-check it with JSON.
      for (const [name, value] of Object.entries(req.headers)) {
        if ((mcpRequestHeaders.has(name) || (name.startsWith('mcp-param-') && name.length > 10)) && typeof value === 'string') {
          headers.set(name, value);
        }
      }
      const response = await fetchImpl(new URL('/mcp', upstream), { method: req.method, headers,
        ...(req.method === 'POST' ? { body: bytes } : {}), redirect: 'error', signal: operation.controller.signal });
      const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      for (const name of ['content-type', 'mcp-session-id', 'www-authenticate', 'retry-after']) {
        if (response.headers.has(name)) responseHeaders[name] = response.headers.get(name);
      }
      res.writeHead(response.status, responseHeaders);
      if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
    } finally { operation.cleanup(); }
  }

  const server = createServer(async (req, res) => {
    try {
      if (closing) return json(res, 503, { error: 'relay_stopping' });
      const url = new URL(req.url || '/', 'http://relay.invalid');
      if (url.search) return json(res, 404, { error: 'route_not_found' });
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, { relay: 'running' });
      if (url.pathname === '/mcp') {
        if (!authorizedMachine(req)) return json(res, 401, { error: 'machine_auth_required' });
        if (!['GET', 'POST', 'DELETE'].includes(req.method)) return json(res, 405, { error: 'method_not_allowed' });
        return await forwardMcp(req, res, await body(req));
      }
      const prefix = '/relay/voice';
      const route = url.pathname.startsWith(`${prefix}/`) ? voiceRoute(url.pathname.slice(prefix.length), req.method) : null;
      if (!route) return json(res, 404, { error: 'route_not_found' });
      const bytes = await body(req);
      const principal = await verifyRelayRequest({ secret, method: req.method, path: url.pathname, headers: headersFrom(req), body: bytes, now: clock() });
      if (!principal) return json(res, 403, { error: 'relay_auth_required' });
      const nonceError = acceptNonce(principal);
      if (nonceError) return json(res, nonceError, { error: nonceError === 409 ? 'relay_request_replayed' : 'relay_request_limit' });
      await forwardVoice(req, res, url.pathname, route, bytes, principal);
    } catch (error) {
      if (res.headersSent) res.end();
      else json(res, error?.status === 413 ? 413 : 502, { error: error?.status === 413 ? 'request_too_large' : 'voice_upstream_unavailable' });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  async function upgradeEvents(req, socket, head) {
    try {
      const principal = await verifyRelayRequest({ secret, method: 'GET', path: req.url, headers: headersFrom(req), now: clock() });
      const rejected = !principal ? 403 : acceptNonce(principal);
      if (rejected || closing || socket.destroyed) {
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${rejected || 503} Rejected\r\nConnection: close\r\n\r\n`);
        return;
      }
      const caseId = principal.caseId;
      if ((eventConnections.get(caseId) || 0) >= 4) { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); return; }
      eventWebSockets.handleUpgrade(req, socket, head, (ws) => {
        eventConnections.set(caseId, (eventConnections.get(caseId) || 0) + 1);
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), eventLifetimeMs);
        timer.unref?.();
        ws.on('close', () => controller.abort());
        ws.on('error', () => controller.abort());
        ws.on('message', () => ws.close(1008, 'Read-only event stream'));
        const output = {
          get destroyed() { return ws.readyState !== 1; },
          writeHead() {},
          write(frame) { if (ws.readyState !== 1 || ws.bufferedAmount > MAX_BODY_BYTES) return false; ws.send(frame); return true; },
          end() { if (ws.readyState === 1) ws.close(1000, 'Reconnect to authorize'); },
        };
        void (async () => {
          try {
            const response = await fetchImpl(new URL('/api/events', upstream), { headers: { Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
            if (!response.ok) { await response.body?.cancel(); throw new Error('Event source unavailable.'); }
            await streamEvents(response, output, caseId, controller);
          } catch { if (ws.readyState === 1) ws.close(controller.signal.aborted ? 1000 : 1011, 'Event stream ended'); }
          finally {
            clearTimeout(timer); controllers.delete(controller);
            const remaining = (eventConnections.get(caseId) || 1) - 1;
            if (remaining) eventConnections.set(caseId, remaining); else eventConnections.delete(caseId);
          }
        })();
      });
    } catch { if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  }
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/relay/voice/events' && req.method === 'GET') { void upgradeEvents(req, socket, head); return; }
    if (closing || req.url !== '/bridge' || !authorizedMachine(req) || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const headers = { Authorization: `Bearer ${humanMcpToken}`, Connection: 'Upgrade', Upgrade: 'websocket' };
    for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol']) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    const request = httpRequest(new URL('/bridge', upstream), { method: 'GET', headers, timeout: 10000 });
    request.on('upgrade', (response, remote, remoteHead) => {
      request.setTimeout(0);
      sockets.add(remote);
      remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
      socket.on('close', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.on('error', () => remote.destroy());
      let handshake = 'HTTP/1.1 101 Switching Protocols\r\n';
      for (const name of ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol']) {
        if (typeof response.headers[name] === 'string') handshake += `${name}: ${response.headers[name]}\r\n`;
      }
      socket.write(`${handshake}\r\n`);
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote).pipe(socket);
    });
    request.on('response', (response) => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    request.on('error', () => socket.destroy());
    request.on('timeout', () => { request.destroy(); socket.destroy(); });
    socket.on('close', () => request.destroy());
    request.end();
  });

  return { server, async close() {
    closing = true;
    for (const controller of controllers) controller.abort();
    for (const ws of eventWebSockets.clients) ws.terminate();
    eventWebSockets.close();
    for (const socket of sockets) socket.destroy();
    sessionCases.clear(); nonces.clear();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  } };
}
