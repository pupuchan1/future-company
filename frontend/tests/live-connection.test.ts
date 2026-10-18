import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveClient } from '../src/features/live/client.ts'
import type { LiveRuntime } from '../src/features/live/client.ts'
import { LiveEventReducer } from '../src/features/live/events.ts'
import { initialSnapshot } from '../src/features/live/types.ts'

function fixture() {
  const calls: { path: string; options?: RequestInit }[] = []
  const track = { enabled: true, stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  const channel = {
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    closed: false, close() { this.closed = true },
    send() { assert.fail('PR #4 does not allow frontend Live commands') },
  }
  const source = {
    readyState: 0,
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onerror: null as (() => void) | null,
    closed: false, close() { this.closed = true },
  }
  const audio = { srcObject: null, autoplay: true, play: async () => {}, pause() {} }
  const peer = {
    iceGatheringState: 'complete', connectionState: 'new', localDescription: null as null | { sdp: string },
    ontrack: null, onconnectionstatechange: null as (() => void) | null,
    closed: false, answer: null as unknown,
    addTrack() {}, createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\no=mock' }),
    async setLocalDescription(offer: { sdp: string }) { this.localDescription = offer },
    async setRemoteDescription(answer: unknown) { this.answer = answer },
    close() { this.closed = true }, addEventListener() {}, removeEventListener() {},
  }
  let create = async (): Promise<Response> => Response.json({ session: { id: 'live_1' }, transport: { sdp: 'v=0\r\no=answer' }, case_id: 'case-a' })
  let microphone = async (): Promise<unknown> => stream
  const runtime = {
    fetch: async (path: string, options?: RequestInit) => {
      calls.push({ path, options })
      if (path === '/api/status') return Response.json({ live_configured: true, mcp_configured: true, requests: [] })
      if (options?.method === 'DELETE') return Response.json({ closed: true, live_finalized: true, cleanup_pending: [] })
      return create()
    },
    microphone: () => microphone(), peer: () => peer, events: () => source, audio: () => audio, supported: () => true,
  } as unknown as LiveRuntime
  return { runtime, track, stream, channel, source, audio, peer, calls,
    setCreate: (next: typeof create) => { create = next },
    setMicrophone: (next: typeof microphone) => { microphone = next },
  }
}

test('case filtering precedes deduplication, and SSE/DC transcripts are deduplicated', () => {
  const reducer = new LiveEventReducer()
  const initial = initialSnapshot('case-a', 'ja')
  const event = { type: 'session.input_transcript.delta', event_id: 'e1', delta: 'Hello', item_id: 'i1' }
  assert.equal(reducer.apply(initial, { ...event, case_id: 'case-b' }, 'server'), initial)
  assert.equal(reducer.apply(initial, event, 'server'), initial)
  const once = reducer.apply(initial, event, 'datachannel')
  assert.equal(once.transcripts[0]?.text, 'Hello')
  assert.equal(reducer.apply(once, { ...event, case_id: 'case-a' }, 'server'), once)
  const twice = reducer.apply(once, { ...event, event_id: 'e2', delta: ' world', case_id: 'case-a' }, 'server')
  assert.equal(twice.transcripts[0]?.text, 'Hello world')
  const routed = reducer.apply(twice, { type: 'routing.updated', case_id: 'case-a', route: 'recruiting', language: 'en' }, 'server')
  assert.equal(routed.route, 'recruiting'); assert.equal(routed.language, 'en')
})

test('old handoff revisions and other cases cannot overwrite results; completion never invents an answer', () => {
  const reducer = new LiveEventReducer()
  const initial = initialSnapshot('case-a', 'ja')
  const request = { handoff_id: 'h1', case_id: 'case-a', status: 'completed', revision: 4, simulated: true, audio_connected: false, target_role: 'engineer', task: 'Check tools', expected_result: 'Tool names' }
  const completed = reducer.apply(initial, { type: 'human.completed', data: request }, 'server')
  assert.equal(completed.requests[0]?.result, undefined)
  assert.equal(completed.requests[0]?.audioConnected, false)
  assert.equal(completed.requests[0]?.simulated, true)
  assert.equal(completed.requests[0]?.targetRole, 'engineer')
  assert.equal(completed.requests[0]?.task, 'Check tools')
  assert.equal(completed.requests[0]?.expectedResult, 'Tool names')
  const older = reducer.apply(completed, { type: 'human.ringing', data: { ...request, status: 'ringing', revision: 2 } }, 'server')
  assert.equal(older, completed)
  const result = reducer.apply(completed, { type: 'human.completed', data: { ...request, revision: 5, result: { text: '確認しました', language: 'ja' } } }, 'server')
  assert.deepEqual(result.requests[0]?.result, { text: '確認しました', language: 'ja' })
  assert.equal(reducer.apply(result, { type: 'human.completed', data: { ...request, case_id: 'case-b' } }, 'server'), result)
})

test('start uses PR #4 SDP contract, waits for session.started, then mutes and releases every resource', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  client.observe()
  await client.refreshStatus()
  // Observe's status request may still be in flight.
  await new Promise(resolve => setImmediate(resolve))
  try {
    await client.start()
    assert.equal(client.getSnapshot().phase, 'connecting')
    const request = f.calls.find(call => call.path === '/api/live/session')!
    assert.deepEqual(JSON.parse(String(request.options?.body)), { sdp: 'v=0\r\no=mock', language: 'ja', case_id: 'case-a' })
    f.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'other' } }) })
    assert.equal(client.getSnapshot().phase, 'connecting')
    f.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }) })
    assert.equal(client.getSnapshot().phase, 'connected')
    client.setMuted(true); assert.equal(f.track.enabled, false)
    client.setMuted(false); assert.equal(f.track.enabled, true)
    await client.stop()
    assert.ok(f.track.stopped && f.peer.closed && f.channel.closed)
    assert.ok(f.calls.some(call => call.path === '/api/live/session/live_1' && call.options?.method === 'DELETE'))
  } finally { client.dispose() }
  assert.equal(f.source.closed, true)
})

