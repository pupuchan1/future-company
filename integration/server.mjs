import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import OpenAI from 'openai';
import { createHumanGateway } from './human/gateway.mjs';
import { McpEvents } from './events/mcp-events.mjs';
import { BusinessBackend, connectionDiagnostic, retryConnection } from './backend.mjs';
import { LiveConversation, liveConfig } from './live-session.mjs';
import { mcpCall } from './mcp-client.mjs';
import { createCaseState, initialHistory, historyTurns, isVoiceRoute, voiceMap } from './case-state.mjs';
import { requestedInterviewEnd } from './interview.mjs';
import { workRequestDetails } from './fast-work.mjs';
import { WorkerBridge } from './worker-bridge.mjs';
import { loadServerEnvironment } from './environment.mjs';
import { createSlackHumanTransport } from './human/slack.mjs';

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

export function createIntegration({ env = process.env, client, stateDir = resolve(root, '../.integration-state'),
  socketFactory, workerFetch, workerSocketFactory, slackFetch, closeTimeoutMs, handoffTimeoutMs = 30000,
  prewarmTimeoutMs = 60000 } = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const remember = (record) => appendFileSync(join(stateDir, 'resources.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
  const clients = new Set();
  const sessions = new Map();
  const cases = new Map();
  const manualPhoneCases = new Set();
  const emit = (event) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      if (res.destroyed || res.writableEnded) { clients.delete(res); continue; }
      if (!res.write(payload)) { clients.delete(res); res.end(); }
    }
  };
  const events = new McpEvents({ storePath: join(stateDir, 'events.json'),
    allowCallbackHosts: (env.MCP_EVENT_CALLBACK_HOSTS || '').split(',').map((v) => v.trim()).filter(Boolean) });
  const provider = client || (env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 0, timeout: 30000 }) : null);
  const backend = provider ? new BusinessBackend({ client: provider, mcpUrl: env.HUMAN_MCP_URL,
    token: env.HUMAN_MCP_TOKEN, model: env.AGENT_MODEL || 'gpt-6.1-sol', emit, remember }) : null;
  const createLive = (input) => retryConnection(() => provider.live.create(input), {
    onRetry: (diagnostic) => remember({ type: 'provider_retry', operation: 'live.create', ...diagnostic }),
  });
  function receiveHuman(event) {
    const state = cases.get(event.data.case_id);
    if (!state || state.closed || event.isValid?.() === false) return Promise.resolve({ status: 'cancelled' });
    emit({ ...event, type: event.name });
    const active = sessions.get(state.activeSessionId);
    if ((state.switching && !state.switching.prewarm) || !active) return new Promise(resolve => state.pendingHumanEvents.push({ ...event, onProcessed: resolve }));
    return Promise.resolve(active.humanEvent(event));
  }
  const workerBridge = env.WORKER_API_URL ? new WorkerBridge({ url: env.WORKER_API_URL, token: env.STAFF_API_TOKEN,
    accessClientId: env.CF_ACCESS_CLIENT_ID || env.WORKER_ACCESS_CLIENT_ID,
    accessClientSecret: env.CF_ACCESS_CLIENT_SECRET || env.WORKER_ACCESS_CLIENT_SECRET,
    fetcher: workerFetch, socketFactory: workerSocketFactory, deliver: receiveHuman, emit }) : null;
  const slack = createSlackHumanTransport({ botToken: env.SLACK_BOT_TOKEN, userToken: env.SLACK_USER_TOKEN,
    channelId: env.SLACK_CHANNEL_ID, fetcher: slackFetch });
  const gateway = createHumanGateway({ token: env.HUMAN_MCP_TOKEN || '', slack,
    notifyRecruiter: input => slack.notifyRecruiter(input, { isActive: () => Boolean(cases.get(input.case_id)
      && !cases.get(input.case_id).closed && cases.get(input.case_id).routing.route === 'recruiting') }),
    completeInterview: input => {
      const isActive = () => Boolean(cases.get(input.case_id) && !cases.get(input.case_id).closed
        && cases.get(input.case_id).routing.route === 'recruiting');
      const latestCaller = historyTurns(cases.get(input.case_id)?.history || []).filter(turn => turn.role === 'user').at(-1)?.text;
      if (!isActive() || !requestedInterviewEnd(latestCaller)) return { case_id: input.case_id,
        notification_status: 'unavailable', error: 'interview_end_not_requested' };
      return slack.completeInterview(input, { isActive });
    },
    transportForCase: (caseId) => manualPhoneCases.has(caseId) ? 'phone' : cases.get(caseId)?.fastWorkRequest ? 'slack' : cases.get(caseId)?.routing.route === 'haas' ? 'phone' : 'slack',
    caseActive: (caseId) => manualPhoneCases.has(caseId) || Boolean(cases.get(caseId) && !cases.get(caseId).closed),
    handleEventRpc: (rpc) => events.handleRpc(rpc),
    onEvent: (event) => {
      void events.publish(event).catch(() => emit({ type: 'events.error', message: 'MCP event could not be queued.' }));
      const state = cases.get(event.data.case_id);
      if (['human.completed', 'human.cancelled', 'human.unavailable'].includes(event.name)) manualPhoneCases.delete(event.data.case_id);
      if (!state || state.closed) { emit({ ...event, type: event.name }); return; }
      // Capture the request's original specialist before a voice switch changes it.
      if (event.name === 'human.requested' && !state.handoffRoutes.has(event.data.handoff_id)) {
        state.handoffRoutes.set(event.data.handoff_id, state.routing.route);
      }
      if (event.data.request_kind === 'work') {
        // Delivery confirmation must not wait for Worker persistence or an Agent turn.
        void receiveHuman(event);
        if (workerBridge) void workerBridge.humanEvent(event, 'haas').catch(() => emit({ type: 'worker.error', case_id: state.id, message: 'Work request synchronization failed.' }));
        return;
      }
      if (workerBridge) {
        const route = state.handoffRoutes.get(event.data.handoff_id) || state.routing.route;
        void workerBridge.humanEvent(event, route).then(linked => {
          if (state.closed || event.isValid?.() === false) return;
          if (linked && ['human.requested', 'human.ringing', 'human.accepted'].includes(event.name)) {
            const [record] = workerBridge.overlayRequests([event.data]);
            const displayed = { ...event, data: record };
            // A delayed device ACK must display the saved Worker answer without
            // resuming the original Agent a second time.
            if (['completed', 'cancelled', 'unavailable'].includes(record.status)) {
              emit({ ...displayed, type: event.name });
              return;
            }
            return receiveHuman(displayed);
          }
          if (!linked || event.name !== 'human.completed' || !event.data.result) return receiveHuman(event);
        }).catch(() => emit({ type: 'worker.error', case_id: state.id, message: 'Human result was not saved or synchronized; no Agent success is confirmed.' }));
      } else void receiveHuman(event);
    },
    onError: () => emit({ type: 'mcp.error', message: 'MCP transport error.' }),
  });
  function currentHumanRequests() {
    const records = gateway.service.listRequests();
    return workerBridge ? workerBridge.overlayRequests(records) : records;
  }
  function drainHuman(state) {
    const active = sessions.get(state.activeSessionId);
    if (!active || state.closed || (state.switching && !state.switching.prewarm)) return 0;
    const pending = state.pendingHumanEvents.splice(0);
    for (const event of pending) Promise.resolve(active.humanEvent(event)).then(event.onProcessed || (() => {}));
    return pending.filter((event) => ['human.completed', 'human.unavailable', 'human.cancelled'].includes(event.name)).length;
  }
  function abandonHandoff(state, ticket) {
    if (state.switching !== ticket) return;
    clearTimeout(ticket.timer);
    state.switching = null;
    const candidate = sessions.get(ticket.newId);
    if (candidate) void candidate.close({ preserveCase: true });
    drainHuman(state);
    const previous = sessions.get(state.activeSessionId);
    const deferred = [...state.deferredDelegations];
    state.deferredDelegations.clear();
    for (const id of state.handoffBeforeWork ? deferred.slice(0, 1) : deferred) {
      if (!state.closed && previous?.canWork() && (state.handoffBeforeWork || !state.seen.has(id))) {
        state.seen.add(id);
        previous.enqueue(id, state.handoffBeforeWork ? 'handoff_fallback' : 'delegation');
      }
    }
  }
  function observeSession(result, state, { route = state.routing.route, standby = false } = {}) {
    const id = result.session.id;
    remember({ type: 'live', id, case_id: state.id });
    const session = new LiveConversation({ id, caseId: state.id, language: state.routing.language,
      apiKey: env.OPENAI_API_KEY, backend, emit, caseState: state, route, standby,
      socketFactory, closeTimeoutMs,
      cancelWork: () => {
        if (state.fastWorkRequest?.handoff_id) gateway.service.cancelHumanRequest({ handoff_id: state.fastWorkRequest.handoff_id });
      },
      requestWork: text => {
        if (state.fastWorkRequest) return state.fastWorkRequest;
        state.routing.route = 'haas';
        state.fastWorkRequest = { startedAt: Date.now() };
        const request = gateway.service.requestHuman({ ...workRequestDetails(text), case_id: state.id,
          reason: 'human_requested', language: state.routing.language, idempotency_key: `${state.id}:work` });
        Object.assign(state.fastWorkRequest, request);
        return state.fastWorkRequest;
      },
      handoffs: () => currentHumanRequests().filter((record) => record.case_id === state.id),
      onClosing: (closingId, { preserveCase }) => {
        if (!preserveCase) {
          state.closed = true;
          slack.closeCase(state.id);
          gateway.service.closeCase(state.id);
          workerBridge?.closeCase(state.id);
          const ticket = state.switching;
          if (ticket) abandonHandoff(state, ticket);
          for (const event of state.pendingHumanEvents.splice(0)) event.onProcessed?.({ status: 'cancelled' });
        } else if (state.switching?.newId === closingId) {
          abandonHandoff(state, state.switching);
        }
      },
      onClose: (closedId) => {
        sessions.delete(closedId);
        // Hold the case reservation until its old Agents cleanup has completed.
        if (state.closed && state.activeSessionId === closedId && cases.get(state.id) === state) cases.delete(state.id);
      }, remember });
    sessions.set(id, session);
    return session;
  }
  const connectionInfo = (session) => ({ session: { id: session.id }, case_id: session.caseId,
    route: session.voiceRoute, voice: session.voice,
    ...(session.observedVoice ? { observed_voice: session.observedVoice } : {}),
    ...(session.observedModel ? { observed_model: session.observedModel } : {}) });
  let pendingCreates = 0;
  const pendingCaseIds = new Set();
  const server = createServer(async (req, res) => {
    try {
      if (await gateway.handleRequest(req, res)) return;
      if (!isLocalRequest(req)) return json(res, 403, { error: 'This development UI is available on loopback only.' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, {
        live_configured: Boolean(provider), mcp_configured: Boolean(env.HUMAN_MCP_URL),
        recruiting_human_transport: 'slack', slack_configured: slack.configured, slack_replies_configured: slack.repliesConfigured,
        devices: gateway.service.listDevices(), requests: currentHumanRequests(),
        decisions_enabled: env.LIVE_DECISIONS_ENABLED !== 'false',
        handoff_configured: true, prewarm_configured: true, voice_map: voiceMap,
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
        if (cases.has(caseId) && cases.get(caseId).routing.route !== 'haas') return json(res, 409, { error: 'Recruiting consultations use Slack.' });
        if (!cases.has(caseId)) {
          if (manualPhoneCases.size >= 100) return json(res, 429, { error: 'Manual phone request capacity reached.' });
          manualPhoneCases.add(caseId);
        }
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
        if (input.route !== undefined && !isVoiceRoute(input.route)) return json(res, 400, { error: 'Unknown voice department.', code: 'invalid_route' });
        const route = input.route || 'reception';
        if (input.language_preference !== undefined && !['auto', 'ja', 'en'].includes(input.language_preference)) return json(res, 400, { error: 'Invalid language preference.' });
        if (input.handoff_before_work !== undefined && typeof input.handoff_before_work !== 'boolean') return json(res, 400, { error: 'Invalid voice handoff capability.' });
        const languagePreference = input.language_preference || 'auto';
        const language = languagePreference === 'auto' ? (input.language === 'en' ? 'en' : 'ja') : languagePreference;
        const caseId = identifier(input.case_id) ? input.case_id : `case-${randomUUID()}`;
        if (cases.size + pendingCreates >= 3) return json(res, 429, { error: 'Close an existing session first.' });
        if (pendingCaseIds.has(caseId) || cases.has(caseId)) return json(res, 409, { error: 'This case already has a voice session.' });
        pendingCaseIds.add(caseId);
        pendingCreates++;
        try {
          if (workerBridge) await workerBridge.attachCase(caseId, input.bridge_token);
          const result = await createLive({ session: liveConfig({ model: env.LIVE_MODEL || 'gpt-live-1',
            voice: voiceMap[route], route, language, languagePreference, decisions: env.LIVE_DECISIONS_ENABLED !== 'false' }),
            transport: { type: 'webrtc', sdp: input.sdp } });
          const state = createCaseState(caseId, language, route);
          state.languagePreference = languagePreference;
          state.handoffBeforeWork = input.handoff_before_work === true;
          state.activeSessionId = result.session.id;
          cases.set(caseId, state);
          const session = observeSession(result, state);
          try { await session.ready; } catch (error) { await session.close(); throw error; }
          if (res.destroyed) { await session.close(); return; }
          return json(res, 200, { ...connectionInfo(session), transport: result.transport });
        } catch (error) { workerBridge?.closeCase(caseId); throw error; }
        finally { pendingCreates--; pendingCaseIds.delete(caseId); }
      }
      if (req.method === 'POST' && path === '/api/worker/results') {
        if (!workerBridge) return json(res, 503, { error: 'Worker bridge is not configured.' });
        const input = await body(req);
        if (!identifier(input.case_id)) return json(res, 400, { error: 'A valid case_id is required.' });
        return json(res, 202, await workerBridge.syncCase(input.case_id, input.bridge_token));
      }
      const languageMatch = path.match(/^\/api\/live\/session\/([^/]+)\/language$/);
      if (req.method === 'POST' && languageMatch) {
        const current = sessions.get(decodeURIComponent(languageMatch[1]));
        if (!current) return json(res, 404, { error: 'Voice session not found.', code: 'session_not_found' });
        const input = await body(req);
        if (input.case_id !== current.caseId) return json(res, 403, { error: 'Case does not own this voice session.', code: 'case_mismatch' });
        if (!['ja', 'en'].includes(input.language) || !['auto', 'ja', 'en'].includes(input.language_preference)
          || (input.language_preference !== 'auto' && input.language_preference !== input.language)) return json(res, 400, { error: 'Invalid language selection.' });
        const state = current.caseState;
        if (state.closed || current.closed || current.closing || state.activeSessionId !== current.id) return json(res, 409, { error: 'Voice session is inactive.', code: 'inactive_session' });
        if (state.switching) return json(res, 409, { error: 'Wait until the handoff finishes.', code: 'handoff_in_progress' });
        if (current.ws.readyState !== 1) return json(res, 503, { error: 'Voice connection is unavailable.' });
        current.setLanguage(input.language, input.language_preference);
        return json(res, 200, { ...connectionInfo(current), language: current.routing.language, language_preference: state.languagePreference });
      }
      const handoffMatch = path.match(/^\/api\/live\/session\/([^/]+)\/handoff$/);
      if (req.method === 'POST' && handoffMatch) {
        const current = sessions.get(decodeURIComponent(handoffMatch[1]));
        if (!current) return json(res, 404, { error: 'Voice session not found.', code: 'session_not_found' });
        const input = await body(req);
        if (typeof input.sdp !== 'string' || !input.sdp.startsWith('v=0')) return json(res, 400, { error: 'A WebRTC SDP offer is required.' });
        if (!isVoiceRoute(input.route)) return json(res, 400, { error: 'Unknown voice department.', code: 'invalid_route' });
        if (input.automatic !== undefined && typeof input.automatic !== 'boolean') return json(res, 400, { error: 'Invalid handoff mode.' });
        if ((input.prewarm !== undefined && typeof input.prewarm !== 'boolean') || (input.prewarm && input.automatic !== true)) {
          return json(res, 400, { error: 'Prewarming requires automatic handoff.', code: 'invalid_prewarm' });
        }
        const state = current.caseState;
        if (state.closed || current.closed || current.closing || state.activeSessionId !== current.id) {
          return json(res, 409, { error: 'This is no longer the active voice session.', code: 'inactive_session' });
        }
        if (state.switching || (!input.prewarm && current.busy)) return json(res, 409, {
          error: 'Wait until the current work or handoff finishes.', code: state.switching ? 'handoff_in_progress' : 'busy' });
        if (input.automatic && input.route !== state.routing.route) return json(res, 409, {
          error: 'The confirmed department changed.', code: 'routing_changed' });
        const ticket = { token: randomUUID(), oldId: current.id, newId: null, route: input.route,
          automatic: input.automatic === true, prewarm: input.prewarm === true, ready: false,
          historyEvents: new Set(state.history) };
        state.switching = ticket;
        const lifetime = ticket.prewarm ? Math.min(60000, Math.max(1, prewarmTimeoutMs)) : handoffTimeoutMs;
        ticket.expiresAt = Date.now() + lifetime;
        ticket.timer = setTimeout(() => abandonHandoff(state, ticket), lifetime);
        ticket.timer.unref?.();
        try {
          const result = await createLive({ session: liveConfig({ model: env.LIVE_MODEL || 'gpt-live-1',
            voice: voiceMap[input.route], route: input.route, language: state.routing.language, languagePreference: state.languagePreference || 'auto',
            input: initialHistory(state.history), standby: true, decisions: env.LIVE_DECISIONS_ENABLED !== 'false' }),
            transport: { type: 'webrtc', sdp: input.sdp } });
          ticket.newId = result.session.id;
          const candidate = observeSession(result, state, { route: input.route, standby: true });
          try { await candidate.ready; } catch (error) { await candidate.close({ preserveCase: true }); throw error; }
          if (state.closed || state.switching !== ticket || candidate.closed || candidate.closing || res.destroyed) {
            await candidate.close({ preserveCase: true });
            if (!res.destroyed) return json(res, 409, { error: 'The handoff expired or the original call closed.', code: 'handoff_expired' });
            return;
          }
          ticket.ready = true;
          return json(res, 200, { ...connectionInfo(candidate), transport: result.transport,
            old_session_id: ticket.oldId, handoff_token: ticket.token,
            ...(ticket.prewarm ? { prewarm: true, expires_at: new Date(ticket.expiresAt).toISOString() } : {}) });
        } catch (error) {
          abandonHandoff(state, ticket);
          throw error;
        }
      }
      const activateMatch = path.match(/^\/api\/live\/session\/([^/]+)\/activate$/);
      if (req.method === 'POST' && activateMatch) {
        const candidate = sessions.get(decodeURIComponent(activateMatch[1]));
        if (!candidate) return json(res, 404, { error: 'Voice session not found.', code: 'session_not_found' });
        const input = await body(req);
        const state = candidate.caseState;
        if (candidate.activation && candidate.activation.token === input.handoff_token && !state.closed && state.activeSessionId === candidate.id) {
          return json(res, 200, candidate.activation.response);
        }
        const ticket = state.switching;
        if (!ticket || ticket.newId !== candidate.id || ticket.token !== input.handoff_token) {
          return json(res, 409, { error: 'No matching pending handoff.', code: 'invalid_handoff' });
        }
        const previous = sessions.get(ticket.oldId);
        if (!ticket.ready || candidate.closed || candidate.closing || state.closed || !previous || previous.closed || previous.closing) {
          abandonHandoff(state, ticket);
          return json(res, 409, { error: 'The handoff is not ready or the original call closed.', code: 'handoff_expired' });
        }
        if (ticket.prewarm && ticket.route !== state.routing.route) {
          abandonHandoff(state, ticket);
          return json(res, 409, { error: 'The confirmed department changed.', code: 'routing_changed' });
        }
        if (ticket.prewarm && previous.busy) return json(res, 409, {
          error: 'Wait until the current work finishes before activating.', code: 'busy' });
        if (ticket.prewarm && !candidate.catchUpHistory(state.history.filter(event => !ticket.historyEvents.has(event)))) {
          abandonHandoff(state, ticket);
          return json(res, 409, { error: 'The prepared voice connection is unavailable.', code: 'handoff_expired' });
        }
        // No await between validation and commit: every human event has one owner.
        clearTimeout(ticket.timer);
        state.activeSessionId = candidate.id;
        state.switching = null;
        const continueWork = state.handoffBeforeWork && state.deferredDelegations.size > 0;
        state.deferredDelegations.clear();
        candidate.updateRouting({ route: ticket.route, language: state.routing.language }, 'voice_handoff');
        const response = { ...connectionInfo(candidate), old_session_id: ticket.oldId, active: true };
        candidate.activation = { token: ticket.token, response };
        const resumedHuman = drainHuman(state);
        candidate.activateDepartment({ announce: !ticket.automatic && resumedHuman === 0, automatic: ticket.automatic,
          announceVoice: resumedHuman === 0 });
        if (continueWork) void candidate.enqueue(null, 'handoff_continuation');
        emit({ type: 'live.handoff', ...response, session_id: candidate.id });
        void previous.close({ preserveCase: true });
        return json(res, 200, response);
      }
      if (req.method === 'DELETE' && path.startsWith('/api/live/session/')) {
        const id = decodeURIComponent(path.slice('/api/live/session/'.length));
        const session = sessions.get(id);
        const cleanupPending = await session?.close() || [];
        return json(res, 200, { closed: true, live_finalized: session?.finalized ?? null, cleanup_pending: cleanupPending });
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
      const diagnostic = connectionDiagnostic(error);
      const connectionError = diagnostic.connection_error;
      if (error.status) {
        const diagnostic = { at: new Date().toISOString(), status: error.status, code: error.code,
          param: error.param, message: String(error.message || '').replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 300) };
        appendFileSync(join(stateDir, 'errors.jsonl'), JSON.stringify(diagnostic) + '\n', { mode: 0o600 });
      } else {
        // Record only allowlisted metadata: exception messages may contain input or credentials.
        appendFileSync(join(stateDir, 'errors.jsonl'), JSON.stringify({ at: new Date().toISOString(),
          ...diagnostic }) + '\n', { mode: 0o600 });
      }
      if (!res.headersSent) json(res, error.status === 403 ? 403 : connectionError || error.status && error.status >= 400 ? 502 : 400,
        { error: connectionError ? 'Provider connection failed. Please retry.'
          : error.status ? `Provider HTTP ${error.status}` : 'Request failed. Check server configuration and input.' });
      else res.end();
    }
  });
  server.on('upgrade', (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  return { server, gateway, backend, events, slack, async close() {
    slack.close();
    workerBridge?.close();
    for (const res of clients) res.end();
    clients.clear();
    await Promise.allSettled([...sessions.values()].map((session) => session.close()));
    await backend?.close(); await gateway.close(); await events.close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadServerEnvironment(new URL('../', import.meta.url));
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
