import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import type { CaseSnapshot } from './contracts'

// The adapter is a Node module; this test crosses its real HTTP seam into workerd.
const bridgeModulePath = '../../integration/worker-bridge.mjs'
const { WorkerBridge } = await import(bridgeModulePath)
let mf: Miniflare
const staffToken = randomBytes(32).toString('hex')
const origin = 'http://localhost'

before(async () => {
  const bundle = await build({ entryPoints: ['src/index.tsx'], bundle: true, write: false,
    format: 'esm', platform: 'browser', jsx: 'automatic', jsxImportSource: 'hono/jsx',
    external: ['cloudflare:workers'], define: { 'import.meta.env.PROD': 'true' } })
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-worker-result-bridge', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2025-08-03',
    durableObjects: { CASES: { className: 'CaseRoom', useSQLite: true } }, d1Databases: ['DB'],
    bindings: { STAFF_API_TOKEN: staffToken },
    outboundService: () => new Response('External providers are disabled.', { status: 502 }),
  }))
  const db = await mf.getD1Database('DB')
  for (const file of ['migrations/0001_company.sql', 'migrations/0002_mcp_events.sql']) {
    const sql = await readFile(file, 'utf8')
    for (const statement of sql.split(';').filter(part => part.trim())) await db.exec(statement.replaceAll('\n', ' '))
  }
}, { timeout: 20000 })
after(async () => { await mf?.dispose() })

