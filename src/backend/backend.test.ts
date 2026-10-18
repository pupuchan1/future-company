import { after as afterAll, before as beforeAll, test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import type { Actor, CaseSnapshot, Command } from './contracts'
import type { RoomResult } from './case-room'

function expect(actual: unknown) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toBeLessThan: (expected: number) => assert.ok(Number(actual) < expected),
    toBeGreaterThan: (expected: number) => assert.ok(Number(actual) > expected),
    toBeDefined: () => assert.notEqual(actual, undefined),
    toBeUndefined: () => assert.equal(actual, undefined),
    toHaveLength: (expected: number) => assert.equal((actual as unknown[]).length, expected),
    toContain: (expected: string) => assert.ok(String(actual).includes(expected)),
    not: {
      toContain: (expected: string) => assert.ok(!String(actual).includes(expected)),
      toMatch: (expected: RegExp) => assert.ok(!expected.test(String(actual)))
    }
  }
}

let mf: Miniflare
let cookie: string
let caseState: CaseSnapshot
const origin = 'http://localhost'
const staffHeaders = { 'x-test-staff': 'employee-a' }

async function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`${origin}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function readCase(response: Awaited<ReturnType<typeof request>>): Promise<CaseSnapshot> {
  const data = await response.json() as { case: CaseSnapshot }
  expect(response.status).toBeLessThan(300)
  expect(data.case).toBeDefined()
  return data.case
}

async function roomCall(caseId: string, actor: Actor, method: string, args: unknown[]): Promise<RoomResult> {
  const response = await mf.dispatchFetch(`${origin}/__integration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, actor, method, args }) })
  return response.json() as Promise<RoomResult>
}

function roomSnapshot(result: RoomResult): CaseSnapshot {
  assert.ok(result.ok, JSON.stringify(result))
  return result.snapshot
}

async function createRecruitment(commandId: string) {
  const response = await request('/cases', { commandId, expectedRevision: 0, kind: 'recruitment', locale: 'ja' })
  if (!cookie) cookie = response.headers.get('Set-Cookie')!.split(';')[0]
  const snapshot = await readCase(response)
  const actor: Actor = { role: 'visitor', ownerHash: createHash('sha256').update(cookie.split('=')[1]).digest('hex') }
  return { snapshot, actor }
}

async function roomCommand(state: CaseSnapshot, actor: Actor, commandId: string, command: Command): Promise<RoomResult> {
  return roomCall(state.id, actor, 'command', [actor, commandId, state.revision, command, '2026-10-18T05:00:00Z'])
}

beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `import {Hono} from 'hono'; import {createBackendApi,projectCase} from './src/backend/api'; import {CaseRoom as StoredCaseRoom} from './src/backend/case-room'; export class CaseRoom extends StoredCaseRoom { scheduledAlarm(){return this.ctx.storage.getAlarm()} } const app = new Hono(); app.route('/api/v1',createBackendApi({authorizeStaff:async request=>{const id=request.headers.get('x-test-staff');return id?{id}:null}})); app.route('/closed',createBackendApi()); app.post('/__integration',async c=>{const data=await c.req.json(); const room=c.env.CASES.getByName(data.caseId); const {actor}=data; const result=await room[data.method](...(data.args||[]));if(result?.ok)await projectCase(c.env,data.caseId,actor);return c.json(result)}); export default app;`, resolveDir: resolve('.') }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-backend', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-08-03', durableObjects: { CASES: { className: 'CaseRoom', useSQLite: true } }, d1Databases: ['DB'] }))
  const db = await mf.getD1Database('DB')
  const sql = await readFile('migrations/0001_company.sql', 'utf8')
  for (const statement of sql.split(';').filter((part) => part.trim())) await db.exec(statement.replaceAll('\n', ' '))
}, { timeout: 20000 })
afterAll(async () => { await mf?.dispose() })

test('create a case, enforce visitor ownership, and preserve idempotent creation', async () => {
  const response = await request('/cases', { commandId: 'create-1', expectedRevision: 0 })
  cookie = response.headers.get('Set-Cookie')!.split(';')[0]
  caseState = await readCase(response)
  expect(caseState.kind).toBe('support')
  const repeated = await readCase(await request('/cases', { commandId: 'create-1', expectedRevision: 0 }))
  expect(repeated.id).toBe(caseState.id)
  const otherResponse = await request('/cases', { commandId: 'create-other', expectedRevision: 0 }, { Cookie: '' })
  const otherCookie = otherResponse.headers.get('Set-Cookie')!.split(';')[0]
  expect((await request(`/cases/${caseState.id}`, undefined, { Cookie: otherCookie })).status).toBe(404)
  expect((await request(`/cases/${caseState.id}`, undefined, { Cookie: '' })).status).toBe(401)
  expect((await request('/cases', { commandId: 'create-1', expectedRevision: 0, kind: 'sales' })).status).toBe(409)
})

test('messages reject stale revisions, changed replays and cross-origin writes', async () => {
  const path = `/cases/${caseState.id}/messages`
  const command = { commandId: 'message-1', expectedRevision: caseState.revision, text: 'The light arrived broken. I need it for tomorrow.' }
  caseState = await readCase(await request(path, command))
  const repeat = await readCase(await request(path, command))
  expect(repeat.revision).toBe(caseState.revision)
  expect(repeat.messages).toHaveLength(1)
  expect((await request(path, { ...command, text: 'Different input' })).status).toBe(409)
  expect((await request(path, { ...command, commandId: 'new-but-stale' })).status).toBe(409)
  expect((await request(path, { ...command, commandId: 'cross-origin' }, { Origin: 'https://other.example' })).status).toBe(403)
})

