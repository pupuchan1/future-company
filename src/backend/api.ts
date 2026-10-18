import { Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { parse } from 'hono/utils/cookie'
import type { Context } from 'hono'
import { ApiError, idField, object, parseCreate, textField } from './contracts'
import type { Actor, CaseSnapshot, Command } from './contracts'
import type { BackendEnv, RoomResult } from './case-room'
import { authorizeDemoStaff, isDemoStaffConfigured, requireStaffIdentity, staffSessionCookie } from './auth'
import type { AuthorizeStaff, StaffAuthEnv } from './auth'
import { persistCase } from './persistence'

type ApiOptions = { authorizeStaff?: AuthorizeStaff }
type AppEnv = { Bindings: BackendEnv & StaffAuthEnv }
type CommandInput = { commandId: string; expectedRevision: number; data: Record<string, unknown> }
const cookieName = 'future_company_visitor'

async function ownerActor(token: string | undefined): Promise<Actor & { role: 'visitor' }> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(401, 'visitor_session_required', 'Start a visitor session first.')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  const ownerHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return { role: 'visitor', ownerHash }
}

export async function authorizeVisitorCase(request: Request, env: BackendEnv, caseId: string): Promise<{ actor: Actor & { role: 'visitor' }; snapshot: CaseSnapshot }> {
  const actor = await ownerActor(parse(request.headers.get('Cookie') ?? '', cookieName)[cookieName])
  return { actor, snapshot: unwrap(await env.CASES.getByName(idField(caseId, 'caseId')).snapshot(actor)) }
}

function unwrap(result: RoomResult): CaseSnapshot {
  if (!result.ok) throw new ApiError(result.status, result.code, result.detail)
  return result.snapshot
}

async function visitor(c: Context<AppEnv>, create = false): Promise<Actor & { role: 'visitor' }> {
  let token = getCookie(c, cookieName)
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    if (!create) throw new ApiError(401, 'visitor_session_required', 'Start a visitor session first.')
    token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('')
    setCookie(c, cookieName, token, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', path: '/api/v1' })
  }
  return ownerActor(token)
}

async function commandInput(c: Context<AppEnv>, maxBytes?: number): Promise<CommandInput> {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'json_required', 'Use application/json.')
  let data: Record<string, unknown>
  try {
    if (maxBytes === undefined) data = object(await c.req.json<unknown>())
    else {
      const chunks: Uint8Array[] = []
      const reader = c.req.raw.body?.getReader()
      let size = 0
      if (reader) {
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            if (size > maxBytes) {
              await reader.cancel()
              throw new ApiError(413, 'body_too_large', `The JSON body must be at most ${maxBytes} bytes.`)
            }
            chunks.push(value)
          }
        } finally { reader.releaseLock() }
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      data = object(JSON.parse(new TextDecoder().decode(bytes)))
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'invalid_json', 'The JSON body is invalid.')
  }
  const commandId = idField(data.commandId, 'commandId')
  if (typeof data.expectedRevision !== 'number' || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0) throw new ApiError(400, 'invalid_input', 'expectedRevision must be a non-negative safe integer.')
  return { commandId, expectedRevision: data.expectedRevision, data }
}

export async function projectCase(env: BackendEnv, id: string, actor: Actor): Promise<void> {
  const result = await env.CASES.getByName(id).getIntegration(actor)
  const snapshot = unwrap(result)
  if (result.ok) await persistCase(env, snapshot, result.integration)
}

async function execute(env: BackendEnv, id: string, actor: Actor, commandId: string, revision: number, command: Command): Promise<CaseSnapshot> {
  const snapshot = unwrap(await env.CASES.getByName(id).command(actor, commandId, revision, command, new Date().toISOString()))
  await projectCase(env, id, actor)
  return snapshot
}

