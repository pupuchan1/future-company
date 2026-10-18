import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { Miniflare, convertV4MiniflareOptions } from 'miniflare'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CaseSnapshot, IntegrationView } from './contracts'

let mf: Miniflare
const now = '2026-10-18T06:00:00.000Z'
const snapshot: CaseSnapshot = {
  id: 'case-persistence', kind: 'recruitment', locale: 'ja', status: 'ready', revision: 3,
  createdAt: now, updatedAt: now, messages: [], facts: [],
  recruitment: { roleInterest: '開発', experience: 'Webアプリを開発', questions: ['勤務形態は？'], source: 'visitor_self_report', submittedAt: now },
  requests: [{ id: 'request-1', status: 'answered', summary: '本人申告の面談', facts: [], question: '募集職種を確認してください。',
    assignedTo: 'employee-a', answer: '[模擬回答] TypeScriptで開発しています。',
    result: { text: '[模擬回答] TypeScriptで開発しています。', language: 'ja' }, simulated: true, createdAt: now, answeredAt: now }],
  ai: { status: 'resume_pending', reason: 'Staff has answered; the agent has not resumed.' },
}

before(async () => {
  const bundle = await build({ stdin: { contents: `
    import {persistCase} from './src/backend/persistence';
    export default {async fetch(request, env) {
      const {snapshot, integration} = await request.json();
      try { await persistCase(env, snapshot, integration); return Response.json({saved: true}); }
      catch (error) { return Response.json({code: error.code}, {status: error.status ?? 500}); }
    }};`, resolveDir: resolve('.') }, bundle: true, write: false, format: 'esm', platform: 'browser' })
  mf = new Miniflare(convertV4MiniflareOptions({ name: 'test-persistence', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2025-08-03', d1Databases: ['DB'] }))
  const db = await mf.getD1Database('DB')
  const sql = await readFile('migrations/0001_company.sql', 'utf8')
  for (const statement of sql.split(';').filter((part) => part.trim())) await db.exec(statement.replaceAll('\n', ' '))
}, { timeout: 20000 })
after(async () => { await mf?.dispose() })

async function persist(value: CaseSnapshot, integration?: IntegrationView) {
  return mf.dispatchFetch('http://localhost/persist', { method: 'POST', body: JSON.stringify({ snapshot: value, integration }) })
}
async function row(id = snapshot.id) {
  const db = await mf.getD1Database('DB')
  return db.prepare('SELECT revision, summary, created_at, updated_at FROM cases WHERE id=?').bind(id)
    .first<{ revision: number; summary: string; created_at: string; updated_at: string }>()
}

test('persists employee answers and integration mapping without private session state', async () => {
  const response = await persist({ ...snapshot, ownerHash: 'private-owner' } as CaseSnapshot,
    { agentSessionId: 'agent-session-1', operations: { secret: 'private-sdp' } } as IntegrationView)
  assert.equal(response.status, 200)
  const saved = await row()
  assert.equal(saved?.revision, 3)
  const summary = JSON.parse(saved!.summary)
  assert.equal(summary.requests[0].answer, '[模擬回答] TypeScriptで開発しています。')
  assert.deepEqual(summary.requests[0].result, snapshot.requests[0].result)
  assert.equal(summary.requests[0].simulated, true)
  assert.equal(summary.requests[0].assignedTo, undefined)
  assert.equal(summary.integration.agentSessionId, 'agent-session-1')
  assert.equal(summary.ownerHash, undefined)
  assert.equal(summary.integration.operations, undefined)
  assert.equal(summary.ai.status, 'resume_pending')
  assert.deepEqual(summary.recruitment, snapshot.recruitment)
})

test('late and equal revisions cannot overwrite a newer summary or integration mapping', async () => {
  const newer = { ...snapshot, revision: 5, updatedAt: '2026-10-18T06:05:00.000Z' }
  assert.equal((await persist(newer, { agentSessionId: 'agent-session-2' })).status, 200)
  assert.equal((await persist(snapshot, { agentSessionId: 'old-session' })).status, 200)
  assert.equal((await persist({ ...newer, status: 'resolved' })).status, 200)
  const saved = await row()
  assert.equal(saved?.revision, 5)
  assert.equal(saved?.created_at, now)
  assert.equal(saved?.updated_at, '2026-10-18T06:05:00.000Z')
  const summary = JSON.parse(saved!.summary)
  assert.equal(summary.status, 'ready')
  assert.equal(summary.integration.agentSessionId, 'agent-session-2')
})

test('a failed write returns projection_failed and the same snapshot can be resent', async () => {
  const db = await mf.getD1Database('DB')
  await db.exec("CREATE TRIGGER fail_projection BEFORE INSERT ON cases WHEN NEW.id='case-retry' BEGIN SELECT RAISE(ABORT, 'simulated D1 failure'); END")
  const value = { ...snapshot, id: 'case-retry' }
  const failed = await persist(value)
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { code: 'projection_failed' })
  assert.equal(await row(value.id), null)
  await db.exec('DROP TRIGGER fail_projection')
  assert.equal((await persist(value)).status, 200)
  assert.equal((await row(value.id))?.revision, 3)
})
