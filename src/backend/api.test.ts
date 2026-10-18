import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CaseSnapshot } from './contracts'

let mf: Miniflare
const origin = 'http://localhost'
const staffToken = 'test-only-demo-credential-0123456789'
const providerRequests: { sessionId: string; body: unknown }[] = []
let providerGate: { entered: () => void; released: Promise<void> } | undefined

before(async () => {
  const bundle = await build({ stdin: { contents: `
    import { Hono } from 'hono';
    import { authorizeVisitorCase, createBackendApi, projectCase } from './src/backend/api';
    import { authorizeDemoStaff } from './src/backend/auth';
    import { createOpenAIApi } from './src/backend/openai';
    export { CaseRoom } from './src/backend/case-room';
    const app = new Hono();
    app.route('/api/v1', createBackendApi({ authorizeStaff: async (request, env) => {
      const id = request.headers.get('x-test-staff');
      return id ? { id } : authorizeDemoStaff(request, env);
    } }));
    app.route('/api/v1', createOpenAIApi({ authorizeCase: authorizeVisitorCase, projectCase,
      agentTools: async () => [{ type: 'function', name: 'read_case', parameters: { type: 'object', properties: {} } }],
    }));
    app.route('/closed', createBackendApi());
    export default app;
  `, resolveDir: resolve('.') }, bundle: true, write: false, format: 'esm', platform: 'browser', external: ['cloudflare:workers'] })
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-api', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-08-03',
    bindings: { STAFF_API_TOKEN: staffToken, OPENAI_API_KEY: 'test-only-provider-key', OPENAI_AGENTS_MODEL: 'test-only-model' },
    durableObjects: { CASES: { className: 'CaseRoom', useSQLite: true } }, d1Databases: ['DB'],
    outboundService: async (request) => {
      assert.equal(request.url, 'https://api.openai.com/v1/agents/sessions')
      assert.equal(request.method, 'POST')
      const sessionId = `agent-test-${providerRequests.length + 1}`
      providerRequests.push({ sessionId, body: await request.json() })
      const gate = providerGate
      providerGate = undefined
      gate?.entered()
      await gate?.released
      return Response.json({ id: sessionId, status: 'in_progress' })
    },
  }))
  const db = await mf.getD1Database('DB')
  for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of (await readFile(`migrations/${file}`, 'utf8')).split(';').filter((part) => part.trim())) await db.exec(sql.replaceAll('\n', ' '))
  }
}, { timeout: 20000 })
after(async () => { await mf?.dispose() })