async function request(path: string, body?: unknown, { cookie = '', staff = false } = {}) {
  return mf.dispatchFetch(`${origin}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(staff ? { Authorization: `Bearer ${staffToken}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function readCase(response: Awaited<ReturnType<typeof request>>): Promise<CaseSnapshot> {
  const data = await response.json() as { case?: CaseSnapshot; title?: string }
  assert.ok(response.ok, `HTTP ${response.status}: ${data.title}`)
  assert.ok(data.case)
  return data.case
}

async function newCase(kind: 'support' | 'recruitment' | 'haas' = 'support') {
  const response = await request('/cases', { commandId: `create-${randomUUID()}`, expectedRevision: 0, kind, locale: 'en' })
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0]
  const snapshot = await readCase(response)
  const proofResponse = await request(`/cases/${snapshot.id}/bridge-token`, {}, { cookie })
  assert.equal(proofResponse.status, 200)
  const { bridgeToken } = await proofResponse.json() as { bridgeToken: string }
  return { snapshot, cookie, proof: bridgeToken }
}

class ExternalSocket extends EventEmitter {
  closed = false
  close() { this.closed = true }
  snapshot(snapshot: CaseSnapshot) { this.emit('message', Buffer.from(JSON.stringify({ type: 'case.snapshot', snapshot }))) }
}

type CompletedEvent = { eventId: string; isValid: () => boolean; data: { case_id: string; handoff_id: string; request_id: string; source_route: string; result: { text: string; language: string }; simulated: boolean } }

function adapter(deliver: (event: CompletedEvent) => Promise<{ status: string }>, afterWrite = (_path: string, _body: Record<string, unknown>) => {}) {
  const sockets: ExternalSocket[] = []
  const errors: unknown[] = []
  const bridge = new WorkerBridge({ url: origin, token: staffToken,
    fetcher: async (url: URL, options: RequestInit) => {
      const response = await mf.dispatchFetch(url.href, {
        method: options.method, headers: Object.fromEntries(new Headers(options.headers)),
        ...(typeof options.body === 'string' ? { body: options.body } : {}),
      })
      if (response.ok && typeof options.body === 'string') afterWrite(url.pathname, JSON.parse(options.body))
      return response
    },
    socketFactory: () => { const socket = new ExternalSocket(); sockets.push(socket); return socket },
    deliver, emit: (event: unknown) => errors.push(event),
  })
  return { bridge, sockets, errors }
}

function human(caseId: string, handoffId: string, name = 'human.requested', result?: { text: string; language: 'en' | 'ja' }) {
  return { name, eventId: `${handoffId}:${name}`, data: { case_id: caseId, handoff_id: handoffId,
    summary: 'A caller needs a human answer.', task: '開発環境について教えてください。', target_role: 'Engineer',
    expected_result: 'Answer the caller in their language.', simulated: true, ...(result ? { result } : {}) } }
}

async function saved(caseId: string) { return readCase(await request(`/staff/cases/${caseId}`, undefined, { staff: true })) }

test('owner-only proof authorizes exactly one Worker case; invalid and other-case proofs fail closed', async () => {
  const first = await newCase()
  const other = await newCase()
  assert.equal((await request(`/cases/${first.snapshot.id}/bridge-token`, {})).status, 401)
  assert.equal((await request(`/cases/${first.snapshot.id}/bridge-token`, {}, { cookie: other.cookie })).status, 404)
  const { bridge } = adapter(async () => ({ status: 'live_submitted' }))
  try {
    await assert.rejects(bridge.attachCase(other.snapshot.id, first.proof), /valid case-scoped/)
    await assert.rejects(bridge.attachCase(first.snapshot.id, 'forged.proof'), /valid case-scoped/)
    await bridge.attachCase(first.snapshot.id, first.proof)
    await assert.rejects(bridge.attachCase(first.snapshot.id, first.proof), /already exists/)
  } finally { bridge.close() }
})

test('real Worker result returns once with stable case/handoff/original route and exact D1 provenance', async () => {
  const { snapshot, proof } = await newCase('haas')
  const events: CompletedEvent[] = []
  const { bridge, sockets, errors } = adapter(async event => { events.push(event); return { status: 'live_submitted' } })
  const handoffId = `handoff-${randomUUID()}`
  const answer = { text: '【架空の模擬回答】TypeScriptとVS Codeです。', language: 'ja' as const }
  try {
    await bridge.attachCase(snapshot.id, proof)
    await bridge.humanEvent(human(snapshot.id, handoffId), 'recruiting')
    // A later voice/department must not replace the origin route.
    await bridge.humanEvent(human(snapshot.id, handoffId), 'haas')
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', answer), 'haas')
    const state = bridge.cases.get(snapshot.id)
    await state.deliveries.get(handoffId)
    assert.equal(events.length, 1)
    assert.equal(events[0].data.case_id, snapshot.id)
    assert.equal(events[0].data.handoff_id, handoffId)
    assert.equal(events[0].data.source_route, 'recruiting')
    assert.notEqual(events[0].data.request_id, handoffId)
    assert.deepEqual(events[0].data.result, answer)
    assert.equal(events[0].data.simulated, true)
    const persisted = await saved(snapshot.id)
    assert.equal(persisted.requests.length, 1)
    assert.equal(persisted.requests[0].assignedTo, 'demo-staff')
    assert.deepEqual(persisted.requests[0].result, answer)
    assert.equal(persisted.requests[0].delivery?.status, 'live_submitted')
    assert.equal(persisted.ai.status, 'resume_pending')
    sockets[0].snapshot(persisted)
    sockets[0].snapshot({ ...persisted, id: 'another-case' })
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', answer), 'haas')
    await state.queue
    assert.equal(events.length, 1)
    assert.equal((await saved(snapshot.id)).revision, persisted.revision)
    const db = await mf.getD1Database('DB')
    const row = await db.prepare('SELECT summary FROM cases WHERE id=?').bind(snapshot.id).first<{ summary: string }>()
    assert.ok(row)
    const summary = JSON.parse(row.summary) as CaseSnapshot
    assert.deepEqual(summary.requests[0].origin, persisted.requests[0].origin)
    assert.deepEqual(summary.requests[0].result, answer)
    assert.equal(summary.requests[0].delivery?.status, 'live_submitted')
    assert.equal(errors.filter((event: unknown) => typeof event === 'object' && event !== null && 'type' in event && event.type === 'worker.error').length, 0)
  } finally { bridge.close() }
})

test('employee answer requires authentication, claim and current revision; browser cannot register server handoffs', async () => {
  const { snapshot, cookie, proof } = await newCase('recruitment')
  const { bridge } = adapter(async () => ({ status: 'live_submitted' }))
  const handoffId = `handoff-${randomUUID()}`
  try {
    const input = { commandId: `register-${handoffId}`, expectedRevision: 0, nodeCaseId: snapshot.id, handoffId,
      route: 'recruiting', summary: 'Candidate question', task: 'Tooling?', targetRole: 'Engineer', expectedResult: 'Answer' }
    assert.equal((await request(`/staff/cases/${snapshot.id}/handoffs`, input, { cookie })).status, 401)
    await bridge.attachCase(snapshot.id, proof)
    await bridge.humanEvent(human(snapshot.id, handoffId), 'recruiting')
    let current = await saved(snapshot.id)
    const requestId = current.requests[0].id
    const answer = { caseId: snapshot.id, commandId: `answer-${handoffId}`, expectedRevision: current.revision,
      result: { text: 'Mock developer answer', language: 'en' }, simulated: true }
    assert.equal((await request(`/staff/requests/${requestId}/answer`, answer, { cookie })).status, 401)
    assert.equal((await request(`/staff/requests/${requestId}/answer`, answer, { staff: true })).status, 409)
    current = await readCase(await request(`/staff/requests/${requestId}/claim`, {
      caseId: snapshot.id, commandId: `claim-${handoffId}`, expectedRevision: current.revision,
    }, { staff: true }))
    assert.equal((await request(`/staff/requests/${requestId}/answer`, answer, { staff: true })).status, 409)
    current = await readCase(await request(`/staff/requests/${requestId}/answer`, { ...answer, expectedRevision: current.revision }, { staff: true }))
    assert.equal(current.requests[0].status, 'answered')
    assert.equal(current.requests[0].delivery?.status, 'pending')
  } finally { bridge.close() }
})

test('cancelled handoff and late completed event cannot revive a request or deliver any answer', async () => {
  const { snapshot, proof } = await newCase()
  const events: CompletedEvent[] = []
  const { bridge } = adapter(async event => { events.push(event); return { status: 'live_submitted' } })
  const handoffId = `handoff-${randomUUID()}`
  try {
    await bridge.attachCase(snapshot.id, proof)
    await bridge.humanEvent(human(snapshot.id, handoffId), 'haas')
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.cancelled'), 'haas')
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', { text: 'Late answer', language: 'en' }), 'haas')
    assert.equal((await saved(snapshot.id)).requests[0].status, 'cancelled')
    assert.equal(events.length, 0)
  } finally { bridge.close() }
})

test('queued result becomes invalid when the case closes and does not report Live delivery', async () => {
  const { snapshot, proof } = await newCase()
  let release: ((value: { status: string }) => void) | undefined
  let arrived: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { arrived = resolve })
  let received: CompletedEvent | undefined
  const { bridge } = adapter(event => {
    received = event
    arrived!()
    return new Promise(resolve => { release = resolve })
  })
  const handoffId = `handoff-${randomUUID()}`
  try {
    await bridge.attachCase(snapshot.id, proof)
    await bridge.humanEvent(human(snapshot.id, handoffId), 'haas')
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', { text: 'Saved reply', language: 'en' }), 'haas')
    await waiting
    const pending = bridge.cases.get(snapshot.id).deliveries.get(handoffId)
    assert.equal(received!.isValid(), true)
    bridge.closeCase(snapshot.id)
    assert.equal(received!.isValid(), false)
    release!({ status: 'live_submitted' })
    await pending
    assert.equal((await saved(snapshot.id)).requests[0].delivery?.status, 'queued')
  } finally { release?.({ status: 'failed' }); bridge.close() }
})

