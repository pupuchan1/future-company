import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import type { CaseSnapshot } from './contracts'

let mf: Miniflare
const staffToken = randomBytes(32).toString('hex')
const origin = 'http://localhost'

before(async () => {
  const bundle = await build({ entryPoints: ['src/index.tsx'], bundle: true, write: false,
    format: 'esm', platform: 'browser', jsx: 'automatic', jsxImportSource: 'hono/jsx',
    external: ['cloudflare:workers'], define: { 'import.meta.env.PROD': 'true' } })
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-worker-persistence', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2025-08-03',
    durableObjects: { CASES: { className: 'CaseRoom', useSQLite: true } }, d1Databases: ['DB'],
    bindings: { STAFF_API_TOKEN: staffToken },
    outboundService: () => new Response('External providers are disabled in this test.', { status: 502 }),
  }))
  const db = await mf.getD1Database('DB')
  for (const file of ['migrations/0001_company.sql', 'migrations/0002_mcp_events.sql']) {
    const sql = await readFile(file, 'utf8')
    for (const statement of sql.split(';').filter((part) => part.trim())) await db.exec(statement.replaceAll('\n', ' '))
  }
}, { timeout: 20000 })
after(async () => { await mf?.dispose() })

async function request(path: string, body?: unknown, cookie = '') {
  return mf.dispatchFetch(`${origin}/api/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: origin }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function readCase(response: Awaited<ReturnType<typeof request>>) {
  const result = await response.json() as { case?: CaseSnapshot; title?: string }
  assert.ok(response.ok, `HTTP ${response.status}: ${result.title}`)
  assert.ok(result.case)
  return result.case
}

test('Worker intake survives D1 failure and replays through DO before employee answer is saved', async () => {
  const created = await request('/cases', { commandId: 'persist-integration-create', expectedRevision: 0, kind: 'recruitment', locale: 'en' })
  const visitorCookie = created.headers.get('Set-Cookie')!.split(';')[0]
  let state = await readCase(created)
  const id = state.id
  const db = await mf.getD1Database('DB')
  await db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON cases BEGIN SELECT RAISE(ABORT, 'simulated D1 outage'); END")
  const submission = { commandId: 'persist-intake', expectedRevision: state.revision, roleInterest: 'Engineer', experience: 'I built web services.', questions: ['What development environment does the engineering team use?'] }
  const failed = await request(`/cases/${id}/recruitment/submit`, submission, visitorCookie)
  assert.equal(failed.status, 503)
  assert.equal((await failed.json() as { title: string }).title, 'projection_failed')
  state = await readCase(await request(`/cases/${id}`, undefined, visitorCookie))
  assert.equal(state.revision, 1)
  assert.equal(state.requests.length, 1)
  assert.equal(state.requests[0].answer, undefined)
  assert.equal(state.ai.status, 'awaiting_human')
  const stale = await db.prepare('SELECT revision FROM cases WHERE id=?').bind(id).first<{ revision: number }>()
  assert.equal(stale?.revision, 0)
  await db.exec('DROP TRIGGER fail_projection')
  state = await readCase(await request(`/cases/${id}/recruitment/submit`, submission, visitorCookie))
  assert.equal(state.revision, 1)
  assert.equal(state.requests.length, 1)
  const intake = await db.prepare('SELECT summary FROM cases WHERE id=?').bind(id).first<{ summary: string }>()
  assert.equal(JSON.parse(intake!.summary).recruitment.source, 'visitor_self_report')

  const login = await mf.dispatchFetch(`${origin}/api/v1/staff/session`, {
    method: 'POST', headers: { Authorization: `Bearer ${staffToken}`, Origin: origin },
  })
  assert.equal(login.status, 200)
  const staffCookie = login.headers.get('Set-Cookie')!.split(';')[0]
  const requestId = state.requests[0].id
  state = await readCase(await request(`/staff/requests/${requestId}/claim`, { caseId: id, commandId: 'persist-claim', expectedRevision: state.revision }, staffCookie))
  const result = { text: '[模擬回答・接続試験用] 開発環境はTypeScriptとVS Codeです。', language: 'ja' }
  const answer = { caseId: id, commandId: 'persist-answer', expectedRevision: state.revision, result, simulated: true }
  state = await readCase(await request(`/staff/requests/${requestId}/answer`, answer, staffCookie))
  assert.equal(state.ai.status, 'resume_pending')
  assert.equal(state.locale, 'en')
  assert.equal(state.requests[0].id, requestId)
  assert.equal(state.requests[0].answer, result.text)
  assert.deepEqual(state.requests[0].result, result)
  assert.equal(state.requests[0].simulated, true)
  const list = await request('/staff/cases', undefined, staffCookie)
  assert.equal(list.status, 200)
  const listed = await list.json() as { cases: CaseSnapshot[] }
  const saved = listed.cases.find((item) => item.id === id)!
  assert.equal(saved.revision, state.revision)
  assert.equal(saved.locale, 'en')
  assert.deepEqual(saved.recruitment?.questions, submission.questions)
  assert.equal(saved.recruitment?.experience, submission.experience)
  assert.equal(saved.requests[0].id, requestId)
  assert.equal(saved.requests[0].answer, result.text)
  assert.deepEqual(saved.requests[0].result, result)
  assert.equal(saved.requests[0].simulated, true)
  const replay = await readCase(await request(`/staff/requests/${requestId}/answer`, answer, staffCookie))
  assert.equal(replay.revision, state.revision)
  assert.equal((await readCase(await request(`/cases/${id}`, undefined, visitorCookie))).requests[0].assignedTo, undefined)
  assert.equal((await request('/staff/cases')).status, 401)
})

test('mounted provider routes report missing connections and the MCP endpoint remains closed', async () => {
  const created = await request('/cases', { commandId: 'persist-provider-create', expectedRevision: 0, kind: 'recruitment' })
  const cookie = created.headers.get('Set-Cookie')!.split(';')[0]
  const state = await readCase(created)
  const live = await request(`/cases/${state.id}/live`, { commandId: 'live-unconfigured', expectedRevision: state.revision, sdp: 'v=0' }, cookie)
  assert.equal(live.status, 503)
  assert.equal((await live.json() as { title: string }).title, 'live_backend_unconfigured')
  const agent = await request(`/cases/${state.id}/agents`, { commandId: 'agent-unconfigured', expectedRevision: state.revision }, cookie)
  assert.equal(agent.status, 503)
  assert.equal((await agent.json() as { title: string }).title, 'openai_key_unconfigured')
  const mcp = await mf.dispatchFetch(`${origin}/mcp`, { method: 'POST', body: '{}' })
  assert.equal(mcp.status, 401)
})