function request(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return mf.dispatchFetch(`${origin}${path.startsWith('/closed') ? path : `/api/v1${path}`}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function snapshot(response: Awaited<ReturnType<typeof request>>): Promise<CaseSnapshot> {
  const data = await response.json() as { case: CaseSnapshot }
  assert.ok(response.status < 300, JSON.stringify(data))
  return data.case
}
async function create(kind = 'recruitment') {
  const response = await request('/cases', { commandId: crypto.randomUUID(), expectedRevision: 0, kind, locale: 'ja' })
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0]
  assert.match(response.headers.get('Set-Cookie')!, /HttpOnly/i)
  assert.match(response.headers.get('Set-Cookie')!, /SameSite=Strict/i)
  return { state: await snapshot(response), headers: { Cookie: cookie } }
}
const interview = { commandId: 'submit-1', expectedRevision: 0, roleInterest: 'ソフトウェア開発', experience: 'Built a TypeScript app.', questions: ['勤務形態は？'] }

test('recruitment submit validates the HTTP boundary before changing the case', async () => {
  const { state, headers } = await create()
  const path = `/cases/${state.id}/recruitment/submit`
  for (const invalid of [
    { ...interview, roleInterest: '' }, { ...interview, experience: ' ' },
    { ...interview, roleInterest: 'a'.repeat(4001) }, { ...interview, experience: 'あ'.repeat(4001) },
    { ...interview, questions: 'question' }, { ...interview, questions: [3] }, { ...interview, questions: null },
    { ...interview, roleInterest: null }, { ...interview, experience: null },
    { ...interview, questions: [''] }, { ...interview, questions: ['a'.repeat(4001)] },
    { ...interview, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...interview, expectedRevision: -1 }, { ...interview, expectedRevision: 0.5 },
    { ...interview, commandId: '../bad' }
  ]) assert.equal((await request(path, invalid, headers)).status, 400, JSON.stringify(invalid).slice(0, 200))
  assert.equal((await request(path, { ...interview, experience: 'あ'.repeat(65536) }, headers)).status, 413)
  assert.equal((await request(path, interview, { ...headers, 'Content-Type': 'application/json-bad' })).status, 415)
  const malformed = await mf.dispatchFetch(`${origin}/api/v1${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{' })
  assert.equal(malformed.status, 400)
  assert.equal((await snapshot(await request(`/cases/${state.id}`, undefined, headers))).revision, 0)
})

test('optional questions normalize to an empty array and the body byte limit is inclusive', async () => {
  const { state, headers } = await create()
  const input = JSON.stringify({ commandId: 'boundary-1', expectedRevision: 0, roleInterest: 'a'.repeat(4000), experience: 'あ'.repeat(4000) })
  const byteLength = new TextEncoder().encode(input).byteLength
  const url = `${origin}/api/v1/cases/${state.id}/recruitment/submit`
  const response = await mf.dispatchFetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' }, body: input + ' '.repeat(65536 - byteLength) })
  const current = await snapshot(response)
  assert.deepEqual(current.recruitment?.questions, [])
  assert.equal(current.recruitment?.roleInterest.length, 4000)
  assert.equal(current.recruitment?.experience.length, 4000)
  const oversized = await mf.dispatchFetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: input + ' '.repeat(65537 - byteLength) })
  assert.equal(oversized.status, 413)
})

test('visitor ownership, case kind, and Origin guard recruitment submission', async () => {
  const { state, headers } = await create()
  const other = await create()
  const path = `/cases/${state.id}/recruitment/submit`
  assert.equal((await request(path, interview)).status, 401)
  assert.equal((await request(path, interview, other.headers)).status, 404)
  assert.equal((await request(path, interview, { ...headers, Origin: 'https://other.test' })).status, 403)
  const support = await create('support')
  const mismatch = await request(`/cases/${support.state.id}/recruitment/submit`, interview, support.headers)
  assert.equal(mismatch.status, 409)
  assert.equal((await mismatch.json() as { title: string }).title, 'case_kind_mismatch')
  assert.equal((await snapshot(await request(`/cases/${state.id}`, undefined, headers))).revision, 0)
})

test('staff reads, writes, and WebSockets reject missing authentication and forged headers', async () => {
  const { state } = await create()
  const command = { commandId: 'staff-1', expectedRevision: 0, caseId: state.id, answer: '面談日程を確認します。' }
  for (const [path, body] of [
    ['/staff/cases', undefined], [`/staff/cases/${state.id}`, undefined],
    [`/staff/cases/${state.id}/ws`, undefined], ['/staff/requests/unknown/claim', command], ['/staff/requests/unknown/answer', command]
  ] as const) {
    assert.equal((await request(path, body, { 'x-internal-staff-id': 'forged', 'Cf-Access-Authenticated-User-Email': 'forged@example.test' })).status, 401)
    assert.equal((await request(`/closed${path}`, body)).status, 503)
  }
  assert.equal((await request('/staff/cases', undefined, { 'x-test-staff': 'employee-a' })).status, 200)
  assert.equal((await request('/staff/cases', undefined, { 'x-test-staff': ' ' })).status, 401)
})