export function createBackendApi(options: ApiOptions = {}): Hono<AppEnv> {
  const api = new Hono<AppEnv>()
  async function staff(c: Context<AppEnv>): Promise<Actor & { role: 'staff' }> {
    if (!options.authorizeStaff) throw new ApiError(503, 'staff_auth_unconfigured', 'Staff authentication is not configured.')
    return requireStaffIdentity(c.req.raw, c.env, options.authorizeStaff)
  }
  function caseId(c: Context<AppEnv>): string { return idField(c.req.param('id'), 'caseId') }

  api.use('*', async (c, next) => {
    if (!c.env.CASES || !c.env.DB) throw new ApiError(503, 'backend_unconfigured', 'The CASES Durable Object and DB D1 bindings are required.')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('Origin')
      if (origin && origin !== new URL(c.req.url).origin) throw new ApiError(403, 'origin_not_allowed', 'Cross-origin writes are not allowed.')
    }
    await next()
  })
  api.onError((error, c) => {
    const known = error instanceof ApiError
    const status = known ? error.status : 500
    return new Response(JSON.stringify({ type: `urn:future-company:error:${known ? error.code : 'internal_error'}`, title: known ? error.code : 'internal_error', status, detail: known ? error.message : 'The request could not be completed.', instance: new URL(c.req.url).pathname }), { status, headers: { 'Content-Type': 'application/problem+json', 'Cache-Control': 'no-store' } })
  })
  api.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next() })

  api.get('/company', async (c) => {
    const company = await c.env.DB.prepare('SELECT id,name,description,fictional FROM company WHERE id=?').bind('demo').first()
    const products = await c.env.DB.prepare('SELECT id,name,description,exchange_policy,standard_delivery_days FROM products').all()
    return c.json({ company, products: products.results, fictional: true })
  })
  api.get('/capabilities', (c) => c.json({ voice: { available: false, reason: 'gpt_live_not_connected' }, agent: { available: false, reason: 'agents_api_not_connected' }, mcpEvents: { available: false, reason: 'mcp_events_not_connected' }, staff: { configured: options.authorizeStaff === authorizeDemoStaff ? isDemoStaffConfigured(c.env) : Boolean(options.authorizeStaff) }, fictionalBusiness: true }))

  api.post('/cases', async (c) => {
    const input = await commandInput(c)
    if (input.expectedRevision !== 0) throw new ApiError(400, 'invalid_input', 'New cases start at revision 0.')
    const create = parseCreate(input.data)
    const actor = await visitor(c, true)
    // Derive the case ID from the owner and command so retries create the same case.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${actor.ownerHash}:${input.commandId}`))
    const id = `case-${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
    const snapshot = unwrap(await c.env.CASES.getByName(id).initialize({ id, ownerHash: actor.ownerHash, ...create, now: new Date().toISOString() }))
    if (snapshot.kind !== create.kind || snapshot.locale !== create.locale) throw new ApiError(409, 'idempotency_conflict', 'This creation command was used for different input.')
    await projectCase(c.env, id, actor)
    return c.json({ case: snapshot }, 201)
  })

  api.get('/cases/:id', async (c) => c.json({ case: unwrap(await c.env.CASES.getByName(caseId(c)).snapshot(await visitor(c))) }))
  api.post('/cases/:id/recruitment/submit', async (c) => {
    const input = await commandInput(c, 64 * 1024)
    const roleInterest = textField(input.data.roleInterest, 'roleInterest')
    const experience = textField(input.data.experience, 'experience')
    const rawQuestions = input.data.questions ?? []
    if (!Array.isArray(rawQuestions) || input.data.questions === null) throw new ApiError(400, 'invalid_input', 'questions must be an array of strings.')
    const questions = rawQuestions.map((value) => textField(value, 'questions[]'))
    const actor = await visitor(c)
    const id = caseId(c)
    const state = unwrap(await c.env.CASES.getByName(id).snapshot(actor))
    if (state.kind !== 'recruitment') throw new ApiError(409, 'case_kind_mismatch', 'This action requires a recruitment case.')
    return c.json({ case: await execute(c.env, id, actor, input.commandId, input.expectedRevision, { type: 'submit_recruitment', roleInterest, experience, questions }) })
  })
  api.post('/cases/:id/messages', async (c) => {
    const input = await commandInput(c)
    return c.json({ case: await execute(c.env, caseId(c), await visitor(c), input.commandId, input.expectedRevision, { type: 'message', text: textField(input.data.text, 'text') }) })
  })
  api.get('/cases/:id/ws', async (c) => {
    const actor = await visitor(c)
    const headers = new Headers({ Upgrade: 'websocket', 'x-internal-owner-hash': actor.ownerHash })
    const origin = c.req.header('Origin')
    if (origin && origin !== new URL(c.req.url).origin) throw new ApiError(403, 'origin_not_allowed', 'Cross-origin WebSockets are not allowed.')
    return c.env.CASES.getByName(caseId(c)).fetch(new Request(c.req.url, { headers }))
  })

  api.post('/cases/:id/investigate', async (c) => {
    const input = await commandInput(c)
    const reference = textField(input.data.reference, 'reference', 100)
    const accessCode = textField(input.data.accessCode, 'accessCode', 100)
    if (typeof input.data.urgent !== 'boolean') throw new ApiError(400, 'invalid_input', 'urgent must be a boolean.')
    const actor = await visitor(c)
    const id = caseId(c)
    const investigationId = input.commandId
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ reference, accessCode, urgent: input.data.urgent })))
    const inputHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const started = await execute(c.env, id, actor, `${input.commandId}-start`, input.expectedRevision, { type: 'begin_investigation', investigationId, inputHash })
    const completed = await c.env.CASES.getByName(id).commandOutcome(actor, `${input.commandId}-result`)
    if (completed) {
      const result = unwrap(completed)
      await projectCase(c.env, id, actor)
      return c.json({ case: result, execution: 'business_rules', fictional: true })
    }
    const failed = await c.env.CASES.getByName(id).commandOutcome(actor, `${input.commandId}-failed`)
    if (failed) { const state = unwrap(failed); throw new ApiError(state.investigation?.error === 'order_not_found' ? 404 : 503, state.investigation?.error ?? 'order_lookup_failed', 'This investigation failed. Start a new command to check again.') }
    if (started.investigation?.status !== 'running') return c.json({ case: started })
    try {
      const order = await c.env.DB.prepare('SELECT o.id,o.reference,o.status,o.exchange_eligible,p.id AS product_id,p.name,p.exchange_policy,p.standard_delivery_days FROM orders o JOIN products p ON p.id=o.product_id WHERE o.reference=? AND o.access_code=?')
        .bind(reference, accessCode).first<{ id: string; reference: string; status: string; exchange_eligible: number; product_id: string; name: string; exchange_policy: string; standard_delivery_days: number }>()
      if (!order) throw new ApiError(404, 'order_not_found', 'No order matches that reference and access code.')
      const now = started.updatedAt
      const eligible = order.exchange_eligible === 1
      const result = await execute(c.env, id, actor, `${input.commandId}-result`, started.revision, { type: 'investigation_result', investigationId, orderId: order.id, facts: [
        { label: 'Order', value: order.reference, source: `demo.orders:${order.id}`, observedAt: now },
        { label: 'Product', value: order.name, source: `demo.products:${order.product_id}`, observedAt: now },
        { label: 'Order status', value: order.status, source: `demo.orders:${order.id}`, observedAt: now },
        { label: 'Exchange eligibility', value: eligible ? 'Eligible' : 'Not eligible', source: `demo.orders:${order.id}`, observedAt: now },
        { label: 'Exchange policy', value: order.exchange_policy, source: `demo.products:${order.product_id}`, observedAt: now },
        { label: 'Standard delivery', value: `${order.standard_delivery_days} days`, source: `demo.products:${order.product_id}`, observedAt: now }
      ], requiresHuman: input.data.urgent && eligible, summary: `A visitor reports a damaged ${order.name} and needs an urgent replacement.`, proposal: eligible ? 'A standard exchange is available under the demo exchange policy.' : 'This demo order is not eligible for an exchange.', canReplace: eligible })
      return c.json({ case: result, execution: 'business_rules', fictional: true })
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'revision_conflict' || error.code === 'stale_investigation' || error.code === 'projection_failed')) throw error
      const failure = error instanceof ApiError ? error : new ApiError(503, 'order_lookup_failed', 'The order could not be checked.')
      await execute(c.env, id, actor, `${input.commandId}-failed`, started.revision, { type: 'investigation_failed', investigationId, error: failure.code })
      throw failure
    }
  })

  api.post('/cases/:id/replacements', async (c) => {
    const input = await commandInput(c)
    const actor = await visitor(c)
    const id = caseId(c)
    const replacementId = `replacement-${input.commandId}`
    const started = await execute(c.env, id, actor, `${input.commandId}-start`, input.expectedRevision, { type: 'begin_replacement', replacementId })
    const completed = await c.env.CASES.getByName(id).commandOutcome(actor, `${input.commandId}-result`)
    if (completed) { const result = unwrap(completed); await projectCase(c.env, id, actor); return c.json({ case: result, fictional: true }) }
    if (!started.replacement) throw new ApiError(409, 'replacement_not_available', 'An exchange proposal is required.')
    const existing = await c.env.DB.prepare('SELECT id,case_id FROM replacements WHERE order_id=?').bind(started.replacement.orderId).first<{ id: string; case_id: string }>()
    if (existing && (existing.id !== replacementId || existing.case_id !== id)) {
      await execute(c.env, id, actor, `${input.commandId}-failed`, started.revision, { type: 'replacement_result', replacementId, succeeded: false })
      throw new ApiError(409, 'order_already_replaced', 'An exchange is already recorded for this order.')
    }
    await c.env.DB.prepare('INSERT INTO replacements(id,case_id,order_id,created_at,fictional) VALUES(?,?,?,?,1) ON CONFLICT(id) DO NOTHING').bind(replacementId, id, started.replacement.orderId, new Date().toISOString()).run()
    const result = await execute(c.env, id, actor, `${input.commandId}-result`, started.revision, { type: 'replacement_result', replacementId, succeeded: true })
    return c.json({ case: result, fictional: true })
  })

  api.get('/staff/cases', async (c) => {
    await staff(c)
    const rawLimit = c.req.query('limit') ?? '50'
    const limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_input', 'limit must be between 1 and 100.')
    const cursor = c.req.query('cursor')
    const rows = cursor
      ? await c.env.DB.prepare('SELECT id,summary FROM cases WHERE id < ? ORDER BY id DESC LIMIT ?').bind(idField(cursor, 'cursor'), limit + 1).all<{ id: string; summary: string }>()
      : await c.env.DB.prepare('SELECT id,summary FROM cases ORDER BY id DESC LIMIT ?').bind(limit + 1).all<{ id: string; summary: string }>()
    const page = rows.results.slice(0, limit)
    return c.json({ cases: page.map((row) => JSON.parse(row.summary)), nextCursor: rows.results.length > limit ? page.at(-1)?.id : null, consistency: 'eventual', source: 'd1_summary' })
  })
  api.post('/staff/session', async (c) => {
    if (!options.authorizeStaff) throw new ApiError(503, 'staff_auth_unconfigured', 'Staff authentication is not configured.')
    await staff(c)
    c.header('Set-Cookie', await staffSessionCookie(c.req.raw, c.env))
    return c.json({ staff: { id: 'demo-staff' } })
  })
  api.get('/staff/cases/:id', async (c) => c.json({ case: unwrap(await c.env.CASES.getByName(caseId(c)).snapshot(await staff(c))) }))
  api.get('/staff/cases/:id/ws', async (c) => {
    const actor = await staff(c)
    const origin = c.req.header('Origin')
    if (origin && origin !== new URL(c.req.url).origin) throw new ApiError(403, 'origin_not_allowed', 'Cross-origin WebSockets are not allowed.')
    return c.env.CASES.getByName(caseId(c)).fetch(new Request(c.req.url, { headers: { Upgrade: 'websocket', 'x-internal-staff-id': actor.id } }))
  })
  api.post('/staff/requests/:id/claim', async (c) => {
    const input = await commandInput(c)
    return c.json({ case: await execute(c.env, idField(input.data.caseId, 'caseId'), await staff(c), input.commandId, input.expectedRevision, { type: 'claim', requestId: idField(c.req.param('id'), 'requestId') }) })
  })
  api.post('/staff/requests/:id/answer', async (c) => {
    const input = await commandInput(c)
    const actor = await staff(c)
    const id = idField(input.data.caseId, 'caseId')
    const state = unwrap(await c.env.CASES.getByName(id).snapshot(actor))
    if (state.kind !== 'recruitment' && typeof input.data.stockAvailable !== 'boolean') throw new ApiError(400, 'invalid_input', 'stockAvailable must be a boolean.')
    if (input.data.stockAvailable !== undefined && typeof input.data.stockAvailable !== 'boolean') throw new ApiError(400, 'invalid_input', 'stockAvailable must be a boolean when provided.')
    const stockAvailable = state.kind !== 'recruitment' && typeof input.data.stockAvailable === 'boolean' ? { stockAvailable: input.data.stockAvailable } : {}
    let answer: string
    let metadata: Pick<Extract<Command, { type: 'answer' }>, 'answerLanguage' | 'simulated'> = {}
    if (input.data.result !== undefined || input.data.simulated !== undefined) {
      const result = object(input.data.result)
      answer = textField(result.text, 'result.text')
      if (result.language !== 'ja' && result.language !== 'en') throw new ApiError(400, 'invalid_input', 'result.language must be ja or en.')
      if (typeof input.data.simulated !== 'boolean') throw new ApiError(400, 'invalid_input', 'simulated must be an explicit boolean for a result.')
      if (input.data.answer !== undefined && textField(input.data.answer, 'answer') !== answer) throw new ApiError(400, 'invalid_input', 'answer and result.text must match when both are provided.')
      metadata = { answerLanguage: result.language, simulated: input.data.simulated }
    } else answer = textField(input.data.answer, 'answer')
    return c.json({ case: await execute(c.env, id, actor, input.commandId, input.expectedRevision, { type: 'answer', requestId: idField(c.req.param('id'), 'requestId'), answer, ...stockAvailable, ...metadata }) })
  })
  return api
}