test('order lookup requires proof and never invents a successful investigation', async () => {
  const failed = await request(`/cases/${caseState.id}/investigate`, { commandId: 'bad-order', expectedRevision: caseState.revision, reference: 'DEMO-1001', accessCode: 'wrong', urgent: true })
  expect(failed.status).toBe(404)
  caseState = await readCase(await request(`/cases/${caseState.id}`))
  expect(caseState.investigation?.status).toBe('failed')
  expect(caseState.facts).toHaveLength(0)
  const command = { commandId: 'investigate-1', expectedRevision: caseState.revision, reference: 'DEMO-1001', accessCode: 'demo-visitor', urgent: true }
  caseState = await readCase(await request(`/cases/${caseState.id}/investigate`, command))
  expect(caseState.status).toBe('awaiting_human')
  expect(caseState.requests).toHaveLength(1)
  expect(caseState.facts.length).toBeGreaterThan(0)
  const repeat = await readCase(await request(`/cases/${caseState.id}/investigate`, command))
  expect(repeat.revision).toBe(caseState.revision)
  expect(repeat.requests).toHaveLength(1)
})

test('staff claim is exclusive and only the assignee can answer; replay does not resume twice', async () => {
  const id = caseState.requests[0].id
  const command = { caseId: caseState.id, commandId: 'claim-1', expectedRevision: caseState.revision }
  expect((await request(`/staff/requests/${id}/claim`, command)).status).toBe(401)
  caseState = await readCase(await request(`/staff/requests/${id}/claim`, command, staffHeaders))
  expect(caseState.requests[0].assignedTo).toBe('employee-a')
  expect((await request(`/staff/requests/${id}/claim`, { ...command, commandId: 'claim-2', expectedRevision: caseState.revision }, { 'x-test-staff': 'employee-b' })).status).toBe(409)
  const answer = { caseId: caseState.id, commandId: 'answer-1', expectedRevision: caseState.revision, answer: 'One replacement is physically available. You can collect it today.', stockAvailable: true }
  expect((await request(`/staff/requests/${id}/answer`, answer, { 'x-test-staff': 'employee-b' })).status).toBe(409)
  caseState = await readCase(await request(`/staff/requests/${id}/answer`, answer, staffHeaders))
  expect(caseState.ai.status).toBe('resume_pending')
  const repeated = await readCase(await request(`/staff/requests/${id}/answer`, answer, staffHeaders))
  expect(repeated.revision).toBe(caseState.revision)
  expect(repeated.messages).toHaveLength(2)
  const publicCase = await readCase(await request(`/cases/${caseState.id}`))
  expect(publicCase.requests[0].assignedTo).toBeUndefined()
  expect(JSON.stringify(publicCase)).not.toContain('ownerHash')
  const list = await request('/staff/cases', undefined, staffHeaders)
  const result = await list.json() as { source: string; cases: { id: string; revision: number }[] }
  expect(result.source).toBe('d1_summary')
  expect(result.cases.find((item) => item.id === caseState.id)?.revision).toBe(caseState.revision)
})

test('WebSocket reconnect receives current persisted state and accepts only sync', async () => {
  const response = await mf.dispatchFetch(`${origin}/api/v1/cases/${caseState.id}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie, Origin: origin } })
  expect(response.status).toBe(101)
  const ws = response.webSocket!
  const messages: { type: string; snapshot?: CaseSnapshot; code?: string }[] = []
  const firstMessage = new Promise<void>((resolve) => ws.addEventListener('message', (event) => { messages.push(JSON.parse(String(event.data))); resolve() }))
  ws.accept()
  await firstMessage
  expect(messages[0].type).toBe('case.snapshot')
  expect(messages[0].snapshot?.revision).toBe(caseState.revision)
  const rejected = new Promise<void>((resolve) => ws.addEventListener('message', () => resolve(), { once: true }))
  ws.send('{"type":"claim"}')
  await rejected
  expect(messages.at(-1)?.code).toBe('use_http_commands')
  ws.close(1000, 'Test complete')
  const second = await mf.dispatchFetch(`${origin}/api/v1/cases/${caseState.id}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie, Origin: origin } })
  const reconnect = second.webSocket!
  const snapshot = new Promise<CaseSnapshot>((resolve) => reconnect.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)).snapshot), { once: true }))
  reconnect.accept()
  expect((await snapshot).revision).toBe(caseState.revision)
  reconnect.close(1000, 'Test complete')
})

test('confirmed exchange is a single D1 business record and resolves the case', async () => {
  const command = { commandId: 'replace-1', expectedRevision: caseState.revision }
  caseState = await readCase(await request(`/cases/${caseState.id}/replacements`, command))
  expect(caseState.status).toBe('resolved')
  const repeated = await readCase(await request(`/cases/${caseState.id}/replacements`, command))
  expect(repeated.revision).toBe(caseState.revision)
  const db = await mf.getD1Database('DB')
  const count = await db.prepare('SELECT COUNT(*) AS count FROM replacements WHERE case_id=?').bind(caseState.id).first<{ count: number }>()
  expect(count?.count).toBe(1)
})