test('a recruitment interview reaches staff claim and answer without stock input', async () => {
  const { state, headers } = await create()
  const path = `/cases/${state.id}/recruitment/submit`
  let current = await snapshot(await request(path, interview, headers))
  assert.equal(current.status, 'awaiting_human')
  assert.equal(current.requests.length, 1)
  assert.equal((await snapshot(await request(path, interview, headers))).revision, current.revision)
  assert.equal((await request(path, { ...interview, experience: 'Different content' }, headers)).status, 409)
  assert.equal((await request(path, { ...interview, commandId: 'new-stale-command' }, headers)).status, 409)
  const requestId = current.requests[0].id
  const staff = { 'x-test-staff': 'employee-a' }
  current = await snapshot(await request(`/staff/requests/${requestId}/claim`, { caseId: state.id, commandId: 'claim-1', expectedRevision: current.revision }, staff))
  assert.equal((await request(`/staff/requests/${requestId}/claim`, { caseId: state.id, commandId: 'claim-other', expectedRevision: current.revision }, { 'x-test-staff': 'employee-b' })).status, 409)
  const answer = { caseId: state.id, commandId: 'answer-1', expectedRevision: current.revision, answer: '次の面談について担当者からご連絡します。' }
  assert.equal((await request(`/staff/requests/${requestId}/answer`, answer, { 'x-test-staff': 'employee-b' })).status, 409)
  current = await snapshot(await request(`/staff/requests/${requestId}/answer`, answer, staff))
  assert.equal(current.requests[0].status, 'answered')
  assert.equal(current.requests[0].stockAvailable, undefined)
  assert.equal(current.ai.status, 'resume_pending')
  const replay = await snapshot(await request(`/staff/requests/${requestId}/answer`, answer, staff))
  assert.equal(replay.revision, current.revision)
  const publicState = await snapshot(await request(`/cases/${state.id}`, undefined, headers))
  assert.equal(publicState.requests[0].assignedTo, undefined)
  assert.doesNotMatch(JSON.stringify(publicState), /ownerHash|employee-a/)
  const list = await (await request('/staff/cases', undefined, staff)).json() as { cases: { id: string; revision: number }[] }
  assert.equal(list.cases.find((item) => item.id === state.id)?.revision, current.revision)
})

test('an exchange answer still requires boolean stock information', async () => {
  const { state, headers } = await create('support')
  let current = await snapshot(await request(`/cases/${state.id}/investigate`, { commandId: 'investigate-1', expectedRevision: 0, reference: 'DEMO-1001', accessCode: 'demo-visitor', urgent: true }, headers))
  const staff = { 'x-test-staff': 'employee-a' }
  const id = current.requests[0].id
  current = await snapshot(await request(`/staff/requests/${id}/claim`, { caseId: state.id, commandId: 'claim-1', expectedRevision: current.revision }, staff))
  const answer = { caseId: state.id, commandId: 'answer-1', expectedRevision: current.revision, answer: 'In stock' }
  assert.equal((await request(`/staff/requests/${id}/answer`, answer, staff)).status, 400)
  assert.equal((await request(`/staff/requests/${id}/answer`, { ...answer, stockAvailable: 'true' }, staff)).status, 400)
  current = await snapshot(await request(`/staff/requests/${id}/answer`, { ...answer, stockAvailable: true }, staff))
  assert.equal(current.requests[0].stockAvailable, true)
})