test('Worker proof reaches only the Live creation body for the same case', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus()
  try {
    await client.start('en', 'reception', 'test-worker-proof')
    const request = f.calls.find(call => call.path === '/api/live/session')!
    assert.deepEqual(JSON.parse(String(request.options?.body)), {
      sdp: 'v=0\r\no=mock', language: 'en', case_id: 'case-a', bridge_token: 'test-worker-proof',
    })
    assert.equal(JSON.stringify(client.getSnapshot()).includes('test-worker-proof'), false)
  } finally { client.dispose() }
})

test('manual English is included at start and selection updates the existing voice session', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus()
  try {
    await client.start('en', 'reception', 'proof', 'en')
    assert.equal(JSON.parse(String(f.calls.find(call => call.path === '/api/live/session')!.options!.body)).language_preference, 'en')
    f.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }) })
    f.setCreate(async () => Response.json({ case_id: 'case-a', language: 'ja', language_preference: 'ja' }))
    await client.setLanguage('ja', 'ja')
    assert.equal(client.getSnapshot().language, 'ja')
    assert.equal(client.getSnapshot().phase, 'connected')
    assert.equal(f.track.stopped, false)
    const update = f.calls.find(call => call.path === '/api/live/session/live_1/language')!
    assert.deepEqual(JSON.parse(String(update.options!.body)), { case_id: 'case-a', language: 'ja', language_preference: 'ja' })
    assert.equal(f.calls.filter(call => call.path === '/api/live/session').length, 1)
  } finally { client.dispose() }
})

test('rapid selections serialize updates and the last selected language wins', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus(); await client.start()
  f.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }) })
  let resolve!: (response: Response) => void
  let updates = 0
  f.setCreate(async () => ++updates === 1 ? new Promise<Response>(r => { resolve = r })
    : Response.json({ case_id: 'case-a', language: 'ja', language_preference: 'ja' }))
  try {
    const first = client.setLanguage('en', 'en')
    const last = client.setLanguage('ja', 'ja')
    assert.equal(updates, 1)
    resolve(Response.json({ case_id: 'case-a', language: 'en', language_preference: 'en' }))
    await Promise.all([first, last])
    assert.equal(updates, 2)
    assert.equal(client.getSnapshot().language, 'ja')
  } finally { client.dispose() }
})

