// Public Sites entrypoint: forward only visitor APIs to the existing Worker.
// The visitor cookie still owns each case; Access credentials never reach the browser.
export const WORKER_ORIGIN = 'https://future-company-demo.r74.workers.dev';
const CASE = '[A-Za-z0-9_-]{1,100}';
const SESSION = '[A-Za-z0-9_-]{1,200}';
const routes = [
  ['GET', /^\/api\/v1\/company$/],
  ['POST', /^\/api\/v1\/cases$/],
  ['GET', new RegExp(`^/api/v1/cases/${CASE}$`)],
  ['POST', new RegExp(`^/api/v1/cases/${CASE}/bridge-token$`)],
  ['GET', new RegExp(`^/api/v1/cases/${CASE}/voice/(status|events)$`)],
  ['POST', new RegExp(`^/api/v1/cases/${CASE}/voice/(session|results)$`)],
  ['POST', new RegExp(`^/api/v1/cases/${CASE}/voice/session/${SESSION}/(handoff|activate|language)$`)],
  ['DELETE', new RegExp(`^/api/v1/cases/${CASE}/voice/session/${SESSION}$`)],
];
const MAX_BODY = 512 * 1024;
const error = (status, code) => Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } });

async function boundedBody(request) {
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new RangeError();
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) { await reader.cancel(); throw new RangeError(); }
    chunks.push(value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const part of chunks) { body.set(part, offset); offset += part.byteLength; }
  return body;
}

export async function proxyVisitorApi(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  if (url.search || !routes.some(([method, path]) => method === request.method && path.test(url.pathname))) return error(404, 'route_not_found');
  const origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== url.origin)
    || (!['GET', 'HEAD'].includes(request.method) && origin !== url.origin)) return error(403, 'same_origin_required');
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return error(503, 'worker_access_unconfigured');
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'last-event-id']) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  const cookies = (request.headers.get('cookie') || '').split(';').map(value => value.trim())
    .filter(value => /^future_company_visitor=[a-f0-9]{64}$/.test(value));
  if (cookies.length > 1) return error(400, 'ambiguous_visitor_cookie');
  if (cookies.length) headers.set('Cookie', cookies[0]);
  headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID);
  headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET);
  if (origin) headers.set('Origin', WORKER_ORIGIN);
  try {
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await boundedBody(request);
    const upstream = await fetcher(`${WORKER_ORIGIN}${url.pathname}`, {
      method: request.method, headers, body, redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(url.pathname.endsWith('/events') ? 65000 : 45000)]),
    });
    if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return error(502, 'worker_access_redirect'); }
    const type = upstream.headers.get('content-type') || '';
    if (type.includes('text/html')) { await upstream.body?.cancel(); return error(502, 'worker_access_rejected'); }
    const output = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['content-type', 'retry-after']) {
      const value = upstream.headers.get(name); if (value) output.set(name, value);
    }
    const setCookies = upstream.headers.getSetCookie?.() || [upstream.headers.get('set-cookie') || ''];
    for (const cookie of setCookies) if (/^future_company_visitor=[a-f0-9]{64};/i.test(cookie)) {
      // Re-issue only the existing visitor capability for this Site's origin.
      const value = cookie.split(';')[0];
      output.append('Set-Cookie', `${value}; Path=/api/v1; HttpOnly; Secure; SameSite=Strict`);
    }
    return new Response(upstream.body, { status: upstream.status, headers: output });
  } catch (cause) {
    return error(cause instanceof RangeError ? 413 : 502, cause instanceof RangeError ? 'request_too_large' : 'worker_unavailable');
  }
}