test('unconfigured staff auth fails closed and no periodic wakeup code exists', async () => {
  const source = await readFile('src/backend/case-room.ts', 'utf8')
  expect(source).not.toMatch(/setInterval|setTimeout|setAlarm|async alarm/)
  const apiSource = await readFile('src/backend/api.ts', 'utf8')
  expect(apiSource).toContain("staff_auth_unconfigured")
  const capabilities = await request('/capabilities')
  const result = await capabilities.json() as { voice: { available: boolean }; agent: { available: boolean } }
  expect(result.voice.available).toBe(false)
  expect(result.agent.available).toBe(false)
  const closed = await mf.dispatchFetch(`${origin}/closed/staff/cases`)
  expect(closed.status).toBe(503)
  expect((await closed.json() as { title: string }).title).toBe('staff_auth_unconfigured')
})

test('provider session completion survives a concurrent message and session creation cannot loop', async () => {
  const created = await request('/cases', { commandId: 'integration-case', expectedRevision: 0 })
  let state = await readCase(created)
  const token = cookie.split('=')[1]
  const actor = { role: 'visitor', ownerHash: createHash('sha256').update(token).digest('hex') }
  async function integration(method: string, args: unknown[]) {
    const response = await mf.dispatchFetch(`${origin}/__integration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: state.id, actor, method, args }) })
    return response.json() as Promise<{ ok: boolean; code?: string; snapshot: CaseSnapshot; integration?: { agentSessionId?: string }; operation?: { status: string; sessionId?: string } }>
  }
  const first = await integration('reserveIntegration', [actor, 'agent-create', state.revision, 'agent', 'context-fingerprint'])
  expect(first.operation?.status).toBe('reserved')
  state = first.snapshot
  const replay = await integration('reserveIntegration', [actor, 'agent-create', 0, 'agent', 'context-fingerprint'])
  expect(replay.operation?.status).toBe('pending')
  expect(replay.snapshot.revision).toBe(state.revision)
  const concurrent = await integration('reserveIntegration', [actor, 'other-agent-create', state.revision, 'agent', 'different-context'])
  expect(concurrent.code).toBe('integration_in_progress')
  state = await readCase(await request(`/cases/${state.id}/messages`, { commandId: 'during-provider-create', expectedRevision: state.revision, text: 'I also have a question about the product.' }))
  const completed = await integration('completeIntegration', [actor, 'agent-create', { sessionId: 'agent-session-1', agentStatus: 'in_progress' }])
  expect(completed.ok).toBe(true)
  state = completed.snapshot
  const saved = await integration('getIntegration', [actor])
  expect(saved.integration?.agentSessionId).toBe('agent-session-1')
  expect(JSON.stringify(await readCase(await request(`/cases/${state.id}`)))).not.toContain('agent-session-1')
  const db = await mf.getD1Database('DB')
  const mapping = await db.prepare("SELECT id FROM cases WHERE json_extract(summary,'$.integration.agentSessionId')=?").bind('agent-session-1').first<{ id: string }>()
  expect(mapping?.id).toBe(state.id)
  const overwrite = await integration('reserveIntegration', [actor, 'new-agent', state.revision, 'agent', 'other'])
  expect(overwrite.code).toBe('integration_exists')
  const event = await integration('recordAgentEvent', ['agent-session-1', 'event-1', { status: 'idle', turnOutcome: 'completed' }])
  const duplicate = await integration('recordAgentEvent', ['agent-session-1', 'event-1', { status: 'idle', turnOutcome: 'completed' }])
  expect(duplicate.snapshot.revision).toBe(event.snapshot.revision)
  const stale = await integration('recordAgentEvent', ['old-session', 'event-2', { status: 'idle' }])
  expect(stale.code).toBe('stale_agent_session')
  state = event.snapshot
  const reserveLive = await integration('reserveIntegration', [actor, 'live-timeout', state.revision, 'live', 'sdp-fingerprint'])
  expect(reserveLive.operation?.status).toBe('reserved')
  await integration('failIntegration', [actor, 'live-timeout', 'provider_outcome_unknown'])
  const retry = await integration('reserveIntegration', [actor, 'live-timeout', state.revision, 'live', 'sdp-fingerprint'])
  expect(retry.operation?.status).toBe('failed')
})

test('recruitment intake persists self-reported information and an existing human request atomically', async () => {
  const { snapshot: state, actor } = await createRecruitment('recruitment-create')
  const command = { type: 'submit_recruitment', roleInterest: 'バックエンドエンジニア', experience: 'TypeScriptでAPI開発を3年', questions: ['勤務時間を教えてください', 'Can I work remotely?'] }
  const args = [actor, 'recruitment-submit', 0, command, '2026-10-18T05:00:00Z']
  const simultaneous = await Promise.all([roomCall(state.id, actor, 'command', args), roomCall(state.id, actor, 'command', args)])
  const submitted = roomSnapshot(simultaneous[0])
  assert.deepEqual(roomSnapshot(simultaneous[1]), submitted)
  assert.deepEqual(submitted.recruitment, { roleInterest: command.roleInterest, experience: command.experience, questions: command.questions, source: 'visitor_self_report', submittedAt: '2026-10-18T05:00:00Z' })
  assert.equal(submitted.revision, 1)
  assert.equal(submitted.status, 'awaiting_human')
  assert.equal(submitted.ai.status, 'awaiting_human')
  assert.equal(submitted.requests.length, 1)
  assert.equal(submitted.requests[0].status, 'pending')
  assert.ok(submitted.facts.every(fact => fact.source === 'visitor_self_report'))
  assert.deepEqual(submitted.requests[0].facts, submitted.facts)
  assert.deepEqual(roomSnapshot(await roomCall(state.id, actor, 'command', args)), submitted)
  const alarm = await mf.dispatchFetch(`${origin}/__integration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: state.id, actor, method: 'scheduledAlarm' }) })
  assert.equal(await alarm.json(), null)
  const changed = await roomCall(state.id, actor, 'command', [actor, 'recruitment-submit', 0, { ...command, experience: 'changed' }, state.updatedAt])
  assert.ok(!changed.ok)
  assert.equal(changed.code, 'idempotency_conflict')
  const stale = await roomCall(state.id, actor, 'command', [actor, 'recruitment-stale', 0, command, state.updatedAt])
  assert.ok(!stale.ok)
  assert.equal(stale.code, 'revision_conflict')
  await mf.unsafeEvictDurableObject('test-backend', 'CaseRoom', { name: state.id })
  assert.deepEqual(roomSnapshot(await roomCall(state.id, actor, 'snapshot', [actor])), submitted)
  assert.deepEqual(roomSnapshot(await roomCall(state.id, actor, 'command', args)), submitted)
})

