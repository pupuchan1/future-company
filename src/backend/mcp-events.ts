import type { CaseKind } from './contracts'

export type McpPrincipal = { id: string; departments: CaseKind[] }
export type McpEventName = 'case.created' | 'human_request.created' | 'case.resolved'
export type McpEventData = { caseId: string; department: CaseKind; status: string; revision: number }
export type McpEvent = { eventId: string; name: McpEventName; timestamp: string; data: McpEventData }
export type McpDependencies = {
  authorizeMcpPrincipal?: (request: Request) => Promise<McpPrincipal | null>
  readCase?: (principal: McpPrincipal, caseId: string) => Promise<unknown | null>
  authorizeMcpDelivery?: (principalId: string, data: McpEventData) => Promise<boolean>
  // Raw fetch cannot prevent DNS rebinding; inject a transport that validates and pins destination IPs.
  verifiedCallbackTransport?: (url: string, init: RequestInit) => Promise<Response>
  now?: () => Date
}

interface Statement {
  bind(...values: (string | number | null)[]): Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}
export interface McpDatabase {
  prepare(sql: string): Statement
  batch(statements: Statement[]): Promise<unknown>
}
type Filters = { department?: CaseKind; caseId?: string }
type Subscription = {
  id: string; principal_id: string; event_name: string; arguments_json: string
  callback_url: string; signing_secret: string; previous_secret: string | null
  rotate_until: string | null; expires_at: string; active: number; verified_at: string
}
const PROTOCOL_VERSION = '2026-07-28'
const MAX_ATTEMPTS = 3
const eventNames: McpEventName[] = ['case.created', 'human_request.created', 'case.resolved']
const encoder = new TextEncoder()

