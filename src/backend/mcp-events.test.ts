import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHmac } from 'node:crypto'
import { handleMcpRequest, queueMcpEvent, dispatchMcpEvent } from './mcp-events'
import type { McpDatabase, McpDependencies, McpEvent } from './mcp-events'

const migration = await Bun.file(new URL('../../migrations/0002_mcp_events.sql', import.meta.url)).text()
const secret = 'whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
const callback = 'https://receiver.example.com/callback'
const start = new Date('2026-10-18T14:00:00Z')
const event: McpEvent = { eventId: 'evt_case-1_r1', name: 'case.created', timestamp: start.toISOString(), data: { caseId: 'case-1', department: 'support', status: 'active', revision: 1 } }
type RpcReply = { id: number; result: { id: string; structuredContent: { facts: { label: string }[] }; [key: string]: unknown }; error: { code: number; message: string; data: { reason: string } } }

function fixture() {
  const sqlite = new Database(':memory:')
  sqlite.exec(migration)
  function prepare(sql: string, values: (string | number | null)[] = []) {
    return {
      bind: (...bound: (string | number | null)[]) => prepare(sql, bound),
      first: async <T>() => sqlite.query(sql).get(...values) as T | null,
      all: async <T>() => ({ results: sqlite.query(sql).all(...values) as T[] }),
      run: async () => sqlite.query(sql).run(...values),
    }
  }
  const db: McpDatabase = { prepare, batch: async (statements) => { sqlite.exec('BEGIN'); try { for (const statement of statements) await statement.run(); sqlite.exec('COMMIT') } catch (error) { sqlite.exec('ROLLBACK'); throw error } } }
  let time = start
  let allowed = true
  const sent: { url: string; init: RequestInit }[] = []
  let callbackStatus = 200
  const dependencies: McpDependencies = {
    authorizeMcpPrincipal: async () => ({ id: 'staff-1', departments: ['support'] }),
    readCase: async (_principal, id) => id === 'case-1' ? { id, department: 'support', facts: [{ label: '商品', value: 'Event Light' }] } : null,
    authorizeMcpDelivery: async (_principal, data) => allowed && data.department === 'support',
    now: () => time,
    verifiedCallbackTransport: async (url, init) => {
      sent.push({ url, init })
      const headers = new Headers(init.headers)
      const expected = createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${headers.get('webhook-id')}.${headers.get('webhook-timestamp')}.${init.body}`).digest('base64')
      expect(headers.get('webhook-signature')?.split(' ')).toContain(`v1,${expected}`)
      expect(init.redirect).toBe('error')
      const body = JSON.parse(String(init.body))
      return body.type === 'verification' ? Response.json({ challenge: body.challenge }) : new Response('', { status: callbackStatus })
    },
  }
  async function rpc(method: string, params: unknown = {}, overrides: McpDependencies = {}) {
    const response = await handleMcpRequest(new Request('https://company.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method, params }) }), db, { ...dependencies, ...overrides })
    return { response, body: await response.json() as RpcReply }
  }
  const subscribe = (args: unknown = {}, extras: unknown = {}) => rpc('events/subscribe', { name: 'case.created', arguments: args, delivery: { mode: 'webhook', url: callback, secret }, ...(extras as object) })
  return { db, sqlite, dependencies, sent, rpc, subscribe, setTime: (date: Date) => { time = date }, deny: () => { allowed = false }, setStatus: (status: number) => { callbackStatus = status } }
}

describe('MCP 2.0 events', () => {
  test('discovery reports protocol and event capability, and unknown methods fail', async () => {
    const f = fixture()
    const result = await f.rpc('server/discover')
    expect(result.body.id).toBe(0)
    expect(result.body.result).toMatchObject({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { events: {}, tools: {} }, cacheScope: 'private' })
    expect((await f.rpc('events/poll')).body.error.code).toBe(-32601)
    f.sqlite.close()
  })

  test('no principal fails closed before disclosing events or cases', async () => {
    const f = fixture()
    const { response } = await f.rpc('events/list', {}, { authorizeMcpPrincipal: undefined })
    expect(response.status).toBe(401)
    f.sqlite.close()
  })

  test('subscription is refused without verified transport and does not store secrets', async () => {
    const f = fixture()
    const result = await f.rpc('events/subscribe', { name: 'case.created', arguments: {}, delivery: { mode: 'webhook', url: callback, secret } }, { verifiedCallbackTransport: undefined })
    expect(result.body.error).toMatchObject({ code: -32015, data: { reason: 'transport_unavailable' } })
    expect(f.sqlite.query('SELECT COUNT(*) AS count FROM mcp_subscriptions').get()).toEqual({ count: 0 })
    expect(f.sent).toHaveLength(0)
    f.sqlite.close()
  })

  test('canonical filters refresh the same subscription and do not reverify within the cache window', async () => {
    const f = fixture()
    const first = await f.subscribe({ department: 'support', caseId: 'case-1' })
    const again = await f.subscribe({ caseId: 'case-1', department: 'support' })
    expect(first.body.result.id).toBe(again.body.result.id)
    expect(first.body.result).toMatchObject({ refreshBefore: '2026-10-18T15:00:00.000Z', cursor: null, truncated: false })
    expect(f.sqlite.query('SELECT COUNT(*) AS count FROM mcp_subscriptions').get()).toEqual({ count: 1 })
    expect(f.sent).toHaveLength(1)
    f.sqlite.close()
  })

  test('filters and private reads cannot address unauthorized departments or cases', async () => {
    const f = fixture()
    expect((await f.subscribe({ department: 'sales' })).body.error.code).toBe(-32024)
    expect((await f.subscribe({ caseId: 'other-case' })).body.error.code).toBe(-32024)
    expect((await f.rpc('tools/call', { name: 'read_case', arguments: { caseId: 'other-case' } })).body.error.code).toBe(-32024)
    expect((await f.rpc('tools/call', { name: 'read_case', arguments: { caseId: 'case-1' } })).body.result.structuredContent.facts[0].label).toBe('商品')
    expect(f.sent).toHaveLength(0)
    f.sqlite.close()
  })

  test('callback rejection leaves no active subscription', async () => {
    const f = fixture()
    const result = await f.rpc('events/subscribe', { name: 'case.created', arguments: {}, delivery: { mode: 'webhook', url: callback, secret } }, { verifiedCallbackTransport: async () => Response.json({ challenge: 'wrong' }) })
    expect(result.body.error).toMatchObject({ code: -32015, data: { reason: 'challenge_failed' } })
    expect(f.sqlite.query('SELECT COUNT(*) AS count FROM mcp_subscriptions').get()).toEqual({ count: 0 })
    f.sqlite.close()
  })

  test('invalid URLs, secrets, filters and TTLs fail before callback I/O', async () => {
    const f = fixture()
    for (const url of ['http://receiver.example/callback', 'https://localhost/a', 'https://x.local/a', 'https://name:password@receiver.example/a', 'https://receiver.example/a#fragment']) {
      const result = await f.rpc('events/subscribe', { name: 'case.created', arguments: {}, delivery: { mode: 'webhook', url, secret } })
      expect(result.body.error.code).toBe(-32602)
    }
    for (const badSecret of ['', 'whsec_a', `whsec_${btoa('short')}`, `whsec_${btoa('x'.repeat(65))}`]) {
      const result = await f.rpc('events/subscribe', { name: 'case.created', arguments: {}, delivery: { mode: 'webhook', url: callback, secret: badSecret } })
      expect(result.body.error.code).toBe(-32602)
    }
    expect((await f.subscribe({ extra: 1 })).body.error.code).toBe(-32602)
    expect((await f.subscribe({}, { ttlMs: 0 })).body.error.code).toBe(-32602)
    expect((await f.subscribe({}, { ttlMs: Number.MAX_SAFE_INTEGER + 1 })).body.error.code).toBe(-32602)
    expect(f.sent).toHaveLength(0)
    f.sqlite.close()
  })

  test('confirmed events are persisted once and dispatched with independently verified HMAC', async () => {
    const f = fixture()
    await f.subscribe({ department: 'support' })
    await queueMcpEvent(f.db, event)
    await queueMcpEvent(f.db, event)
    expect(f.sqlite.query('SELECT COUNT(*) AS count FROM mcp_events').get()).toEqual({ count: 1 })
    expect(await dispatchMcpEvent(f.db, event.eventId, f.dependencies)).toEqual({ delivered: 1, failed: 0, blocked: false })
    expect(await dispatchMcpEvent(f.db, event.eventId, f.dependencies)).toEqual({ delivered: 0, failed: 0, blocked: false })
    const delivery = f.sent[1]
    expect(new Headers(delivery.init.headers).get('webhook-id')).toBe(event.eventId)
    expect(JSON.parse(String(delivery.init.body))).toMatchObject({ cursor: null, data: { caseId: 'case-1' } })
    expect(f.sqlite.query('SELECT status,attempts FROM mcp_deliveries').get()).toEqual({ status: 'delivered', attempts: 1 })
    await expect(queueMcpEvent(f.db, { ...event, data: { ...event.data, status: 'changed' } })).rejects.toThrow('Event ID was reused')
    f.sqlite.close()
  })

  test('department and case filters apply before fanout', async () => {
    const f = fixture()
    await f.subscribe({ caseId: 'case-1', department: 'support' })
    await queueMcpEvent(f.db, { ...event, eventId: 'evt_other', data: { ...event.data, caseId: 'case-2' } })
    await queueMcpEvent(f.db, { ...event, eventId: 'evt_sales', data: { ...event.data, department: 'sales' } })
    expect(f.sqlite.query('SELECT COUNT(*) AS count FROM mcp_deliveries').get()).toEqual({ count: 0 })
    f.sqlite.close()
  })

  test('expired or revoked subscriptions do not send business data', async () => {
    for (const revoke of [false, true]) {
      const f = fixture()
      await f.subscribe()
      await queueMcpEvent(f.db, event)
      if (revoke) f.deny()
      else f.setTime(new Date('2026-10-18T15:00:00Z'))
      await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
      expect(f.sent).toHaveLength(1)
      expect(f.sqlite.query('SELECT status FROM mcp_deliveries').get()).toEqual({ status: 'cancelled' })
      f.sqlite.close()
    }
  })

  test('unsubscribe is owner-scoped, idempotent and cancels pending deliveries', async () => {
    const f = fixture()
    await f.subscribe()
    await queueMcpEvent(f.db, event)
    const params = { name: 'case.created', arguments: {}, delivery: { mode: 'webhook', url: callback } }
    await f.rpc('events/unsubscribe', params, { authorizeMcpPrincipal: async () => ({ id: 'staff-2', departments: ['support'] }) })
    expect(f.sqlite.query('SELECT active FROM mcp_subscriptions').get()).toEqual({ active: 1 })
    await f.rpc('events/unsubscribe', params)
    await f.rpc('events/unsubscribe', params)
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    expect(f.sqlite.query('SELECT status FROM mcp_deliveries').get()).toEqual({ status: 'cancelled' })
    expect(f.sent).toHaveLength(1)
    f.sqlite.close()
  })

  test('transient errors get three explicit attempts with fresh signatures and no timer', async () => {
    const f = fixture()
    await f.subscribe()
    await queueMcpEvent(f.db, event)
    f.setStatus(503)
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    expect(f.sent).toHaveLength(2)
    f.setTime(new Date(start.getTime() + 5000))
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    f.setTime(new Date(start.getTime() + 25_000))
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    f.setTime(new Date(start.getTime() + 100_000))
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    expect(f.sent).toHaveLength(4)
    const first = new Headers(f.sent[1].init.headers)
    const retry = new Headers(f.sent[2].init.headers)
    expect(first.get('webhook-id')).toBe(retry.get('webhook-id'))
    expect(first.get('webhook-timestamp')).not.toBe(retry.get('webhook-timestamp'))
    expect(first.get('webhook-signature')).not.toBe(retry.get('webhook-signature'))
    expect(f.sqlite.query('SELECT status,attempts FROM mcp_deliveries').get()).toEqual({ status: 'failed', attempts: 3 })
    f.sqlite.close()
  })

  test('410 disables a subscription and 413 ends that delivery without retries', async () => {
    for (const status of [410, 413]) {
      const f = fixture()
      await f.subscribe()
      await queueMcpEvent(f.db, event)
      f.setStatus(status)
      await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
      f.setTime(new Date(start.getTime() + 100_000))
      await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
      expect(f.sent).toHaveLength(2)
      expect(f.sqlite.query('SELECT active FROM mcp_subscriptions').get()).toEqual({ active: status === 410 ? 0 : 1 })
      expect(f.sqlite.query('SELECT status,attempts,last_status FROM mcp_deliveries').get()).toEqual({ status: 'failed', attempts: 1, last_status: status })
      f.sqlite.close()
    }
  })

  test('a restarted dispatcher recovers an expired lease and never exceeds the attempt limit', async () => {
    const f = fixture()
    await f.subscribe()
    await queueMcpEvent(f.db, event)
    f.sqlite.query("UPDATE mcp_deliveries SET status='sending',attempts=2,lease_until=?").run('2026-10-18T13:59:00.000Z')
    expect((await dispatchMcpEvent(f.db, event.eventId, f.dependencies)).delivered).toBe(1)
    expect(f.sqlite.query('SELECT attempts,status FROM mcp_deliveries').get()).toEqual({ attempts: 3, status: 'delivered' })
    await queueMcpEvent(f.db, { ...event, eventId: 'evt_after_crash' })
    f.sqlite.query("UPDATE mcp_deliveries SET status='sending',attempts=3,lease_until=? WHERE event_id='evt_after_crash'").run('2026-10-18T13:59:00.000Z')
    await dispatchMcpEvent(f.db, 'evt_after_crash', f.dependencies)
    expect(f.sqlite.query("SELECT status,last_error FROM mcp_deliveries WHERE event_id='evt_after_crash'").get()).toEqual({ status: 'failed', last_error: 'attempt_limit' })
    expect(f.sent).toHaveLength(2)
    f.sqlite.close()
  })

  test('unsubscribe during a delivery cannot resurrect the cancelled delivery', async () => {
    const f = fixture()
    await f.subscribe()
    await queueMcpEvent(f.db, event)
    await dispatchMcpEvent(f.db, event.eventId, { ...f.dependencies, verifiedCallbackTransport: async () => {
      await f.rpc('events/unsubscribe', { name: 'case.created', arguments: {}, delivery: { url: callback } })
      return new Response('', { status: 503 })
    } })
    expect(f.sqlite.query('SELECT status FROM mcp_deliveries').get()).toEqual({ status: 'cancelled' })
    expect(f.sqlite.query('SELECT active FROM mcp_subscriptions').get()).toEqual({ active: 0 })
    f.sqlite.close()
  })

  test('secret refresh verifies the new key and emits both keys during the grace window', async () => {
    const f = fixture()
    await f.subscribe()
    const nextSecret = `whsec_${btoa('replacement-secret-for-testing-32')}`
    const response = await f.rpc('events/subscribe', { name: 'case.created', arguments: {}, delivery: { mode: 'webhook', url: callback, secret: nextSecret } }, { verifiedCallbackTransport: async (_url, init) => {
      const headers = new Headers(init.headers)
      const expected = createHmac('sha256', Buffer.from(nextSecret.slice(6), 'base64')).update(`${headers.get('webhook-id')}.${headers.get('webhook-timestamp')}.${init.body}`).digest('base64')
      expect(headers.get('webhook-signature')).toBe(`v1,${expected}`)
      return Response.json({ challenge: JSON.parse(String(init.body)).challenge })
    } })
    expect(response.body.result.id).toBeDefined()
    await queueMcpEvent(f.db, event)
    await dispatchMcpEvent(f.db, event.eventId, f.dependencies)
    expect(new Headers(f.sent[1].init.headers).get('webhook-signature')?.split(' ')).toHaveLength(2)
    f.sqlite.close()
  })
})