test('demo staff login authenticates HTTP and WebSocket with a signed cookie', async () => {
  const { state } = await create()
  const bearer = { Authorization: `Bearer ${staffToken}` }
  assert.equal((await request('/staff/session', {}, { Authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await request('/staff/session', {}, { ...bearer, Origin: 'https://other.test' })).status, 403)
  const login = await request('/staff/session', {}, bearer)
  assert.equal(login.status, 200)
  const session = login.headers.get('Set-Cookie')!
  assert.match(session, /HttpOnly/)
  assert.match(session, /SameSite=Strict/)
  assert.ok(!session.includes(staffToken))
  const headers = { Cookie: session.split(';')[0] }
  assert.equal((await request('/staff/cases', undefined, headers)).status, 200)
  assert.equal((await request('/staff/cases', undefined, bearer)).status, 200)
  const response = await mf.dispatchFetch(`${origin}/api/v1/staff/cases/${state.id}/ws`, { headers: { ...headers, Origin: origin, Upgrade: 'websocket' } })
  assert.equal(response.status, 101)
  const ws = response.webSocket!
  const message = new Promise<string>((resolve) => ws.addEventListener('message', (event) => resolve(String(event.data)), { once: true }))
  ws.accept()
  const event = JSON.parse(await message) as { type: string; snapshot: CaseSnapshot }
  assert.equal(event.type, 'case.snapshot')
  assert.equal(event.snapshot.id, state.id)
  ws.close(1000, 'Test complete')
  assert.equal((await request(`/staff/cases/${state.id}/ws`, undefined, { ...headers, Origin: 'https://other.test' })).status, 403)
})

test('HaaS result passes through staff login, claim, answer and D1 without inferring language or simulation', async () => {
  const { state, headers } = await create()
  const submission = { ...interview, questions: ['現場の開発環境を教えてください。'] }
  let current = await snapshot(await request(`/cases/${state.id}/recruitment/submit`, submission, headers))
  const requestId = current.requests[0].id
  assert.match(requestId, new RegExp(state.id))
  const login = await request('/staff/session', {}, { Authorization: `Bearer ${staffToken}` })
  assert.equal(login.status, 200)
  const staff = { Cookie: login.headers.get('Set-Cookie')!.split(';')[0] }
  current = await snapshot(await request(`/staff/requests/${requestId}/claim`, { caseId: state.id, commandId: 'haas-claim', expectedRevision: current.revision }, staff))
  const base = { caseId: state.id, commandId: 'haas-answer', expectedRevision: current.revision }
  const result = { text: '[Simulated] Our demo engineering team uses TypeScript and VS Code.', language: 'en' }
  for (const invalid of [
    { result: null, simulated: true }, { result: {}, simulated: true },
    { result: { text: '', language: 'en' }, simulated: true },
    { result: { ...result, text: 'a'.repeat(4001) }, simulated: true },
    { result: { ...result, language: 'fr' }, simulated: true },
    { result: { text: result.text }, simulated: true },
    { result }, { result, simulated: 'true' },
    { result, simulated: true, answer: 'Different answer' },
    { simulated: true, status: 'completed' }, { status: 'completed' }
  ]) assert.equal((await request(`/staff/requests/${requestId}/answer`, { ...base, ...invalid }, staff)).status, 400, JSON.stringify(invalid).slice(0, 200))
  assert.equal((await snapshot(await request(`/cases/${state.id}`, undefined, headers))).revision, current.revision)
  const other = await create()
  assert.equal((await request(`/staff/requests/${requestId}/answer`, { ...base, caseId: other.state.id, expectedRevision: 0, result, simulated: true }, staff)).status, 404)
  const answer = { ...base, result, simulated: true }
  current = await snapshot(await request(`/staff/requests/${requestId}/answer`, answer, staff))
  assert.deepEqual(current.requests[0].result, result)
  assert.equal(current.requests[0].simulated, true)
  assert.equal(current.requests[0].answer, result.text)
  assert.equal(current.locale, 'ja')
  assert.equal(current.ai.status, 'resume_pending')
  assert.equal((await snapshot(await request(`/staff/requests/${requestId}/answer`, answer, staff))).revision, current.revision)
  assert.equal((await request(`/staff/requests/${requestId}/answer`, { ...answer, simulated: false }, staff)).status, 409)
  const publicState = await snapshot(await request(`/cases/${state.id}`, undefined, headers))
  assert.deepEqual(publicState.requests[0].result, result)
  assert.equal(publicState.requests[0].simulated, true)
  const db = await mf.getD1Database('DB')
  const saved = await db.prepare('SELECT summary FROM cases WHERE id=?').bind(state.id).first<{ summary: string }>()
  const summary = JSON.parse(saved!.summary) as CaseSnapshot
  assert.deepEqual(summary.requests[0].result, result)
  assert.equal(summary.requests[0].simulated, true)
  assert.equal(summary.requests[0].id, requestId)
  assert.equal(summary.id, state.id)
})

test('Agents start reuses pending and completed requests while keeping ownership and input guards', async () => {
  const { state, headers } = await create()
  const path = `/cases/${state.id}/agents`
  const input = { commandId: 'agent-stable-start', expectedRevision: state.revision }
  const callsBefore = providerRequests.length
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  providerGate = { entered: entered.resolve, released: released.promise }
  const first = request(path, input, headers)
  let response: Awaited<ReturnType<typeof request>>
  try {
    await Promise.race([entered.promise, first.then((result) => { throw new Error(`Provider was not called: HTTP ${result.status}`) })])
    const pending = await request(path, input, headers)
    assert.equal(pending.status, 409)
    assert.equal((await pending.json() as { title: string }).title, 'session_request_pending')
    assert.equal(providerRequests.length, callsBefore + 1)
  } finally {
    released.resolve()
    response = await first
  }
  assert.equal(response.status, 202)
  const started = await response.json() as { sessionId: string }
  assert.equal(started.sessionId, providerRequests.at(-1)!.sessionId)
  const replay = await request(path, input, headers)
  assert.equal(replay.status, 202)
  assert.equal((await replay.json() as { sessionId: string }).sessionId, started.sessionId)

  let current = await snapshot(await request(`/cases/${state.id}`, undefined, headers))
  assert.equal(current.revision, state.revision + 2)
  current = await snapshot(await request(`/cases/${state.id}/messages`, {
    commandId: 'after-agent-start', expectedRevision: current.revision, text: '追加の質問があります。',
  }, headers))
  const afterMessage = await request(path, input, headers)
  assert.equal(afterMessage.status, 202)
  assert.equal((await afterMessage.json() as { sessionId: string }).sessionId, started.sessionId)
  const changed = await request(path, { ...input, expectedRevision: current.revision }, headers)
  assert.equal(changed.status, 409)
  assert.equal((await changed.json() as { title: string }).title, 'idempotency_conflict')
  assert.equal((await request(path, input)).status, 401)
  const other = await create()
  assert.equal((await request(path, input, other.headers)).status, 404)
  assert.equal(providerRequests.length, callsBefore + 1)
})

test('Agents start retry repairs D1 projection after provider completion without creating another session', async () => {
  const { state, headers } = await create()
  const path = `/cases/${state.id}/agents`
  const input = { commandId: 'agent-project-retry', expectedRevision: state.revision }
  const callsBefore = providerRequests.length
  const db = await mf.getD1Database('DB')
  await db.exec("CREATE TRIGGER fail_agent_projection BEFORE INSERT ON cases BEGIN SELECT RAISE(ABORT, 'simulated D1 outage'); END")
  try {
    const failed = await request(path, input, headers)
    assert.equal(failed.status, 503)
    assert.equal((await failed.json() as { title: string }).title, 'projection_failed')
  } finally { await db.exec('DROP TRIGGER fail_agent_projection') }
  assert.equal(providerRequests.length, callsBefore + 1)
  assert.equal((await snapshot(await request(`/cases/${state.id}`, undefined, headers))).revision, 2)
  const stale = await db.prepare('SELECT revision FROM cases WHERE id=?').bind(state.id).first<{ revision: number }>()
  assert.equal(stale?.revision, 0)
  const retried = await request(path, input, headers)
  assert.equal(retried.status, 202)
  assert.equal((await retried.json() as { sessionId: string }).sessionId, providerRequests.at(-1)!.sessionId)
  const saved = await db.prepare('SELECT revision,summary FROM cases WHERE id=?').bind(state.id).first<{ revision: number; summary: string }>()
  assert.equal(saved?.revision, 2)
  assert.equal(JSON.parse(saved!.summary).integration.agentSessionId, providerRequests.at(-1)!.sessionId)
  assert.equal(providerRequests.length, callsBefore + 1)
})