test('D1 projection outage never sends an unpersisted answer and same registration recovers once', async () => {
  const { snapshot, proof } = await newCase()
  const events: CompletedEvent[] = []
  const { bridge } = adapter(async event => { events.push(event); return { status: 'live_submitted' } })
  const handoffId = `handoff-${randomUUID()}`
  const db = await mf.getD1Database('DB')
  try {
    await bridge.attachCase(snapshot.id, proof)
    await db.exec("CREATE TRIGGER bridge_projection_failure BEFORE INSERT ON cases BEGIN SELECT RAISE(ABORT, 'simulated projection outage'); END")
    await assert.rejects(bridge.humanEvent(human(snapshot.id, handoffId), 'haas'), /projection_failed/)
    assert.equal((await saved(snapshot.id)).requests.length, 1)
    assert.equal(events.length, 0)
    await db.exec('DROP TRIGGER bridge_projection_failure')
    await bridge.humanEvent(human(snapshot.id, handoffId), 'haas')
    assert.equal((await saved(snapshot.id)).requests.length, 1)
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', { text: 'Saved after recovery', language: 'en' }), 'haas')
    await bridge.cases.get(snapshot.id).deliveries.get(handoffId)
    assert.equal(events.length, 1)
  } finally {
    await db.exec('DROP TRIGGER IF EXISTS bridge_projection_failure')
    bridge.close()
  }
})

test('cancellation while a result waits in the Node queue invalidates the queued event', async () => {
  const { snapshot, proof } = await newCase()
  let release: ((value: { status: string }) => void) | undefined
  let arrived: (() => void) | undefined
  const waiting = new Promise<void>(resolve => { arrived = resolve })
  let received: CompletedEvent | undefined
  const { bridge } = adapter(event => {
    received = event
    arrived!()
    return new Promise(resolve => { release = resolve })
  })
  const handoffId = `handoff-${randomUUID()}`
  try {
    await bridge.attachCase(snapshot.id, proof)
    await bridge.humanEvent(human(snapshot.id, handoffId), 'haas')
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', { text: 'Queued answer', language: 'en' }), 'haas')
    await waiting
    const pending = bridge.cases.get(snapshot.id).deliveries.get(handoffId)
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.cancelled'), 'haas')
    assert.equal(received!.isValid(), false)
    release!({ status: 'live_submitted' })
    await pending
    const current = await saved(snapshot.id)
    assert.equal(current.requests[0].status, 'cancelled')
    assert.notEqual(current.requests[0].delivery?.status, 'live_submitted')
  } finally { release?.({ status: 'failed' }); bridge.close() }
})