test('recruitment claims are exclusive and only assigned staff can answer without stock', async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-claim-create')
  let state = roomSnapshot(await roomCommand(snapshot, actor, 'submit', { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: [] }))
  const requestId = state.requests[0].id
  const first: Actor = { role: 'staff', id: 'recruiter-a' }
  const second: Actor = { role: 'staff', id: 'recruiter-b' }
  const claims = await Promise.all([roomCommand(state, first, 'claim-a', { type: 'claim', requestId }), roomCommand(state, second, 'claim-b', { type: 'claim', requestId })])
  assert.equal(claims.filter(result => result.ok).length, 1)
  const rejectedClaim = claims.find(result => !result.ok)!
  assert.ok(!rejectedClaim.ok)
  assert.equal(rejectedClaim.code, 'revision_conflict')
  const winner = claims[0].ok ? first : second
  const loser = claims[0].ok ? second : first
  state = roomSnapshot(claims.find(result => result.ok)!)
  const claimAgain = await roomCommand(state, loser, 'claim-again', { type: 'claim', requestId })
  assert.ok(!claimAgain.ok)
  assert.equal(claimAgain.code, 'already_claimed')
  const answer: Command = { type: 'answer', requestId, answer: '面談内容を確認しました。次回の日程をご案内します。' }
  const unauthorized = await roomCommand(state, loser, 'answer-other', answer)
  assert.ok(!unauthorized.ok)
  assert.equal(unauthorized.code, 'claim_required')
  const visitor = await roomCommand(state, actor, 'visitor-answer', answer)
  assert.ok(!visitor.ok)
  assert.equal(visitor.code, 'staff_required')
  const staleAnswer = await roomCall(state.id, winner, 'command', [winner, 'answer-stale', state.revision - 1, answer, state.updatedAt])
  assert.ok(!staleAnswer.ok)
  assert.equal(staleAnswer.code, 'revision_conflict')
  const answered = roomSnapshot(await roomCommand(state, winner, 'answer', answer))
  assert.equal(answered.requests[0].answer, answer.answer)
  assert.equal(answered.requests[0].stockAvailable, undefined)
  assert.equal(answered.requests[0].result, undefined)
  assert.equal(answered.requests[0].simulated, undefined)
  assert.equal(answered.requests[0].status, 'answered')
  assert.equal(answered.ai.status, 'resume_pending')
  assert.equal(answered.status, 'ready')
  assert.equal(answered.proposal?.canReplace, false)
  assert.deepEqual(roomSnapshot(await roomCommand(state, winner, 'answer', answer)), answered)
  assert.equal(answered.messages.length, 1)
  const publicCase = roomSnapshot(await roomCall(state.id, actor, 'snapshot', [actor]))
  assert.equal(publicCase.requests[0].assignedTo, undefined)
  assert.ok(!JSON.stringify(publicCase).includes('ownerHash'))
})

