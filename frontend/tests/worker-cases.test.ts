import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WorkerCaseClient } from '../src/features/worker/cases.ts'

const success = (id = 'case-worker-issued', revision = 0) => Response.json({ case: { id, revision, kind: 'support', locale: 'ja' } }, { status: 201 })
test('Worker returns the only real case ID; parallel starts create once with same-origin cookies', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const client = new WorkerCaseClient((async (path, init) => { calls.push({ path: String(path), init }); return success() }) as typeof fetch)
  const [a,b] = await Promise.all([client.ensureCase('ja'), client.ensureCase('ja')])
  assert.equal(calls.length, 1)
  assert.equal(a.id, 'case-worker-issued'); assert.equal(b.id, a.id)
  assert.equal(calls[0].path, '/api/v1/cases')
  assert.equal(calls[0].init?.credentials, 'same-origin')
  assert.equal(calls[0].init?.redirect, 'manual')
  const sent = JSON.parse(String(calls[0].init?.body))
  assert.equal(sent.kind, 'support'); assert.equal(sent.expectedRevision, 0)
  assert.equal(Object.hasOwn(sent, 'id'), false)
  assert.equal(client.getSnapshot().phase, 'ready')
})
test('a retry preserves command, body and locale instead of creating another command', async () => {
  const bodies: string[] = []
  const client = new WorkerCaseClient((async (_path, init) => { bodies.push(String(init?.body)); return bodies.length === 1 ? Response.json({}, { status: 503 }) : success() }) as typeof fetch)
  await assert.rejects(client.ensureCase('ja'))
  assert.equal(client.getSnapshot().case, null)
  await client.ensureCase('en')
  assert.equal(bodies[0], bodies[1])
})
test('an existing case is owner-checked before reuse, and a mismatched response is rejected', async () => {
  const calls: string[] = []
  const client = new WorkerCaseClient((async path => { calls.push(String(path)); return success(calls.length < 3 ? 'case-worker-issued' : 'case-another') }) as typeof fetch)
  await client.ensureCase('ja'); await client.ensureCase('en')
  assert.equal(calls[1], '/api/v1/cases/case-worker-issued')
  await assert.rejects(client.ensureCase('ja'), /does not match/)
  assert.equal(client.getSnapshot().phase, 'error')
  assert.equal(client.getSnapshot().case?.id, 'case-worker-issued')
})
test('authentication and Access redirects cannot appear as a created case', async () => {
  for (const status of [302, 401, 403]) {
    const client = new WorkerCaseClient((async () => new Response('', { status })) as typeof fetch)
    await assert.rejects(client.ensureCase('ja'), /Authenticate/)
    assert.equal(client.getSnapshot().phase, 'error')
    assert.equal(client.getSnapshot().case, null)
  }
  const client = new WorkerCaseClient((async () => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } })) as typeof fetch)
  await assert.rejects(client.ensureCase('ja'), /authentication/)
  assert.equal(client.getSnapshot().case, null)
})
test('late success after cancellation does not create or publish an active case', async () => {
  let resolve!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  const client = new WorkerCaseClient((async (_path, init) => { signal = init?.signal; return new Promise<Response>(r => { resolve = r }) }) as typeof fetch)
  const pending = client.ensureCase('ja')
  client.cancel(); resolve(success())
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(signal?.aborted, true)
  assert.equal(client.getSnapshot().phase, 'idle')
  assert.equal(client.getSnapshot().case, null)
})
test('malformed case IDs, revisions and response bodies never become a Live case ID', async () => {
  for (const value of [{}, { case: { id: '../bad', revision: 0, kind: 'support', locale: 'ja' } }, { case: { id: 'good', revision: -1, kind: 'support', locale: 'ja' } }]) {
    const client = new WorkerCaseClient((async () => Response.json(value)) as typeof fetch)
    await assert.rejects(client.ensureCase('ja'), /Invalid case response/)
    assert.equal(client.getSnapshot().case, null)
  }
})
test('reset prepares a new independent operation after a completed conversation', async () => {
  const bodies: string[] = []
  const client = new WorkerCaseClient((async (_path, init) => { bodies.push(String(init?.body)); return success() }) as typeof fetch)
  await client.ensureCase('ja'); client.reset(); await client.ensureCase('ja')
  assert.notEqual(JSON.parse(bodies[0]).commandId, JSON.parse(bodies[1]).commandId)
})
