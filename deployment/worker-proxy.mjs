import { CASE_PATTERN, readBoundedBody, requireRelaySecret, signRelayRequest, voiceRoute } from './protocol.mjs';

const encoder = new TextEncoder();
function json(status, code) {
  return Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/**
 * authorizeCase must check the existing visitor cookie against the Worker case.
 * @param {{ authorizeCase: (request: Request, env: any, caseId: string) => Promise<unknown>, fetchImpl?: typeof fetch, clock?: () => number, allowLoopbackTarget?: boolean }} options
 */
export function createProductionVoiceProxy({ authorizeCase, fetchImpl = fetch, clock = Date.now, allowLoopbackTarget = false } = {}) {
  if (typeof authorizeCase !== 'function') throw new Error('A case authorization function is required.');
  return async function handleVoice(request, env) {
    const url = new URL(request.url);
    const match = /^\/api\/v1\/cases\/([^/]+)\/voice(\/.*)?$/.exec(url.pathname);
    if (!match) return undefined;
    const caseId = match[1];
    const suffix = match[2] || '';
    const route = voiceRoute(suffix, request.method);
    if (!CASE_PATTERN.test(caseId) || !route || url.search) return json(404, 'voice_route_not_found');
    const origin = request.headers.get('Origin');
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site'
      || (origin && origin !== url.origin)
      || (request.method !== 'GET' && origin !== url.origin)) return json(403, 'same_origin_required');

    // Authorize on every request, including EventSource reconnects. No new browser credential.
    try { await authorizeCase(request, env, caseId); }
    catch (error) { return json([401, 403, 404].includes(error?.status) ? error.status : 503, 'case_access_denied'); }
    let target;
    try {
      requireRelaySecret(env.NODE_RELAY_SECRET);
      target = new URL(env.NODE_RELAY_ORIGIN);
      const local = allowLoopbackTarget && target.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(target.hostname);
      if ((!local && target.protocol !== 'https:') || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error();
    } catch { return json(503, 'voice_relay_unconfigured'); }

    let body;
    try {
      body = await readBoundedBody(request.body);
      if (request.method === 'POST') {
        if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json(415, 'json_required');
        const input = JSON.parse(new TextDecoder().decode(body));
        if (!input || Array.isArray(input) || typeof input !== 'object') return json(400, 'invalid_json');
        if (input.case_id !== undefined && input.case_id !== caseId) return json(403, 'case_mismatch');
        // Preserve #19's bridge_token, case_proof and other integration fields.
        body = encoder.encode(JSON.stringify({ ...input, case_id: caseId }));
      } else if (body.byteLength) return json(400, 'unexpected_body');
    } catch (error) { return json(error?.status === 413 ? 413 : 400, 'invalid_request_body'); }

    target.pathname = `/relay/voice${suffix}`;
    const headers = new Headers(await signRelayRequest({ secret: env.NODE_RELAY_SECRET, method: request.method, path: target.pathname, caseId, body, now: clock() }));
    headers.set('Accept', route.kind === 'events' ? 'text/event-stream' : 'application/json');
    if (request.method === 'POST') headers.set('Content-Type', 'application/json');
    const websocketEvents = route.kind === 'events' && env.NODE_RELAY_EVENTS_TRANSPORT !== 'sse';
    if (websocketEvents) headers.set('Upgrade', 'websocket');
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, route.kind === 'events' ? 75000 : 45000);
    const cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', abort); };
    try {
      const response = await fetchImpl(target, { method: request.method, headers,
        ...(request.method === 'POST' ? { body } : {}), redirect: 'manual', signal: controller.signal });
      // Workers accepts manual/follow redirect modes. Never follow a relay redirect
      // with its HMAC headers; reject it explicitly rather than using Node-only 'error'.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error('Unexpected relay redirect.');
      }
      if (websocketEvents) {
        // The public browser endpoint stays SSE; WebSocket backhaul also works on Quick Tunnels.
        const socket = response.webSocket;
        if (response.status !== 101 || !socket) throw new Error('Event tunnel unavailable.');
        let finished = false;
        let end;
        const stream = new ReadableStream({
          start(output) {
            end = (error, cancelled = false) => {
              if (finished) return;
              finished = true; cleanup();
              controller.signal.removeEventListener('abort', abortStream);
              try { socket.close(1000, 'Event subscription closed'); } catch { /* Already closed. */ }
              if (!cancelled) { if (error) output.error(error); else output.close(); }
            };
            const abortStream = () => end();
            controller.signal.addEventListener('abort', abortStream, { once: true });
            socket.addEventListener('message', (event) => {
              if (finished) return;
              if (typeof event.data !== 'string' || encoder.encode(event.data).byteLength > 256 * 1024) return end(new Error('Invalid event frame.'));
              // Bound a browser that stops reading instead of buffering transcript data indefinitely.
              if (output.desiredSize !== null && output.desiredSize < -16) return end(new Error('Event reader too slow.'));
              output.enqueue(encoder.encode(event.data));
            });
            socket.addEventListener('close', () => end());
            socket.addEventListener('error', () => end(new Error('Event tunnel disconnected.')));
            socket.accept();
            if (controller.signal.aborted) end();
          },
          cancel() { end?.(undefined, true); controller.abort(); },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      const responseHeaders = new Headers({ 'Content-Type': response.headers.get('Content-Type') || 'application/json',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (route.kind === 'events' && response.ok && response.body) {
        // Keep abort/deadline active while streaming; closing causes EventSource to reauthorize.
        const reader = response.body.getReader();
        const stream = new ReadableStream({
          async pull(output) {
            try {
              const { done, value } = await reader.read();
              if (done) { cleanup(); output.close(); } else output.enqueue(value);
            } catch (error) { cleanup(); output.error(error); }
          },
          async cancel(reason) { controller.abort(); cleanup(); await reader.cancel(reason).catch(() => {}); },
        });
        return new Response(stream, { status: response.status, headers: responseHeaders });
      }
      const responseBody = await readBoundedBody(response.body);
      cleanup();
      return new Response(responseBody, { status: response.status, headers: responseHeaders });
    } catch (error) {
      cleanup();
      // Never log URLs, headers, bodies or error messages: they may contain credentials.
      const safeTag = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : 'unknown';
      console.error('voice_relay_failure', { name: safeTag(error?.name), code: safeTag(error?.code || error?.cause?.code) });
      return json(502, 'voice_relay_unavailable');
    }
  };
}