test('agent events cannot replace staff waiting or mark a staff answer as resumed', async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-agent-wait-create')
  let state = roomSnapshot(await roomCall(snapshot.id, actor, 'reserveIntegration', [actor, 'agent', snapshot.revision, 'agent', 'recruitment-context']))
  state = roomSnapshot(await roomCall(state.id, actor, 'completeIntegration', [actor, 'agent', { sessionId: 'recruitment-agent-wait', agentStatus: 'in_progress' }]))
  state = roomSnapshot(await roomCommand(state, actor, 'submit', { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: ['What tools does the team use?'] }))
  const waiting = state.ai
  const requestId = state.requests[0].id
  state = roomSnapshot(await roomCall(state.id, actor, 'recordAgentEvent', ['recruitment-agent-wait', 'finished-intake', { status: 'idle', turnOutcome: 'completed' }]))
  assert.deepEqual(state.ai, waiting)
  assert.equal(state.status, 'awaiting_human')
  assert.equal(state.requests[0].status, 'pending')
  assert.equal(state.requests[0].answer, undefined)
  const staff: Actor = { role: 'staff', id: 'recruiter' }
  state = roomSnapshot(await roomCommand(state, staff, 'claim', { type: 'claim', requestId }))
  const claimed = state
  const answer: Command = { type: 'answer', requestId, answer: 'We use TypeScript.', answerLanguage: 'en', simulated: false }
  state = roomSnapshot(await roomCommand(state, staff, 'answer', answer))
  assert.equal(state.ai.status, 'resume_pending')
  const resumePending = state.ai
  for (const [eventId, status, turnOutcome] of [['old-turn', 'idle', 'completed'], ['running', 'in_progress', undefined], ['failed-turn', 'failed', 'failed']]) {
    state = roomSnapshot(await roomCall(state.id, actor, 'recordAgentEvent', ['recruitment-agent-wait', eventId, { status, turnOutcome }]))
    assert.deepEqual(state.ai, resumePending)
    assert.equal(state.requests[0].answer, 'We use TypeScript.')
    assert.equal(state.messages.length, 1)
  }
  await roomCommand(claimed, staff, 'answer', answer)
  assert.deepEqual(roomSnapshot(await roomCall(state.id, staff, 'snapshot', [staff])), state)
  const alarm = await mf.dispatchFetch(`${origin}/__integration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: state.id, actor, method: 'scheduledAlarm' }) })
  assert.equal(await alarm.json(), null)
})

test('recruitment commands reject other owners, staff submissions and other case kinds', async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-permissions-create')
  const command: Command = { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: [] }
  const outsider: Actor = { role: 'visitor', ownerHash: 'another-owner' }
  const forbidden = await roomCommand(snapshot, outsider, 'submit', command)
  assert.ok(!forbidden.ok)
  assert.equal(forbidden.code, 'case_not_found')
  const staff = await roomCommand(snapshot, { role: 'staff', id: 'employee-a' }, 'submit', command)
  assert.ok(!staff.ok)
  assert.equal(staff.code, 'visitor_required')
  const support = await readCase(await request('/cases', { commandId: 'support-kind-check', expectedRevision: 0 }))
  const wrongKind = await roomCommand(support, actor, 'submit', command)
  assert.ok(!wrongKind.ok)
  assert.equal(wrongKind.code, 'case_kind_mismatch')
  assert.equal(roomSnapshot(await roomCall(support.id, actor, 'snapshot', [actor])).revision, 0)
  const saved = roomSnapshot(await roomCommand(snapshot, actor, 'submit', command))
  const replayByOther = await roomCall(saved.id, outsider, 'command', [outsider, 'submit', 0, command, snapshot.updatedAt])
  assert.ok(!replayByOther.ok)
  assert.equal(replayByOther.code, 'case_not_found')
})

test('order exchange answers still require a boolean stock result at the DO boundary', async () => {
  let state = await readCase(await request('/cases', { commandId: 'stock-validation-create', expectedRevision: 0 }))
  const actor: Actor = { role: 'visitor', ownerHash: createHash('sha256').update(cookie.split('=')[1]).digest('hex') }
  state = roomSnapshot(await roomCommand(state, actor, 'begin', { type: 'begin_investigation', investigationId: 'stock-check', inputHash: 'stock-input' }))
  state = roomSnapshot(await roomCommand(state, actor, 'result', { type: 'investigation_result', investigationId: 'stock-check', orderId: 'order-1', facts: [], requiresHuman: true, summary: 'Check stock', proposal: 'Pending', canReplace: false }))
  const staff: Actor = { role: 'staff', id: 'stock-employee' }
  const requestId = state.requests[0].id
  state = roomSnapshot(await roomCommand(state, staff, 'claim', { type: 'claim', requestId }))
  const missing = await roomCommand(state, staff, 'answer', { type: 'answer', requestId, answer: 'Checked.' })
  assert.ok(!missing.ok)
  assert.equal(missing.code, 'invalid_input')
  for (const stockAvailable of [null, 'false', 0]) {
    const invalid = await roomCall(state.id, staff, 'command', [staff, 'answer', state.revision, { type: 'answer', requestId, answer: 'Checked.', stockAvailable }, state.updatedAt])
    assert.ok(!invalid.ok)
    assert.equal(invalid.code, 'invalid_input')
  }
  assert.equal(roomSnapshot(await roomCall(state.id, staff, 'snapshot', [staff])).revision, state.revision)
  const answered = roomSnapshot(await roomCommand(state, staff, 'answer', { type: 'answer', requestId, answer: 'No replacement available.', stockAvailable: false }))
  assert.equal(answered.requests[0].stockAvailable, false)
  assert.equal(answered.proposal?.canReplace, false)
})

test('updated recruitment intake supersedes pending staff work and cannot enable an exchange', async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-update-create')
  const intake: Command = { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: [] }
  let state = roomSnapshot(await roomCommand(snapshot, actor, 'submit-first', intake))
  const oldRequestId = state.requests[0].id
  const staff: Actor = { role: 'staff', id: 'recruiter' }
  state = roomSnapshot(await roomCommand(state, staff, 'claim-first', { type: 'claim', requestId: oldRequestId }))
  state = roomSnapshot(await roomCommand(state, actor, 'submit-updated', { ...intake, experience: 'API and database development' }))
  assert.equal(state.requests[0].status, 'cancelled')
  assert.equal(state.requests[1].status, 'pending')
  assert.equal(state.recruitment?.experience, 'API and database development')
  const staleAnswer = await roomCommand(state, staff, 'answer-first', { type: 'answer', requestId: oldRequestId, answer: 'Outdated response' })
  assert.ok(!staleAnswer.ok)
  assert.equal(staleAnswer.code, 'claim_required')
  const requestId = state.requests[1].id
  state = roomSnapshot(await roomCommand(state, staff, 'claim-updated', { type: 'claim', requestId }))
  state = roomSnapshot(await roomCommand(state, staff, 'answer-updated', { type: 'answer', requestId, answer: 'Thanks for the update.', stockAvailable: true }))
  assert.equal(state.requests[1].stockAvailable, undefined)
  assert.equal(state.proposal?.canReplace, false)
})

test('recruitment WebSockets restore actor attachments after hibernation and reconnect to the latest answer', { timeout: 15000 }, async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-ws-create')
  let state = snapshot
  for (const kind of ['live', 'agent'] as const) {
    state = roomSnapshot(await roomCall(state.id, actor, 'reserveIntegration', [actor, `private-${kind}`, state.revision, kind, `private-${kind}-fingerprint`]))
    state = roomSnapshot(await roomCall(state.id, actor, 'completeIntegration', [actor, `private-${kind}`, { sessionId: `private-${kind}-session`, ...(kind === 'live' ? { sdp: 'private-sdp' } : { agentStatus: 'idle' }) }]))
  }
  state = await readCase(await request(`/cases/${snapshot.id}/recruitment/submit`, { commandId: 'submit', expectedRevision: state.revision, roleInterest: 'Engineer', experience: 'API development', questions: [] }))
  const requestId = state.requests[0].id
  const staff: Actor = { role: 'staff', id: 'employee-a' }
  const visitorResponse = await mf.dispatchFetch(`${origin}/api/v1/cases/${state.id}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie, Origin: origin } })
  const staffResponse = await mf.dispatchFetch(`${origin}/api/v1/staff/cases/${state.id}/ws`, { headers: { Upgrade: 'websocket', ...staffHeaders, Origin: origin } })
  assert.equal(visitorResponse.status, 101)
  assert.equal(staffResponse.status, 101)
  const visitorWs = visitorResponse.webSocket!
  const staffWs = staffResponse.webSocket!
  function nextSnapshot(ws: typeof visitorWs): Promise<CaseSnapshot> {
    return new Promise(resolve => ws.addEventListener('message', event => resolve(JSON.parse(String(event.data)).snapshot), { once: true }))
  }
  try {
    const initials = [nextSnapshot(visitorWs), nextSnapshot(staffWs)]
    visitorWs.accept()
    staffWs.accept()
    await Promise.all(initials)
    await mf.unsafeEvictDurableObject('test-backend', 'CaseRoom', { name: state.id, webSockets: 'hibernate' })
    const restored = nextSnapshot(visitorWs)
    visitorWs.send('sync')
    const restoredSnapshot = await restored
    assert.equal(restoredSnapshot.revision, state.revision)
    assert.ok(!JSON.stringify(restoredSnapshot).includes('private-'))
    const claimed = [nextSnapshot(visitorWs), nextSnapshot(staffWs)]
    state = roomSnapshot(await roomCommand(state, staff, 'claim', { type: 'claim', requestId }))
    const [publicClaim, staffClaim] = await Promise.all(claimed)
    assert.equal(publicClaim.requests[0].assignedTo, undefined)
    assert.equal(staffClaim.requests[0].assignedTo, 'employee-a')
    const updates = [nextSnapshot(visitorWs), nextSnapshot(staffWs)]
    state = await readCase(await request(`/staff/requests/${requestId}/answer`, { caseId: state.id, commandId: 'answer', expectedRevision: state.revision, answer: 'We will arrange a follow-up interview.' }, staffHeaders))
    const [publicAnswer, staffAnswer] = await Promise.all(updates)
    assert.equal(publicAnswer.revision, state.revision)
    assert.equal(publicAnswer.ai.status, 'resume_pending')
    assert.equal(publicAnswer.requests[0].answer, 'We will arrange a follow-up interview.')
    assert.equal(publicAnswer.requests[0].assignedTo, undefined)
    assert.equal(staffAnswer.requests[0].assignedTo, 'employee-a')
    assert.ok(!JSON.stringify(publicAnswer).includes('ownerHash'))
    assert.ok(!JSON.stringify(publicAnswer).includes('integration'))
    assert.ok(!JSON.stringify(publicAnswer).includes('private-'))
    assert.ok(!JSON.stringify(staffAnswer).includes('private-'))
  } finally {
    visitorWs.close(1000, 'Test complete')
    staffWs.close(1000, 'Test complete')
  }
  await mf.unsafeEvictDurableObject('test-backend', 'CaseRoom', { name: state.id })
  const reconnected = await mf.dispatchFetch(`${origin}/api/v1/cases/${state.id}/ws`, { headers: { Upgrade: 'websocket', Cookie: cookie, Origin: origin } })
  const ws = reconnected.webSocket!
  try {
    const latest = nextSnapshot(ws)
    ws.accept()
    assert.deepEqual(await latest, roomSnapshot(await roomCall(state.id, actor, 'snapshot', [actor])))
  } finally { ws.close(1000, 'Test complete') }
  assert.equal((await mf.dispatchFetch(`${origin}/api/v1/cases/${state.id}/ws`, { headers: { Upgrade: 'websocket', Cookie: '', Origin: origin } })).status, 401)
})