test('Worker reserves delivery for one consumer and cannot rewind a terminal receipt', async () => {
  for (const terminal of ['live_submitted', 'failed'] as const) {
    const { snapshot } = await newCase('haas')
    const handoffId = `handoff-${randomUUID()}`
    let current = await readCase(await request(`/staff/cases/${snapshot.id}/handoffs`, {
      commandId: `register-${handoffId}`, expectedRevision: 0, nodeCaseId: snapshot.id, handoffId,
      route: 'haas', summary: 'An explicit HaaS request', task: 'Report tooling', targetRole: 'Engineer', expectedResult: 'Text answer',
    }, { staff: true }))
    const requestId = current.requests[0].id
    current = await readCase(await request(`/staff/requests/${requestId}/claim`, {
      caseId: snapshot.id, commandId: `claim-${handoffId}`, expectedRevision: current.revision,
    }, { staff: true }))
    current = await readCase(await request(`/staff/requests/${requestId}/answer`, {
      caseId: snapshot.id, commandId: `answer-${handoffId}`, expectedRevision: current.revision,
      result: { text: 'Mock answer', language: 'en' }, simulated: true,
    }, { staff: true }))
    const path = `/staff/cases/${snapshot.id}/handoffs/${handoffId}/delivery`
    const reservation = { commandId: `consumer-a-${handoffId}`, expectedRevision: current.revision, status: 'queued' }
    current = await readCase(await request(path, reservation, { staff: true }))
    const second = await request(path, { commandId: `consumer-b-${handoffId}`, expectedRevision: current.revision, status: 'queued' }, { staff: true })
    assert.equal(second.status, 409)
    assert.equal((await second.json() as { title: string }).title, 'delivery_in_progress')
    const replay = await readCase(await request(path, reservation, { staff: true }))
    assert.equal(replay.revision, current.revision)
    current = await readCase(await request(path, { commandId: `receipt-${handoffId}`, expectedRevision: current.revision, status: terminal }, { staff: true }))
    assert.equal(current.requests[0].delivery?.status, terminal)
    assert.equal((await request(path, { commandId: `rewind-${handoffId}`, expectedRevision: current.revision, status: 'queued' }, { staff: true })).status, 409)
    if (terminal === 'live_submitted') {
      const failure = await request(path, { commandId: `overwrite-${handoffId}`, expectedRevision: current.revision, status: 'failed' }, { staff: true })
      assert.equal(failure.status, 409)
      assert.equal((await failure.json() as { title: string }).title, 'already_delivered')
    }
    assert.equal((await saved(snapshot.id)).requests[0].delivery?.status, terminal)
  }
})


test('a lost durable reservation response resumes with the same command and never delivers twice', async () => {
  const { snapshot, proof } = await newCase('haas')
  const events: CompletedEvent[] = []
  const reservations: unknown[] = []
  let loseResponse = true
  const { bridge } = adapter(async event => { events.push(event); return { status: 'live_submitted' } }, (path, body) => {
    if (!path.endsWith('/delivery') || body.status !== 'queued') return
    reservations.push(body.commandId)
    if (loseResponse) { loseResponse = false; throw new Error('Synthetic lost response after durable reservation') }
  })
  const handoffId = `handoff-${randomUUID()}`
  try {
    await bridge.attachCase(snapshot.id, proof)
    await bridge.humanEvent(human(snapshot.id, handoffId), 'haas')
    await bridge.humanEvent(human(snapshot.id, handoffId, 'human.completed', { text: 'Saved before response loss', language: 'en' }), 'haas')
    const state = bridge.cases.get(snapshot.id)
    await state.deliveries.get(handoffId)
    assert.equal((await saved(snapshot.id)).requests[0].delivery?.status, 'queued')
    assert.equal(events.length, 0)
    await bridge.syncCase(snapshot.id, proof)
    await state.deliveries.get(handoffId)
    assert.equal(events.length, 1)
    assert.equal(reservations.length, 2)
    assert.equal(reservations[0], reservations[1])
    assert.equal((await saved(snapshot.id)).requests[0].delivery?.status, 'live_submitted')
    await bridge.syncCase(snapshot.id, proof)
    assert.equal(events.length, 1)
  } finally { bridge.close() }
})