test('a failed language update can retry without ending the call, and late replies cannot revive Stop', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus(); await client.start()
  f.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }) })
  try {
    f.setCreate(async () => Response.json({}, { status: 503 }))
    await client.setLanguage('en', 'en')
    assert.match(client.getSnapshot().error, /Could not change/)
    assert.equal(client.getSnapshot().phase, 'connected')
    f.setCreate(async () => Response.json({ case_id: 'case-a', language: 'en', language_preference: 'en' }))
    await client.setLanguage('en', 'en')
    assert.equal(client.getSnapshot().error, '')
    let resolve!: (response: Response) => void
    f.setCreate(async () => new Promise<Response>(r => { resolve = r }))
    const updating = client.setLanguage('ja', 'auto')
    await client.stop()
    resolve(Response.json({ case_id: 'case-a', language: 'ja', language_preference: 'auto' }))
    await updating
    assert.equal(client.getSnapshot().phase, 'ended')
    assert.equal(client.getSnapshot().language, 'en')
  } finally { client.dispose() }
})

test('stop during session creation deletes the late server session and never reconnects', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  let resolveCreate!: (response: Response) => void
  let created!: () => void
  const creating = new Promise<void>(resolve => { created = resolve })
  f.setCreate(() => { created(); return new Promise(resolve => { resolveCreate = resolve }) })
  await client.refreshStatus()
  try {
    const starting = client.start()
    await creating
    await client.stop()
    assert.equal(f.track.stopped, true)
    resolveCreate(Response.json({ session: { id: 'late_session' }, transport: { sdp: 'v=0' }, case_id: 'case-a' }))
    await starting
    assert.equal(f.peer.answer, null)
    assert.equal(client.getSnapshot().phase, 'ended')
    assert.ok(f.calls.some(call => call.path === '/api/live/session/late_session' && call.options?.method === 'DELETE'))
  } finally { client.dispose() }
})

test('stop during microphone permission stops a late microphone stream without creating a server session', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  let allow!: (stream: unknown) => void
  f.setMicrophone(() => new Promise(resolve => { allow = resolve }))
  await client.refreshStatus()
  const starting = client.start()
  await client.stop()
  allow(f.stream); await starting
  assert.equal(f.track.stopped, true)
  assert.equal(f.calls.some(call => call.path === '/api/live/session'), false)
  client.dispose()
})

test('backend errors, malformed create responses and denied microphones are visible and cleaned up', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus()
  f.setCreate(async () => Response.json({ session: { id: 'malformed' }, transport: {} }))
  await client.start()
  assert.equal(client.getSnapshot().phase, 'error')
  assert.equal(f.track.stopped, true)
  assert.ok(f.calls.some(call => call.path === '/api/live/session/malformed'))
  client.dispose()
  const denied = fixture(); const other = new LiveClient('case-a', 'ja', denied.runtime)
  denied.setMicrophone(async () => { throw new DOMException('denied', 'NotAllowedError') })
  await other.refreshStatus(); await other.start()
  assert.match(other.getSnapshot().error, /Microphone permission denied/)
  assert.equal(denied.calls.some(call => call.path === '/api/live/session'), false)
  other.dispose()
})

test('SSE reconnect does not create a microphone session and cannot leak another case backend result', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  client.observe()
  f.source.onerror!(); assert.equal(client.getSnapshot().events, 'reconnecting')
  f.source.onopen!(); assert.equal(client.getSnapshot().events, 'connected')
  f.source.onmessage!({ data: JSON.stringify({ type: 'backend.result', case_id: 'case-b', content: 'Private' }) })
  assert.equal(client.getSnapshot().backendResult, '')
  f.source.onmessage!({ data: JSON.stringify({ type: 'backend.result', case_id: 'case-a', content: 'Our result' }) })
  assert.equal(client.getSnapshot().backendResult, 'Our result')
  assert.equal(f.calls.some(call => call.path === '/api/live/session'), false)
  client.dispose()
})