test('a simulated human answer keeps its text and language bound to the original recruitment case and handoff', async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-human-result-create')
  let state = roomSnapshot(await roomCall(snapshot.id, actor, 'reserveIntegration', [actor, 'original-agent', snapshot.revision, 'agent', 'recruitment-context']))
  state = roomSnapshot(await roomCall(snapshot.id, actor, 'completeIntegration', [actor, 'original-agent', { sessionId: 'original-recruiting-session' }]))
  state = roomSnapshot(await roomCommand(state, actor, 'submit', { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: ['現場の開発環境を教えてください'] }))
  const requestId = state.requests[0].id
  const staff: Actor = { role: 'staff', id: 'demo-staff' }
  assert.ok(requestId.includes(state.id))
  assert.ok(state.requests[0].question.includes('現場の開発環境を教えてください'))
  state = roomSnapshot(await roomCommand(state, staff, 'claim', { type: 'claim', requestId }))
  const answer = { type: 'answer', requestId, answer: '[Simulated] Our demo team uses TypeScript and VS Code.', answerLanguage: 'en', simulated: true }
  const args = [staff, 'human-result', state.revision, answer, state.updatedAt]
  const answered = roomSnapshot(await roomCall(state.id, staff, 'command', args))
  assert.equal(answered.id, snapshot.id)
  assert.equal(answered.locale, 'ja')
  assert.equal(answered.requests[0].id, requestId)
  assert.deepEqual(answered.requests[0].result, { text: answer.answer, language: 'en' })
  assert.equal(answered.requests[0].simulated, true)
  assert.equal(answered.ai.status, 'resume_pending')
  assert.equal(answered.messages.at(-1)?.text, answer.answer)
  assert.deepEqual(roomSnapshot(await roomCall(state.id, staff, 'command', args)), answered)
  const changedResult = await roomCall(state.id, staff, 'command', [staff, 'human-result', state.revision, { ...answer, answerLanguage: 'ja' }, state.updatedAt])
  assert.ok(!changedResult.ok)
  assert.equal(changedResult.code, 'idempotency_conflict')
  await mf.unsafeEvictDurableObject('test-backend', 'CaseRoom', { name: state.id })
  const reloaded = roomSnapshot(await roomCall(state.id, actor, 'snapshot', [actor]))
  assert.deepEqual(reloaded.requests[0].result, answered.requests[0].result)
  assert.equal(reloaded.requests[0].simulated, true)
  const integrationResponse = await mf.dispatchFetch(`${origin}/__integration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId: state.id, actor, method: 'getIntegration', args: [actor] }) })
  const savedIntegration = await integrationResponse.json() as { integration: { agentSessionId: string } }
  assert.equal(savedIntegration.integration.agentSessionId, 'original-recruiting-session')
  assert.ok(!JSON.stringify(reloaded).includes('original-recruiting-session'))
  const db = await mf.getD1Database('DB')
  const row = await db.prepare('SELECT summary FROM cases WHERE id=?').bind(state.id).first<{ summary: string }>()
  const persisted = JSON.parse(row!.summary) as CaseSnapshot
  assert.deepEqual(persisted.requests[0].result, answered.requests[0].result)
  assert.equal(persisted.requests[0].simulated, true)
  const other = await createRecruitment('recruitment-other-handoff')
  const otherSubmitted = roomSnapshot(await roomCommand(other.snapshot, other.actor, 'submit', { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: [] }))
  assert.notEqual(otherSubmitted.requests[0].id, requestId)
  const mismatched = await roomCall(otherSubmitted.id, staff, 'command', [staff, 'wrong-case-result', otherSubmitted.revision, answer, otherSubmitted.updatedAt])
  assert.ok(!mismatched.ok)
  assert.equal(mismatched.code, 'request_not_found')
})

test('handoff results reject missing text or provenance without turning a status into an answer', async () => {
  const { snapshot, actor } = await createRecruitment('recruitment-invalid-result-create')
  let state = roomSnapshot(await roomCommand(snapshot, actor, 'submit', { type: 'submit_recruitment', roleInterest: 'Engineer', experience: 'API development', questions: [] }))
  const requestId = state.requests[0].id
  const staff: Actor = { role: 'staff', id: 'demo-staff' }
  state = roomSnapshot(await roomCommand(state, staff, 'claim', { type: 'claim', requestId }))
  const cases = [
    { answer: 'Checked.', answerLanguage: 'en' },
    { answer: 'Checked.', simulated: true },
    { answer: 'Checked.', answerLanguage: 'fr', simulated: false },
    { answer: '', answerLanguage: 'ja', simulated: true },
    { answer: '   ', answerLanguage: 'ja', simulated: true },
    { answer: 'x'.repeat(4001), answerLanguage: 'ja', simulated: true },
    { answer: '' }, { answer: '   ' },
    ...['ringing', 'accepted', 'completed'].map(status => ({ status })),
    ...['ringing', 'accepted', 'completed'].map(status => ({ status, answerLanguage: 'ja', simulated: true }))
  ]
  for (const invalid of cases) {
    const result = await roomCall(state.id, staff, 'command', [staff, 'result', state.revision, { type: 'answer', requestId, ...invalid }, state.updatedAt])
    assert.ok(!result.ok)
    assert.equal(result.code, 'invalid_input')
  }
  const pending = roomSnapshot(await roomCall(state.id, actor, 'snapshot', [actor]))
  assert.equal(pending.revision, state.revision)
  assert.equal(pending.requests[0].status, 'claimed')
  assert.equal(pending.requests[0].result, undefined)
  assert.equal(pending.ai.status, 'awaiting_human')
  const confirmed = roomSnapshot(await roomCall(state.id, staff, 'command', [staff, 'result', state.revision, { type: 'answer', requestId, answer: ' 開発端末はMacです。 ', answerLanguage: 'ja', simulated: false }, state.updatedAt]))
  assert.deepEqual(confirmed.requests[0].result, { text: '開発端末はMacです。', language: 'ja' })
  assert.equal(confirmed.requests[0].answer, '開発端末はMacです。')
  assert.equal(confirmed.requests[0].simulated, false)
})

test('mounted API preserves a simulated answer text, language and provenance through DO and D1', { timeout: 20000 }, async () => {
  const staffToken = randomBytes(32).toString('hex')
  const bundle = await build({ entryPoints: ['src/index.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', jsxImportSource: 'hono/jsx', external: ['cloudflare:workers'], define: { 'import.meta.env.PROD': 'true' } })
  const runtime = new Miniflare(convertV4MiniflareOptions({ name: 'test-result-api', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-08-03', durableObjects: { CASES: { className: 'CaseRoom', useSQLite: true } }, d1Databases: ['DB'], bindings: { STAFF_API_TOKEN: staffToken }, outboundService: () => new Response('External providers are disabled in this test.', { status: 502 }) }))
  async function api(path: string, body?: unknown, sessionCookie = '', extraHeaders: Record<string, string> = {}) {
    return runtime.dispatchFetch(`${origin}/api/v1${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: sessionCookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function snapshot(response: Awaited<ReturnType<typeof api>>): Promise<CaseSnapshot> {
    const data = await response.json() as { case?: CaseSnapshot; title?: string }
    assert.ok(response.ok, `HTTP ${response.status}: ${data.title}`)
    assert.ok(data.case)
    return data.case
  }
  try {
    const db = await runtime.getD1Database('DB')
    for (const file of ['migrations/0001_company.sql', 'migrations/0002_mcp_events.sql']) {
      const sql = await readFile(file, 'utf8')
      for (const statement of sql.split(';').filter(part => part.trim())) await db.exec(statement.replaceAll('\n', ' '))
    }
    const created = await api('/cases', { commandId: 'result-api-create', expectedRevision: 0, kind: 'recruitment', locale: 'ja' })
    const visitorCookie = created.headers.get('Set-Cookie')!.split(';')[0]
    let state = await snapshot(created)
    state = await snapshot(await api(`/cases/${state.id}/recruitment/submit`, { commandId: 'result-api-submit', expectedRevision: state.revision, roleInterest: 'Engineer', experience: 'API development', questions: ['現場の開発環境を教えてください'] }, visitorCookie))
    const requestId = state.requests[0].id
    const login = await api('/staff/session', {}, '', { Authorization: `Bearer ${staffToken}` })
    assert.equal(login.status, 200)
    const staffCookie = login.headers.get('Set-Cookie')!.split(';')[0]
    state = await snapshot(await api(`/staff/requests/${requestId}/claim`, { caseId: state.id, commandId: 'result-api-claim', expectedRevision: state.revision }, staffCookie))
    const result = { text: '[Simulated] Our demo team uses TypeScript and VS Code.', language: 'en' }
    const command = { caseId: state.id, commandId: 'result-api-answer', expectedRevision: state.revision, result, simulated: true }
    state = await snapshot(await api(`/staff/requests/${requestId}/answer`, command, staffCookie))
    function checkResult(saved: CaseSnapshot): void {
      assert.equal(saved.id, command.caseId)
      assert.equal(saved.locale, 'ja')
      assert.equal(saved.revision, state.revision)
      assert.equal(saved.ai.status, 'resume_pending')
      assert.equal(saved.requests[0].id, requestId)
      assert.equal(saved.requests[0].answer, result.text)
      assert.deepEqual(saved.requests[0].result, result)
      assert.equal(saved.requests[0].simulated, true)
    }
    checkResult(state)
    checkResult(await snapshot(await api(`/cases/${state.id}`, undefined, visitorCookie)))
    const persisted = await db.prepare('SELECT summary FROM cases WHERE id=?').bind(state.id).first<{ summary: string }>()
    assert.ok(persisted)
    checkResult(JSON.parse(persisted.summary) as CaseSnapshot)
    await runtime.unsafeEvictDurableObject('test-result-api', 'CaseRoom', { name: state.id })
    const reloaded = await snapshot(await api(`/cases/${state.id}`, undefined, visitorCookie))
    checkResult(reloaded)
    assert.equal(reloaded.requests[0].assignedTo, undefined)
    assert.ok(!JSON.stringify(reloaded).includes('ownerHash'))
    const replay = await snapshot(await api(`/staff/requests/${requestId}/answer`, command, staffCookie))
    checkResult(replay)
    assert.equal(replay.messages.length, 1)
    const list = await api('/staff/cases', undefined, staffCookie)
    assert.equal(list.status, 200)
    const listed = await list.json() as { cases: CaseSnapshot[] }
    checkResult(listed.cases.find(item => item.id === state.id)!)
  } finally { await runtime.dispose() }
})
