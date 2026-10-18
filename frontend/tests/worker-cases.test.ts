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
  assert.equal(sent.kind, 'haas'); assert.equal(sent.expectedRevision, 0)
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

const proof = (bridgeToken = 'test-case-proof', caseId = 'case-worker-issued') => Response.json({ caseId, bridgeToken, expiresIn: 900 })

test('voice preparation shares a single owner-authenticated proof and never publishes the token', async () => {
  const calls: { path: string; init?: RequestInit }[] = []
  const snapshots: string[] = []
  const client = new WorkerCaseClient((async (path, init) => {
    calls.push({ path: String(path), init })
    return String(path).endsWith('/bridge-token') ? proof() : success()
  }) as typeof fetch)
  client.subscribe(state => snapshots.push(JSON.stringify(state)))
  const [a, b] = await Promise.all([client.prepareVoice('ja'), client.prepareVoice('en')])
  assert.equal(a, b)
  assert.equal(a.case.id, 'case-worker-issued')
  assert.equal(a.bridgeToken, 'test-case-proof')
  assert.deepEqual(calls.map(call => call.path), ['/api/v1/cases', '/api/v1/cases/case-worker-issued/bridge-token'])
  const request = calls[1].init!
  assert.equal(request.method, 'POST'); assert.equal(request.credentials, 'same-origin')
  assert.equal(request.redirect, 'manual'); assert.equal(request.cache, 'no-store')
  assert.equal(request.body, undefined)
  assert.equal(snapshots.some(state => state.includes('test-case-proof') || state.includes('bridgeToken')), false)
})

test('a new voice start verifies the same case and requests a fresh proof', async () => {
  const calls: string[] = []
  let sequence = 0
  const client = new WorkerCaseClient((async path => {
    calls.push(String(path))
    return String(path).endsWith('/bridge-token') ? proof(`proof-${++sequence}`) : success()
  }) as typeof fetch)
  const first = await client.prepareVoice('ja')
  const second = await client.prepareVoice('en')
  assert.notEqual(first.bridgeToken, second.bridgeToken)
  assert.equal(first.case.id, second.case.id)
  assert.deepEqual(calls, ['/api/v1/cases', '/api/v1/cases/case-worker-issued/bridge-token', '/api/v1/cases/case-worker-issued', '/api/v1/cases/case-worker-issued/bridge-token'])
})

test('wrong-case, empty, oversized and expired proof responses cannot authorize voice', async () => {
  for (const body of [null, {}, { caseId: 'other-case', bridgeToken: 'secret', expiresIn: 900 },
    { caseId: 'case-worker-issued', bridgeToken: '', expiresIn: 900 },
    { caseId: 'case-worker-issued', bridgeToken: 'x'.repeat(1001), expiresIn: 900 },
    ...[0, -1, 901, '900', 1.5].map(expiresIn => ({ caseId: 'case-worker-issued', bridgeToken: 'secret', expiresIn }))]) {
    const client = new WorkerCaseClient((async path => String(path).endsWith('/bridge-token') ? Response.json(body) : success()) as typeof fetch)
    await assert.rejects(client.prepareVoice('ja'), /Invalid voice authorization/)
    assert.equal(client.getSnapshot().phase, 'error')
    assert.equal(JSON.stringify(client.getSnapshot()).includes('secret'), false)
  }
})

test('proof authentication, unavailable endpoints, HTML and network failures stop preparation without exposing responses', async () => {
  for (const response of [
    ...[302, 401, 403, 404, 503].map(status => new Response('sensitive server detail', { status })),
    new Response('<html>sensitive server detail</html>', { headers: { 'Content-Type': 'text/html' } }),
    new Response('invalid-json', { headers: { 'Content-Type': 'application/json' } }),
  ]) {
    const client = new WorkerCaseClient((async path => String(path).endsWith('/bridge-token') ? response : success()) as typeof fetch)
    await assert.rejects(client.prepareVoice('ja'))
    assert.equal(client.getSnapshot().phase, 'error')
    assert.equal(client.getSnapshot().case?.id, 'case-worker-issued')
    assert.equal(client.getSnapshot().error.includes('sensitive'), false)
  }
  const client = new WorkerCaseClient((async path => {
    if (String(path).endsWith('/bridge-token')) throw new Error('sensitive network detail')
    return success()
  }) as typeof fetch)
  await assert.rejects(client.prepareVoice('ja'))
  assert.equal(client.getSnapshot().error.includes('sensitive'), false)
})

test('cancelling a pending proof aborts capture preparation and discards its late success', async () => {
  let resolve!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  const client = new WorkerCaseClient((async (path, init) => {
    if (!String(path).endsWith('/bridge-token')) return success()
    signal = init?.signal
    return new Promise<Response>(r => { resolve = r })
  }) as typeof fetch)
  const pending = client.prepareVoice('ja')
  await new Promise(resolve => setImmediate(resolve))
  client.cancel()
  resolve(proof())
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(signal?.aborted, true)
  assert.equal(client.getSnapshot().phase, 'ready')
  assert.equal(JSON.stringify(client.getSnapshot()).includes('test-case-proof'), false)
})

test('cancel during case creation prevents even requesting a proof', async () => {
  let resolve!: (response: Response) => void
  const calls: string[] = []
  const client = new WorkerCaseClient((async path => {
    calls.push(String(path))
    return new Promise<Response>(r => { resolve = r })
  }) as typeof fetch)
  const pending = client.prepareVoice('ja')
  client.cancel(); resolve(success())
  await assert.rejects(pending, { name: 'AbortError' })
  assert.deepEqual(calls, ['/api/v1/cases'])
  assert.equal(client.getSnapshot().phase, 'idle')
})

test('proof retry uses the existing case; cancelled generations cannot overwrite its result', async () => {
  let sequence = 0
  let resolveLate!: (response: Response) => void
  const client = new WorkerCaseClient((async path => {
    if (!String(path).endsWith('/bridge-token')) return success()
    if (++sequence === 1) return new Promise<Response>(resolve => { resolveLate = resolve })
    return proof('current-proof')
  }) as typeof fetch)
  const old = client.prepareVoice('ja')
  await new Promise(resolve => setImmediate(resolve))
  client.cancel()
  const current = await client.prepareVoice('ja')
  resolveLate(proof('late-proof'))
  await assert.rejects(old, { name: 'AbortError' })
  assert.equal(current.bridgeToken, 'current-proof')
  assert.equal(client.getSnapshot().phase, 'ready')
})
