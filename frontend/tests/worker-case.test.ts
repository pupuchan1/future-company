import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkerCaseClient } from '../src/features/live/worker-case.ts'

test('concurrent preparation creates one Worker-owned case and uses the visitor cookie transport', async () => {
  let calls = 0
  let complete!: (value: Response) => void
  const client = new WorkerCaseClient('create-a', 'support', (async (path, options) => {
    calls++
    assert.equal(path, '/api/v1/cases')
    assert.equal(options?.credentials, 'same-origin')
    assert.deepEqual(JSON.parse(String(options?.body)), { commandId: 'create-a', expectedRevision: 0, kind: 'support', locale: 'ja' })
    return new Promise<Response>(resolve => { complete = resolve })
  }) as typeof fetch)
  const first = client.ensure('ja')
  const second = client.ensure('ja')
  assert.equal(client.getSnapshot().caseId, '')
  assert.equal(first, second)
  assert.equal(calls, 1)
  complete(Response.json({ case: { id: 'case-worker-a', revision: 0, kind: 'support', locale: 'ja' } }, { status: 201 }))
  await first
  assert.equal(client.getSnapshot().status, 'ready')
  assert.equal(client.getSnapshot().caseId, 'case-worker-a')
  await client.ensure('en')
  assert.equal(calls, 1)
})

test('failed preparation exposes no fake case; retry preserves its command and original locale', async () => {
  const bodies: unknown[] = []
  const client = new WorkerCaseClient('create-b', 'recruitment', (async (_path, options) => {
    bodies.push(JSON.parse(String(options?.body)))
    if (bodies.length === 1) return Response.json({ title: 'projection_failed', detail: 'Case persistence failed.' }, { status: 503 })
    return Response.json({ case: { id: 'case-worker-b', revision: 0, kind: 'recruitment', locale: 'ja' } }, { status: 201 })
  }) as typeof fetch)
  await client.ensure('ja')
  assert.equal(client.getSnapshot().status, 'error')
  assert.equal(client.getSnapshot().caseId, '')
  assert.match(client.getSnapshot().error, /503/)
  await client.ensure('en')
  assert.deepEqual(bodies[1], bodies[0])
  assert.equal(client.getSnapshot().caseId, 'case-worker-b')
})

test('Access pages, unauthorized responses and malformed Worker cases never become usable cases', async () => {
  for (const response of [
    new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
    Response.json({ title: 'visitor_session_required' }, { status: 401 }),
    Response.json({ case: { id: '../wrong', revision: 0, kind: 'support', locale: 'ja' } }),
    Response.json({ case: { id: 'case-other', revision: 0, kind: 'recruitment', locale: 'ja' } }),
  ]) {
    const client = new WorkerCaseClient('create-c', 'support', async () => response)
    await client.ensure('ja')
    assert.equal(client.getSnapshot().status, 'error')
    assert.equal(client.getSnapshot().caseId, '')
  }
})
