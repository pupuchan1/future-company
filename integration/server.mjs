import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import OpenAI from 'openai';
import { createHumanGateway } from './human/gateway.mjs';
import { McpEvents } from './events/mcp-events.mjs';
import { BusinessBackend } from './backend.mjs';
import { LiveConversation, liveConfig } from './live-session.mjs';
import { mcpCall } from './mcp-client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export function isLocalRequest(req) {
  let hostname;
  try { hostname = new URL(`http://${req.headers.host}`).hostname; } catch { return false; }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  if (req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

export function createIntegration({ env = process.env, client, stateDir = resolve(root, '../.integration-state') } = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const remember = (record) => appendFileSync(join(stateDir, 'resources.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  const clients = new Set();
  const sessions = new Map();
  const emit = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      if (!res.write(payload)) { clients.delete(res); res.end(); }
    }
  };
  const events = new McpEvents({ storePath: join(stateDir, 'events.json'),
    allowCallbackHosts: (env.MCP_EVENT_CALLBACK_HOSTS || '').split(',').map((v) => v.trim()).filter(Boolean) });
  const provider = client || (env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 30000 }) : null);
  const backend = provider ? new BusinessBackend({ client: provider, mcpUrl: env.HUMAN_MCP_URL,
    token: env.HUMAN_MCP_TOKEN, model: env.AGENT_MODEL || 'gpt-6.1-sol', emit, remember }) : null;
  const gateway = createHumanGateway({ token: env.HUMAN_MCP_TOKEN || '',
    handleEventRpc: (rpc) => events.handleRpc(rpc),
    onEvent: (event) => {
      emit({ ...event, type: event.name });
      void events.publish(event).catch(() => emit({ type: 'events.error', message: 'MCP event could not be queued.' }));
      for (const session of sessions.values()) session.humanEvent(event);
    },
    onError: () => emit({ type: 'mcp.error', message: 'MCP transport error.' }),
  });
  let pendingCreates = 0;
  const pendingCaseIds = new Set();
  const server = createServer(async (req, res) => {
    try {
      if (await gateway.handleRequest(req, res)) return;
      if (!isLocalRequest(req)) return json(res, 403, { error: 'This development UI is available on loopback only.' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, {
        live_configured: Boolean(provider), mcp_configured: Boolean(env.HUMAN_MCP_URL),
        devices: gateway.service.listDevices(), requests: gateway.service.listRequests(),
        decisions_enabled: env.LIVE_DECISIONS_ENABLED !== 'false',
      });
      if (req.method === 'GET' && path === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': connected\n\n'); clients.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        req.on('close', () => { clients.delete(res); clearInterval(heartbeat); });
        return;
      }
      if (req.method === 'POST' && path === '/api/demo/handoff') {
        const input = await body(req);
        const caseId = identifier(input.case_id) ? input.case_id : `demo-${randomUUID()}`;
        const record = await mcpCall(`http://127.0.0.1:${server.address().port}/mcp`, env.HUMAN_MCP_TOKEN,
          'request_human', { case_id: caseId, reason: input.reason || 'human_requested',
            summary: input.summary || '接続確認用の人間呼出し', language: input.language || 'ja',
            idempotency_key: `${caseId}:manual`, device_id: 'black-phone-1' });
        return json(res, 200, record);
      }
      if (req.method === 'POST' && path === '/api/live/session') {
        if (!provider || !backend?.mcpUrl) return json(res, 503, { error: 'Server-side API key and HUMAN_MCP_URL are required.' });
        const input = await body(req);
        if (typeof input.sdp !== 'string' || !input.sdp.startsWith('v=0')) return json(res, 400, { error: 'A WebRTC SDP offer is required.' });
        const language = input.language === 'en' ? 'en' : 'ja';
        const caseId = identifier(input.case_id) ? input.case_id : `case-${randomUUID()}`;
        if (sessions.size + pendingCreates >= 3) return json(res, 429, { error: 'Close an existing session first.' });
        if (pendingCaseIds.has(caseId) || [...sessions.values()].some((s) => s.caseId === caseId)) return json(res, 409, { error: 'This case already has a voice session.' });
        pendingCaseIds.add(caseId);
        pendingCreates++;
        try {
          const result = await provider.live.create({ session: liveConfig({ model: env.LIVE_MODEL || 'gpt-live-1',
            voice: env.LIVE_VOICE || 'shida', language, decisions: env.LIVE_DECISIONS_ENABLED !== 'false' }),
            transport: { type: 'webrtc', sdp: input.sdp } });
          remember({ type: 'live', id: result.session.id, case_id: caseId });
          const session = new LiveConversation({ id: result.session.id, caseId, language, apiKey: env.OPENAI_API_KEY,
            backend, emit, handoffs: () => gateway.service.listRequests().filter((r) => r.case_id === caseId),
            onClose: (id) => sessions.delete(id), remember });
          sessions.set(result.session.id, session);
          try { await session.ready; } catch (error) { await session.close(); throw error; }
          if (res.destroyed) { await session.close(); return; }
          return json(res, 200, { session: { id: result.session.id }, transport: result.transport, case_id: caseId });
        } finally { pendingCreates--; pendingCaseIds.delete(caseId); }
      }
      if (req.method === 'DELETE' && path.startsWith('/api/live/session/')) {
        const id = decodeURIComponent(path.slice('/api/live/session/'.length));
        const session = sessions.get(id);
        const cleanupPending = await session?.close() || [];
        return json(res, 200, { closed: true, cleanup_pending: cleanupPending });
      }
      if (req.method === 'GET' && ['/', '/index.html', '/app.js', '/style.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const mime = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
        res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; media-src 'self' blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'" });
        return res.end(readFileSync(join(root, 'public', file)));
      }
      return json(res, 404, { error: 'Not found.' });
    } catch (error) {
      if (!res.headersSent) json(res, error.status && error.status >= 400 ? 502 : 400,
        { error: error.status ? `Provider HTTP ${error.status}` : 'Request failed. Check server configuration and input.' });
      else res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  return { server, gateway, backend, events, async close() {
    for (const res of clients) res.end();
    await Promise.allSettled([...sessions.values()].map((session) => session.close()));
    await backend?.close(); await gateway.close(); await events.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createIntegration();
  app.server.listen(Number(process.env.INTEGRATION_PORT || 4320), process.env.INTEGRATION_HOST || '127.0.0.1', () => {
    console.log(`Integration ready: http://127.0.0.1:${app.server.address().port}`);
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return; closing = true;
    void app.close().finally(() => { process.exitCode = 0; });
  });
}