class RpcError extends Error {
  constructor(public code: number, message: string, public reason?: string) { super(message) }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32602, 'An object is required.')
  return value as Record<string, unknown>
}
function string(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new RpcError(-32602, 'Invalid string parameter.')
  return value
}
function isDepartment(value: unknown): value is CaseKind { return value === 'support' || value === 'sales' || value === 'recruitment' }
function eventName(value: unknown): McpEventName {
  if (value !== 'case.created' && value !== 'human_request.created' && value !== 'case.resolved') throw new RpcError(-32602, 'Unknown event name.')
  return value
}
function filters(value: unknown): Filters {
  const input = record(value ?? {})
  if (Object.keys(input).some((key) => key !== 'department' && key !== 'caseId')) throw new RpcError(-32602, 'Unknown subscription filter.')
  const parsed: Filters = {}
  if (input.department !== undefined) {
    if (!isDepartment(input.department)) throw new RpcError(-32602, 'Unknown department.')
    parsed.department = input.department
  }
  if (input.caseId !== undefined) {
    parsed.caseId = string(input.caseId)
    if (!/^[a-zA-Z0-9_-]+$/.test(parsed.caseId)) throw new RpcError(-32602, 'Invalid case ID.')
  }
  return parsed
}
function callbackUrl(value: unknown): string {
  let url: URL
  try { url = new URL(string(value, 2048)) } catch { throw new RpcError(-32602, 'Invalid callback URL.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    throw new RpcError(-32602, 'A public HTTPS callback URL is required.')
  }
  return url.href
}
function decodeSecret(value: unknown): Uint8Array<ArrayBuffer> {
  const secret = string(value, 200)
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new RpcError(-32602, 'Invalid signing secret.')
  let decoded: string
  try { decoded = atob(secret.slice(6)) } catch { throw new RpcError(-32602, 'Invalid signing secret.') }
  if (decoded.length < 24 || decoded.length > 64) throw new RpcError(-32602, 'Invalid signing secret length.')
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0))
}
function base64(bytes: ArrayBuffer): string { return btoa(String.fromCharCode(...new Uint8Array(bytes))) }
async function sign(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', decodeSecret(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return `v1,${base64(await crypto.subtle.sign('HMAC', key, encoder.encode(`${id}.${timestamp}.${body}`)))}`
}
function constantEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length
  for (let i = 0; i < Math.max(left.length, right.length); i++) difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0)
  return difference === 0
}
async function subscriptionId(principal: string, name: string, args: Filters, url: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([principal, url, name, args])))
  return `sub_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
function now(dependencies: McpDependencies): Date { return dependencies.now?.() ?? new Date() }

async function limitedText(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.byteLength
      if (length > limit) {
        await reader.cancel()
        throw new RpcError(-32600, 'Request is too large.')
      }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

async function signedPost(subscription: Pick<Subscription, 'id' | 'callback_url' | 'signing_secret' | 'previous_secret' | 'rotate_until'>, id: string, body: string, dependencies: McpDependencies): Promise<Response> {
  const transport = dependencies.verifiedCallbackTransport
  if (!transport) throw new RpcError(-32015, 'Safe callback transport is not configured.', 'transport_unavailable')
  const time = now(dependencies)
  const timestamp = String(Math.floor(time.getTime() / 1000))
  let signature = await sign(subscription.signing_secret, id, timestamp, body)
  if (subscription.previous_secret && subscription.rotate_until && subscription.rotate_until > time.toISOString()) signature += ` ${await sign(subscription.previous_secret, id, timestamp, body)}`
  return transport(subscription.callback_url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), body,
    headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': signature, 'X-MCP-Subscription-Id': subscription.id },
  })
}

async function subscribe(db: McpDatabase, principal: McpPrincipal, params: Record<string, unknown>, dependencies: McpDependencies): Promise<Record<string, unknown>> {
  const name = eventName(params.name)
  const args = filters(params.arguments)
  if (principal.departments.length === 0 || (args.department && !principal.departments.includes(args.department))) throw new RpcError(-32024, 'Forbidden.')
  if (args.caseId && !(await dependencies.readCase?.(principal, args.caseId))) throw new RpcError(-32024, 'Forbidden.')
  if (params.cursor != null) throw new RpcError(-32602, 'These events do not support replay cursors.')
  const delivery = record(params.delivery)
  if (delivery.mode !== 'webhook') throw new RpcError(-32602, 'Only webhook delivery is supported.')
  const url = callbackUrl(delivery.url)
  const secret = string(delivery.secret, 200)
  decodeSecret(secret)
  if (!dependencies.verifiedCallbackTransport || !dependencies.authorizeMcpDelivery) throw new RpcError(-32015, 'Webhook delivery is not configured.', 'transport_unavailable')
  const requestedTtl = params.ttlMs === undefined || params.ttlMs === null ? 3_600_000 : params.ttlMs
  if (typeof requestedTtl !== 'number' || !Number.isSafeInteger(requestedTtl) || requestedTtl < 1000) throw new RpcError(-32602, 'ttlMs must be a positive integer of at least 1000.')
  const time = now(dependencies)
  const expiresAt = new Date(time.getTime() + Math.min(requestedTtl, 3_600_000)).toISOString()
  const id = await subscriptionId(principal.id, name, args, url)
  const existing = await db.prepare('SELECT * FROM mcp_subscriptions WHERE id=?').bind(id).first<Subscription>()
  const cachedVerification = existing?.active === 1 && existing.signing_secret === secret && existing.expires_at > time.toISOString() && Date.parse(existing.verified_at) + 300_000 > time.getTime()
  if (!cachedVerification) {
    const challenge = crypto.randomUUID()
    try {
      const response = await signedPost({ id, callback_url: url, signing_secret: secret, previous_secret: null, rotate_until: null }, `msg_verification_${crypto.randomUUID()}`, JSON.stringify({ type: 'verification', challenge }), dependencies)
      if (!response.ok) throw new RpcError(-32015, 'Callback verification failed.', 'challenge_failed')
      const raw = await limitedText(response.body, 4096)
      const echoed = record(JSON.parse(raw)).challenge
      if (typeof echoed !== 'string' || !constantEqual(echoed, challenge)) throw new RpcError(-32015, 'Callback verification failed.', 'challenge_failed')
    } catch (error) {
      if (error instanceof RpcError && error.code === -32015) throw error
      throw new RpcError(-32015, 'Callback verification failed.', 'connection_failed')
    }
  }
  const rotated = existing?.active === 1 && existing.signing_secret !== secret
  await db.prepare(`INSERT INTO mcp_subscriptions(id,principal_id,event_name,arguments_json,department,case_id,callback_url,signing_secret,previous_secret,rotate_until,expires_at,active,verified_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET signing_secret=excluded.signing_secret,previous_secret=excluded.previous_secret,rotate_until=excluded.rotate_until,expires_at=excluded.expires_at,active=1,verified_at=excluded.verified_at`)
    .bind(id, principal.id, name, JSON.stringify(args), args.department ?? null, args.caseId ?? null, url, secret,
      rotated ? existing.signing_secret : existing?.previous_secret ?? null,
      rotated ? new Date(time.getTime() + 120_000).toISOString() : existing?.rotate_until ?? null,
      expiresAt, cachedVerification ? existing.verified_at : time.toISOString()).run()
  return { id, refreshBefore: expiresAt, cursor: null, truncated: false }
}

const filterSchema = { type: 'object', properties: { department: { type: 'string', enum: ['support', 'sales', 'recruitment'] }, caseId: { type: 'string' } }, additionalProperties: false }
const payloadSchema = { type: 'object', properties: { caseId: { type: 'string' }, department: { type: 'string', enum: ['support', 'sales', 'recruitment'] }, status: { type: 'string' }, revision: { type: 'integer', minimum: 0 } }, required: ['caseId', 'department', 'status', 'revision'], additionalProperties: false }

export async function handleMcpRequest(request: Request, db: McpDatabase, dependencies: McpDependencies = {}): Promise<Response> {
  if (request.method !== 'POST') return new Response('POST required.', { status: 405, headers: { Allow: 'POST' } })
  const principal = await dependencies.authorizeMcpPrincipal?.(request)
  if (!principal) return Response.json({ type: 'about:blank', title: 'Unauthorized', status: 401 }, { status: 401, headers: { 'Content-Type': 'application/problem+json' } })
  let id: string | number | null = null
  try {
    const body = await limitedText(request.body, 65_536)
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new RpcError(-32700, 'Parse error.') }
    const rpc = record(parsed)
    if (typeof rpc.id === 'string' || typeof rpc.id === 'number') id = rpc.id
    if (rpc.jsonrpc !== '2.0' || (id === null && rpc.id !== null) || typeof rpc.method !== 'string') throw new RpcError(-32600, 'Invalid request.')
    const params = record(rpc.params ?? {})
    const version = request.headers.get('MCP-Protocol-Version')
    if (version !== null && version !== PROTOCOL_VERSION) throw new RpcError(-32022, 'Unsupported protocol version.')
    const methodHeader = request.headers.get('Mcp-Method')
    if (methodHeader !== null && methodHeader !== rpc.method) throw new RpcError(-32600, 'Mcp-Method does not match the request.')
    let result: Record<string, unknown>
    switch (rpc.method) {
      case 'server/discover': result = { supportedVersions: [PROTOCOL_VERSION], capabilities: { tools: {}, events: {} }, serverInfo: { name: 'future-company', version: '0.1.0' }, ttlMs: 0, cacheScope: 'private' }; break
      case 'ping': result = {}; break
      case 'events/list':
        if (params.cursor != null) throw new RpcError(-32602, 'Unknown catalog cursor.')
        result = { events: principal.departments.length ? eventNames.map((name) => ({ name, description: name === 'case.created' ? 'A visitor opened a company case.' : name === 'human_request.created' ? 'A company case needs a staff action or decision.' : 'A company case was resolved.', delivery: ['webhook'], inputSchema: filterSchema, payloadSchema })) : [] }; break
      case 'events/subscribe': result = await subscribe(db, principal, params, dependencies); break
      case 'events/unsubscribe': {
        const name = eventName(params.name)
        const args = filters(params.arguments)
        const url = callbackUrl(record(params.delivery).url)
        const subscription = await subscriptionId(principal.id, name, args, url)
        await db.batch([
          db.prepare('UPDATE mcp_subscriptions SET active=0 WHERE id=? AND principal_id=?').bind(subscription, principal.id),
          db.prepare("UPDATE mcp_deliveries SET status='cancelled',last_error='unsubscribed' WHERE subscription_id=? AND status IN ('pending','sending')").bind(subscription),
        ])
        result = {}; break
      }
      case 'tools/list': result = { ttlMs: 0, cacheScope: 'private', tools: dependencies.readCase && principal.departments.length ? [{ name: 'read_case', description: 'Read an authorized case, including confirmed facts and staff requests.', inputSchema: { type: 'object', properties: { caseId: { type: 'string' } }, required: ['caseId'], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }] : [] }; break
      case 'tools/call': {
        if (params.name !== 'read_case') throw new RpcError(-32602, 'Unknown tool.')
        const nameHeader = request.headers.get('Mcp-Name')
        if (nameHeader !== null && nameHeader !== params.name) throw new RpcError(-32600, 'Mcp-Name does not match the request.')
        const args = record(params.arguments)
        if (Object.keys(args).some((key) => key !== 'caseId')) throw new RpcError(-32602, 'Unknown tool argument.')
        const caseId = string(args.caseId)
        if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) throw new RpcError(-32602, 'Invalid case ID.')
        const snapshot = await dependencies.readCase?.(principal, caseId)
        if (snapshot == null) throw new RpcError(-32024, 'Case access denied.')
        result = { content: [{ type: 'text', text: JSON.stringify(snapshot) }], structuredContent: snapshot, isError: false }; break
      }
      default: throw new RpcError(-32601, 'Method not found.')
    }
    return Response.json({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const problem = error instanceof RpcError ? error : new RpcError(-32603, 'Internal error.')
    return Response.json({ jsonrpc: '2.0', id, error: { code: problem.code, message: problem.message, ...(problem.reason ? { data: { reason: problem.reason } } : {}) } }, { headers: { 'Cache-Control': 'no-store' } })
  }
}

export async function queueMcpEvent(db: McpDatabase, event: McpEvent): Promise<void> {
  if (!event.eventId || event.eventId.length > 200 || !Number.isSafeInteger(event.data.revision) || event.data.revision < 0 || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid company event.')
  eventName(event.name)
  if (!isDepartment(event.data.department)) throw new Error('Invalid event department.')
  const body = JSON.stringify({ eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: null })
  if (encoder.encode(body).byteLength > 262_144) throw new Error('Event exceeds the MCP payload limit.')
  const existing = await db.prepare('SELECT body FROM mcp_events WHERE id=?').bind(event.eventId).first<{ body: string }>()
  if (existing && existing.body !== body) throw new Error('Event ID was reused with different data.')
  if (existing) return
  await db.batch([
    db.prepare('INSERT INTO mcp_events(id,name,body,occurred_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').bind(event.eventId, event.name, body, event.timestamp),
    db.prepare(`INSERT INTO mcp_deliveries(subscription_id,event_id,status,next_attempt_at)
      SELECT id,?,'pending',? FROM mcp_subscriptions WHERE event_name=? AND active=1 AND expires_at>?
      AND (department IS NULL OR department=?) AND (case_id IS NULL OR case_id=?)
      AND EXISTS(SELECT 1 FROM mcp_events WHERE id=? AND body=?) ON CONFLICT DO NOTHING`)
      .bind(event.eventId, event.timestamp, event.name, event.timestamp, event.data.department, event.data.caseId, event.eventId, body),
  ])
  const saved = await db.prepare('SELECT body FROM mcp_events WHERE id=?').bind(event.eventId).first<{ body: string }>()
  if (saved?.body !== body) throw new Error('Event ID was reused with different data.')
}

export async function dispatchMcpEvent(db: McpDatabase, eventId: string, dependencies: McpDependencies = {}): Promise<{ delivered: number; failed: number; blocked: boolean }> {
  if (!dependencies.verifiedCallbackTransport || !dependencies.authorizeMcpDelivery) return { delivered: 0, failed: 0, blocked: true }
  const current = now(dependencies).toISOString()
  await db.prepare("UPDATE mcp_deliveries SET status='failed',last_error='attempt_limit' WHERE event_id=? AND status='sending' AND attempts>=3 AND lease_until<=?").bind(eventId, current).run()
  const rows = await db.prepare(`SELECT s.*,e.body,d.attempts FROM mcp_deliveries d JOIN mcp_subscriptions s ON s.id=d.subscription_id JOIN mcp_events e ON e.id=d.event_id
    WHERE d.event_id=? AND d.attempts<3 AND ((d.status='pending' AND d.next_attempt_at<=?) OR (d.status='sending' AND d.lease_until<=?))`).bind(eventId, current, current).all<Subscription & { body: string; attempts: number }>()
  let delivered = 0
  let failed = 0
  for (const subscription of rows.results) {
    const event: { data: McpEventData } = JSON.parse(subscription.body)
    if (!subscription.active || subscription.expires_at <= current || !(await dependencies.authorizeMcpDelivery(subscription.principal_id, event.data))) {
      await db.prepare("UPDATE mcp_deliveries SET status='cancelled',last_error='access_or_subscription_ended' WHERE subscription_id=? AND event_id=? AND status IN ('pending','sending')").bind(subscription.id, eventId).run()
      continue
    }
    const lease = new Date(Date.parse(current) + 30_000).toISOString()
    const claimed = await db.prepare(`UPDATE mcp_deliveries SET status='sending',attempts=attempts+1,lease_until=? WHERE subscription_id=? AND event_id=? AND attempts=? AND attempts<3
      AND EXISTS(SELECT 1 FROM mcp_subscriptions WHERE id=? AND active=1 AND expires_at>?)
      AND ((status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?)) RETURNING attempts`)
      .bind(lease, subscription.id, eventId, subscription.attempts, subscription.id, current, current, current).first<{ attempts: number }>()
    if (!claimed) continue
    let status: number | null = null
    let error: string | null = null
    try {
      const response = await signedPost(subscription, eventId, subscription.body, dependencies)
      status = response.status
      if (!response.ok) error = `http_${status}`
    } catch { error = 'connection_failed' }
    const succeeded = error === null
    const transient = status === null || status === 408 || status === 429 || status >= 500
    const retry = !succeeded && transient && claimed.attempts < MAX_ATTEMPTS
    const nextAttempt = new Date(now(dependencies).getTime() + (claimed.attempts === 1 ? 5000 : 20_000)).toISOString()
    await db.prepare("UPDATE mcp_deliveries SET status=?,next_attempt_at=?,lease_until=NULL,last_status=?,last_error=? WHERE subscription_id=? AND event_id=? AND lease_until=? AND status='sending'")
      .bind(succeeded ? 'delivered' : retry ? 'pending' : 'failed', nextAttempt, status, error, subscription.id, eventId, lease).run()
    if (status === 410) await db.prepare('UPDATE mcp_subscriptions SET active=0 WHERE id=?').bind(subscription.id).run()
    if (succeeded) delivered++
    else failed++
  }
  return { delivered, failed, blocked: false }
}