test('a failed DELETE still stops local audio and reports unconfirmed server cleanup', async () => {
  const f = fixture()
  const fetchApi = f.runtime.fetch
  f.runtime.fetch = async (input, options) => options?.method === 'DELETE'
    ? Response.json({ error: 'Unavailable' }, { status: 503 }) : fetchApi(input, options)
  const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus(); await client.start(); await client.stop()
  assert.ok(f.track.stopped && f.peer.closed && f.channel.closed)
  assert.match(client.getSnapshot().cleanupWarning, /could not be confirmed/)
  client.dispose()
})

test('unconfigured or unreachable servers cannot request a microphone', async () => {
  const f = fixture()
  f.runtime.fetch = async () => Response.json({ live_configured: false, mcp_configured: true, requests: [] })
  let asked = false
  f.setMicrophone(async () => { asked = true; return f.stream })
  const client = new LiveClient('case-a', 'ja', f.runtime)
  await client.refreshStatus(); await client.start()
  assert.equal(asked, false)
  assert.match(client.getSnapshot().error, /configuration/)
  f.runtime.fetch = async () => { throw new Error('offline') }
  await client.refreshStatus(); await client.start()
  assert.equal(client.getSnapshot().configured, null)
  assert.equal(asked, false)
  client.dispose()
})

test('stop mutes capture immediately, waits for backend finalization before closing RTC and blocks a new call', async () => {
  const f = fixture(); const client = new LiveClient('case-a', 'ja', f.runtime)
  const fetchApi = f.runtime.fetch
  let finalize!: (response: Response) => void
  f.runtime.fetch = async (input, options) => options?.method === 'DELETE'
    ? new Promise(resolve => { finalize = resolve }) : fetchApi(input, options)
  await client.refreshStatus(); await client.start()
  const stopping = client.stop()
  assert.equal(f.track.stopped, true)
  assert.equal(f.peer.closed, false)
  assert.equal(client.getSnapshot().phase, 'stopping')
  await client.start()
  assert.equal(f.calls.filter(call => call.path === '/api/live/session').length, 1)
  finalize(Response.json({ closed: true, live_finalized: false, cleanup_pending: [] }))
  await stopping
  assert.ok(f.peer.closed && f.channel.closed)
  assert.equal(client.getSnapshot().phase, 'ended')
  assert.match(client.getSnapshot().cleanupWarning, /finalization is unconfirmed/)
  client.dispose()
})

test('a permanently closed SSE after proxy failure is recreated, and dispose cancels retry', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  let opened = 0
  f.runtime.events = () => { opened++; return f.source as unknown as EventSource }
  const client = new LiveClient('case-a', 'ja', f.runtime)
  client.observe()
  f.source.readyState = 2; f.source.onerror!()
  assert.equal(f.source.closed, true)
  assert.equal(client.getSnapshot().events, 'reconnecting')
  t.mock.timers.tick(3000)
  assert.equal(opened, 2)
  f.source.onerror!()
  client.dispose()
  t.mock.timers.tick(3000)
  assert.equal(opened, 2)
})


test('case proof is sent only to session creation, refreshed, and not retained in snapshots', async () => {
  const f = fixture()
  let count = 0
  const client = new LiveClient('case-a', 'ja', f.runtime, { bridgeToken: async () => `proof-${++count}` })
  try {
    await client.refreshStatus(); await client.start(); await client.stop(); await client.start()
    const creates = f.calls.filter(call => call.path === '/api/live/session')
    assert.equal(JSON.parse(String(creates[0].options?.body)).bridge_token, 'proof-1')
    assert.equal(JSON.parse(String(creates[1].options?.body)).bridge_token, 'proof-2')
    assert.equal(creates[0].options?.redirect, 'manual')
    assert.equal(creates[0].options?.credentials, 'same-origin')
    assert.equal(JSON.stringify(client.getSnapshot()).includes('proof-'), false)
  } finally { await client.stop(); client.dispose() }
})
test('a failed case proof never requests microphone permission or creates a session', async () => {
  const f = fixture()
  let asked = false
  f.setMicrophone(async () => { asked = true; return f.stream })
  const client = new LiveClient('case-a', 'ja', f.runtime, { bridgeToken: async () => { throw new Error('Authenticate first') } })
  await client.refreshStatus(); await client.start()
  assert.equal(asked, false)
  assert.equal(f.calls.some(call => call.path === '/api/live/session'), false)
  assert.match(client.getSnapshot().error, /Authenticate first/)
  client.dispose()
})
test('stop during proof fetching ignores its late success before any microphone or session creation', async () => {
  const f = fixture()
  let resolve!: (proof: string) => void
  let asked = false
  f.setMicrophone(async () => { asked = true; return f.stream })
  const client = new LiveClient('case-a', 'ja', f.runtime, { bridgeToken: () => new Promise(r => { resolve = r }) })
  await client.refreshStatus()
  const starting = client.start()
  await client.stop(); resolve('late-proof'); await starting
  assert.equal(asked, false)
  assert.equal(f.calls.some(call => call.path === '/api/live/session'), false)
  assert.equal(client.getSnapshot().phase, 'ended')
  client.dispose()
})
test('status auth and HTML failures stay visible, and a recovered status clears only its own error', async () => {
  const f = fixture()
  const fetchApi = f.runtime.fetch
  const client = new LiveClient('case-a', 'ja', f.runtime)
  try {
    f.runtime.fetch = async () => Response.json({ detail: 'Case access denied' }, { status: 401 })
    await client.refreshStatus()
    assert.match(client.getSnapshot().error, /Case access denied/)
    assert.equal(client.getSnapshot().configured, null)
    f.runtime.fetch = async () => new Response('<html>Login</html>')
    await client.refreshStatus()
    assert.match(client.getSnapshot().error, /Invalid reception response/)
    f.runtime.fetch = fetchApi
    await client.refreshStatus()
    assert.equal(client.getSnapshot().configured, true)
    assert.equal(client.getSnapshot().error, '')
  } finally { client.dispose() }
})

test('case transport rejects foreign or cross-origin prefixes before sending a request', () => {
  const f = fixture()
  for (const apiPrefix of ['https://example.invalid/api', '/api/v1/cases/case-b/voice', '/api/v1/cases/case-a/voice?x=1']) {
    assert.throws(() => new LiveClient('case-a', 'ja', f.runtime, { apiPrefix }), /same origin/)
  }
  assert.equal(f.calls.length, 0)
})

test('case status failures are actionable, recover on retry, and never open the microphone', async () => {
  const f = fixture()
  let microphones = 0
  let response = () => Response.json({ error: 'voice_relay_unconfigured' }, { status: 503 })
  const client = new LiveClient('case-a', 'ja', { ...f.runtime,
    fetch: async () => response(),
    microphone: async () => { microphones++; return f.stream as unknown as MediaStream },
  }, { apiPrefix: '/api/v1/cases/case-a/voice' })
  try {
    await client.refreshStatus()
    assert.match(client.getSnapshot().error, /voice_relay_unconfigured/)
    await client.start()
    assert.equal(microphones, 0)
    // Clear the unrelated Start error by using a fresh status-only client below.
  } finally { client.dispose() }
  const retry = new LiveClient('case-a', 'ja', { ...f.runtime, fetch: async () => response() }, { apiPrefix: '/api/v1/cases/case-a/voice' })
  try {
    await retry.refreshStatus()
    response = () => Response.json({ live_configured: true, mcp_configured: true })
    await retry.refreshStatus()
    assert.equal(retry.getSnapshot().error, '')
    assert.equal(retry.getSnapshot().configured, true)
    response = () => new Response('<html>Login</html>', { status: 200 })
    await retry.refreshStatus()
    assert.equal(retry.getSnapshot().configured, null)
    assert.match(retry.getSnapshot().error, /Check access/)
  } finally { retry.dispose() }
})
