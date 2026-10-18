import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveClient, caseVoicePrefix } from '../src/features/live/client.ts'
import type { LiveRuntime } from '../src/features/live/client.ts'
import type { LiveRoute } from '../src/features/live/types.ts'
import type { LiveMediaObserver } from '../src/features/recording/types.ts'

const voices = { reception: 'shida', recruiting: 'harema', haas: 'marin' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(apiPrefix?: string, media?: LiveMediaObserver) {
  const calls: { path: string; body: Record<string, unknown>; method?: string }[] = []
  const eventUrls: (string | undefined)[] = []
  const track = { kind: 'audio', enabled: true, stopped: 0, readyState: 'live', stop() { this.stopped++; this.readyState = 'ended' } }
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
  let microphoneCalls = 0
  const source = {
    readyState: 1, onopen: null as (() => void) | null, onerror: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null, close() {},
  }
  const peers: ReturnType<typeof makePeer>[] = []
  function makePeer() {
    const channel = {
      onmessage: null as ((event: { data: string }) => void) | null, onclose: null as (() => void) | null,
      closed: false, close() { this.closed = true }, send() { assert.fail('No frontend Live command allowed') },
    }
    return {
      channel, connectionState: 'new', iceGatheringState: 'complete', closed: false,
      localDescription: null as null | { sdp: string }, answer: null as unknown,
      ontrack: null as ((event: { streams: MediaStream[] }) => void) | null,
      onconnectionstatechange: null as (() => void) | null, tracks: [] as unknown[],
      addTrack(value: unknown) { this.tracks.push(value) }, createDataChannel: () => channel,
      getSenders() { return this.tracks.map((track, index) => ({ track, replaceTrack: async (next: unknown) => { this.tracks[index] = next } })) },
      async createOffer() { return { type: 'offer', sdp: `offer-${peers.length}` } },
      async setLocalDescription(value: { sdp: string }) { this.localDescription = value },
      async setRemoteDescription(value: unknown) { this.answer = value },
      close() { this.closed = true; this.connectionState = 'closed' },
      addEventListener() {}, removeEventListener() {},
    }
  }
  const audios: { srcObject: unknown; autoplay: boolean; paused: boolean; muted: boolean; volume: number; plays: number; play(): Promise<void>; pause(): void }[] = []
  const meters: { disposed: number; dispose(): void; setInput(): void; setOutput(): void; levels(inputLevel: number, outputLevel: number): void }[] = []
  let route: LiveRoute = 'reception'
  let handoff = async (): Promise<Response> => Response.json({ session: { id: 'new' }, transport: { sdp: 'answer-new' }, case_id: 'case-a', old_session_id: 'old', route, voice: voices[route], handoff_token: 'token-1' })
  let activate = async (): Promise<Response> => Response.json({ session: { id: 'new' }, case_id: 'case-a', old_session_id: 'old', route, voice: voices[route], active: true })
  const runtime = {
    async fetch(path: string, options?: RequestInit) {
      const body = options?.body ? JSON.parse(String(options.body)) : {}
      calls.push({ path, body, method: options?.method })
      if (path.endsWith('/status')) return Response.json({ live_configured: true, mcp_configured: true, handoff_configured: true, prewarm_configured: true, voice_map: voices, requests: [] })
      if (options?.method === 'DELETE') return Response.json({ live_finalized: true, cleanup_pending: [] })
      if (path.endsWith('/handoff')) { route = body.route; return handoff() }
      if (path.endsWith('/activate')) return activate()
      const initialRoute: LiveRoute = body.route ?? 'reception'
      return Response.json({ session: { id: 'old' }, transport: { sdp: 'answer-old' }, case_id: 'case-a', route: initialRoute, voice: voices[initialRoute] })
    },
    async microphone() { microphoneCalls++; return stream },
    peer() { const peer = makePeer(); peers.push(peer); return peer },
    events: (url?: string) => { eventUrls.push(url); return source },
    audio() {
      const audio = { srcObject: null as unknown, autoplay: true, paused: true, muted: false, volume: 1, plays: 0,
        async play() { this.plays++; this.paused = false }, pause() { this.paused = true },
      }
      audios.push(audio)
      return audio
    },
    supported: () => true,
    metering(onLevels: (levels: { inputLevel: number; outputLevel: number }) => void) { const meter = { disposed: 0, dispose() { this.disposed++ }, setInput() {}, setOutput() {}, levels(inputLevel: number, outputLevel: number) { onLevels({ inputLevel, outputLevel }) } }; meters.push(meter); return meter },
  } as unknown as LiveRuntime
  const client = new LiveClient('case-a', 'ja', runtime, { apiPrefix, media })
  async function start(initialRoute: LiveRoute = 'reception') {
    client.observe(); await tick()
    await client.start('ja', initialRoute)
    peers[0].channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'old' } }) })
    peers[0].connectionState = 'connected'; peers[0].onconnectionstatechange!()
    peers[0].ontrack!({ streams: [stream] })
    await tick()
  }
  async function readyCandidate() {
    await tick()
    const peer = peers.at(-1)!
    assert.ok(peer.answer)
    peer.ontrack!({ streams: [stream] })
    peer.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'new' } }) })
    assert.equal(calls.filter(call => call.path.endsWith('/activate')).length, 0, 'Session start alone is insufficient')
    peer.connectionState = 'connected'; peer.onconnectionstatechange!()
  }
  return { client, runtime, peers, track, stream, source, audios, meters, calls, eventUrls, start, readyCandidate,
    microphoneCalls: () => microphoneCalls,
    setHandoff: (next: typeof handoff) => { handoff = next },
    setActivate: (next: typeof activate) => { activate = next },
    activationResponse: () => Response.json({ session: { id: 'new' }, case_id: 'case-a', old_session_id: 'old', route, voice: voices[route], active: true }),
  }
}

test('initial department selects its voice; switch waits for both readiness signals and preserves shared capture', async () => {
  const f = fixture()
  await f.start('recruiting')
  try {
    assert.equal(f.client.getSnapshot().voiceRoute, 'recruiting')
    assert.equal(f.client.getSnapshot().voice, 'harema')
    assert.equal(f.client.getSnapshot().switchConfigured, true)
    assert.deepEqual(f.client.getSnapshot().voiceMap, voices)
    const switching = f.client.switchDepartment('haas')
    assert.equal(f.client.getSnapshot().phase, 'switching')
    assert.equal(f.track.enabled, false)
    assert.equal(f.audios[0].paused, true)
    assert.equal(f.track.stopped, 0)
    await f.readyCandidate()
    assert.equal(f.audios[1].plays, 0, 'Candidate must remain silent before activation')
    await switching
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.client.getSnapshot().voiceRoute, 'haas')
    assert.equal(f.client.getSnapshot().voice, 'marin')
    assert.equal(f.client.getSnapshot().route, 'recruiting', 'Business routing is distinct from the actual voice')
    assert.equal(f.microphoneCalls(), 1)
    assert.equal(f.peers[0].tracks[0], f.peers[1].tracks[0])
    assert.equal(f.track.enabled, true)
    assert.equal(f.track.stopped, 0)
    assert.equal(f.peers[0].closed, true)
    assert.equal(f.meters[0].disposed, 1)
    assert.equal(f.meters[1].disposed, 0)
    assert.equal(f.audios[1].plays, 1)
    f.source.onmessage!({ data: JSON.stringify({ type: 'live.closed', case_id: 'case-a', session_id: 'old' }) })
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.track.stopped, 0)
    await f.client.stop()
    assert.equal(f.track.stopped, 1)
    assert.equal(f.meters[1].disposed, 1)
    assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/live/session/new'])
  } finally { f.client.dispose() }
})

for (const source of ['server', 'datachannel'] as const) for (const closed of [false, true]) {
  test(`candidate ${closed ? 'close' : 'start'} on ${source} before the handoff HTTP response stays bound to its candidate`, async () => {
    const f = fixture(); await f.start()
    let respond!: (response: Response) => void
    f.setHandoff(() => new Promise(resolve => { respond = resolve }))
    const switching = f.client.switchDepartment('haas')
    await tick()
    try {
      serverEvent(f, { type: 'live.closed', session_id: 'unrelated-old' })
      const event = { type: closed ? 'live.closed' : 'session.started', case_id: 'case-a', session_id: 'new' }
      if (source === 'server') serverEvent(f, event)
      else f.peers[1].channel.onmessage!({ data: JSON.stringify(event) })
      assert.equal(f.client.getSnapshot().phase, 'switching')
      assert.equal(f.track.stopped, 0)
      respond(Response.json({ session: { id: 'new' }, transport: { sdp: 'answer-new' }, case_id: 'case-a',
        old_session_id: 'old', route: 'haas', voice: 'marin', handoff_token: 'token-1' }))
      await tick()
      if (!closed) {
        f.peers[1].ontrack!({ streams: [f.stream] })
        f.peers[1].connectionState = 'connected'; f.peers[1].onconnectionstatechange!()
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([switching, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Early candidate lifecycle was lost')), 1000) })])
      } finally { clearTimeout(timer) }
      assert.equal(f.client.getSnapshot().phase, 'connected')
      assert.equal(f.client.getSnapshot().voiceRoute, closed ? 'reception' : 'haas')
      assert.equal(f.track.stopped, 0)
      assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, closed ? 0 : 1)
      if (closed) assert.equal(f.peers[1].answer, null)
    } finally {
      await f.client.stop(); await switching; f.client.dispose()
    }
  })
}

test('busy handoff restores old playback and preserves the prior mute state', async () => {
  const f = fixture(); await f.start()
  f.client.setMuted(true)
  f.setHandoff(async () => Response.json({ error: 'busy' }, { status: 409 }))
  try {
    await f.client.switchDepartment('haas')
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.client.getSnapshot().voice, 'shida')
    assert.equal(f.client.getSnapshot().muted, true)
    assert.equal(f.track.enabled, false)
    assert.equal(f.track.stopped, 0)
    assert.equal(f.peers[0].closed, false)
    assert.equal(f.peers[1].closed, true)
    assert.equal(f.audios[0].paused, false)
    assert.equal(f.meters[1].disposed, 1)
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('definite activation rejection deletes only the candidate and resumes the old connection', async () => {
  const f = fixture(); await f.start()
  f.setActivate(async () => Response.json({ error: 'handoff_expired' }, { status: 409 }))
  try {
    const switching = f.client.switchDepartment('recruiting')
    await f.readyCandidate(); await switching
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.client.getSnapshot().voiceRoute, 'reception')
    assert.equal(f.peers[0].closed, false)
    assert.equal(f.peers[1].closed, true)
    assert.equal(f.track.enabled, true)
    assert.equal(f.track.stopped, 0)
    assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/live/session/new'])
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 1)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('a response lost after activation is retried with the same token; old close cannot stop the new call', async () => {
  const f = fixture(); await f.start()
  let count = 0
  f.setActivate(async () => {
    count++
    if (count === 1) {
      f.source.onmessage!({ data: JSON.stringify({ type: 'live.closed', case_id: 'case-a', session_id: 'old' }) })
      throw new Error('Response lost after commit')
    }
    return f.activationResponse()
  })
  try {
    const switching = f.client.switchDepartment('haas')
    await f.readyCandidate(); await switching
    assert.equal(count, 2)
    assert.equal(f.client.getSnapshot().voice, 'marin')
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.track.stopped, 0)
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0)
    assert.deepEqual(f.calls.filter(call => call.path.endsWith('/activate')).map(call => call.body), [{ handoff_token: 'token-1' }, { handoff_token: 'token-1' }])
  } finally { await f.client.stop(); f.client.dispose() }
})

test('unknown activation stays muted without deleting a possibly committed session; explicit Stop closes both', async () => {
  const f = fixture(); await f.start()
  f.setActivate(async () => { throw new Error('Network unavailable') })
  try {
    const switching = f.client.switchDepartment('haas')
    await f.readyCandidate(); await switching
    assert.equal(f.client.getSnapshot().phase, 'switching')
    assert.match(f.client.getSnapshot().error, /outcome is unconfirmed/)
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 3)
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0)
    assert.equal(f.track.enabled, false)
    assert.equal(f.track.stopped, 0)
    await f.client.stop()
    assert.equal(f.track.stopped, 1)
    assert.equal(f.peers.every(peer => peer.closed), true)
    assert.equal(f.meters.every(meter => meter.disposed === 1), true)
    assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/live/session/new', '/api/live/session/old'])
  } finally { f.client.dispose() }
})

test('Stop while the candidate HTTP request is pending cleans up its late response without stopping capture twice', async () => {
  const f = fixture(); await f.start()
  let resolveHandoff!: (response: Response) => void
  f.setHandoff(() => new Promise(resolve => { resolveHandoff = resolve }))
  const switching = f.client.switchDepartment('haas')
  await tick()
  await f.client.stop()
  assert.equal(f.track.stopped, 1)
  resolveHandoff(Response.json({ session: { id: 'late' }, transport: { sdp: 'answer' }, case_id: 'case-a', route: 'haas', voice: 'marin', old_session_id: 'old', handoff_token: 'late-token' }))
  await switching
  assert.equal(f.client.getSnapshot().phase, 'ended')
  assert.equal(f.peers[1].answer, null)
  assert.equal(f.peers.every(peer => peer.closed), true)
  assert.equal(f.track.stopped, 1)
  assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/live/session/old', '/api/live/session/late'])
  f.client.dispose()
})

test('Stop during readiness wait rejects the candidate wait and never activates', async () => {
  const f = fixture(); await f.start()
  const switching = f.client.switchDepartment('haas')
  await tick()
  await f.client.stop(); await switching
  assert.equal(f.client.getSnapshot().phase, 'ended')
  assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0)
  assert.equal(f.track.stopped, 1)
  assert.equal(f.peers.every(peer => peer.closed), true)
  f.client.dispose()
})

test('Stop during activation keeps a late success from reconnecting or unmuting shared capture', async () => {
  const f = fixture(); await f.start()
  let resolveActivation!: (response: Response) => void
  f.setActivate(() => new Promise(resolve => { resolveActivation = resolve }))
  const switching = f.client.switchDepartment('haas')
  await f.readyCandidate(); await tick()
  await f.client.stop()
  resolveActivation(f.activationResponse())
  await switching
  assert.equal(f.client.getSnapshot().phase, 'ended')
  assert.equal(f.track.stopped, 1)
  assert.equal(f.track.enabled, false)
  assert.equal(f.audios[1].plays, 0)
  assert.equal(f.peers.every(peer => peer.closed), true)
  assert.deepEqual(f.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/live/session/new', '/api/live/session/old'])
  f.client.dispose()
})

test('a malformed candidate identity cannot delete the original session during rollback', async () => {
  const f = fixture(); await f.start()
  f.setHandoff(async () => Response.json({ session: { id: 'old' }, transport: { sdp: 'answer-new' }, case_id: 'case-a', old_session_id: 'old', route: 'haas', voice: 'marin', handoff_token: 'token-1' }))
  try {
    await f.client.switchDepartment('haas')
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.client.getSnapshot().voice, 'shida')
    assert.equal(f.calls.filter(call => call.method === 'DELETE').length, 0)
    assert.equal(f.peers[0].closed, false)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('candidate readiness timeout restores the old call and removes the candidate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(); await f.start()
  try {
    const switching = f.client.switchDepartment('haas')
    await tick()
    t.mock.timers.tick(20000)
    await switching
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.client.getSnapshot().voice, 'shida')
    assert.equal(f.track.enabled, true)
    assert.equal(f.track.stopped, 0)
    assert.equal(f.peers[0].closed, false)
    assert.equal(f.peers[1].closed, true)
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0)
  } finally { await f.client.stop(); f.client.dispose() }
})


test('Worker prefix scopes status, SSE, create, handoff, activation and final cleanup to one case', async () => {
  const prefix = caseVoicePrefix('case-a')
  const f = fixture(prefix)
  try {
    await f.start()
    const switching = f.client.switchDepartment('haas')
    await f.readyCandidate(); await switching; await f.client.stop()
    assert.deepEqual(f.eventUrls, [`${prefix}/events`])
    assert.ok(f.calls.some(call => call.path === `${prefix}/status`))
    assert.ok(f.calls.some(call => call.path === `${prefix}/session`))
    assert.ok(f.calls.some(call => call.path === `${prefix}/session/old/handoff`))
    assert.ok(f.calls.some(call => call.path === `${prefix}/session/new/activate`))
    assert.ok(f.calls.some(call => call.path === `${prefix}/session/new` && call.method === 'DELETE'))
    assert.ok(f.calls.every(call => call.path.startsWith(`${prefix}/`)))
  } finally { f.client.dispose() }
})
test('voice transport rejects absolute URLs and prefixes for another Worker case', () => {
  for (const prefix of ['https://example.com/api', '/api/v1/cases/other/voice', '/api/v1/cases/case-a/voice/']) {
    assert.throws(() => fixture(prefix), /same origin/)
  }
  assert.throws(() => caseVoicePrefix('../other'), /Invalid Worker case/)
})

test('a transient status failure during an active call preserves negotiated switching capability', async () => {
  const f = fixture(); await f.start()
  const fetchApi = f.runtime.fetch
  try {
    f.runtime.fetch = async () => { throw new DOMException('signal timed out', 'TimeoutError') }
    await f.client.refreshStatus()
    assert.equal(f.client.getSnapshot().switchConfigured, true)
    assert.equal(f.client.getSnapshot().configured, true)
    assert.match(f.client.getSnapshot().error, /timed out/)
    f.runtime.fetch = fetchApi
    const switching = f.client.switchDepartment('haas')
    await f.readyCandidate(); await switching
    assert.equal(f.client.getSnapshot().voice, 'marin')
    await f.client.refreshStatus()
    assert.equal(f.client.getSnapshot().error, '')
    f.runtime.fetch = async () => Response.json({ detail: 'Case access denied' }, { status: 403 })
    await f.client.refreshStatus()
    assert.equal(f.client.getSnapshot().switchConfigured, false)
  } finally { f.runtime.fetch = fetchApi; await f.client.stop(); f.client.dispose() }
})

function serverEvent(f: ReturnType<typeof fixture>, event: Record<string, unknown>) {
  f.source.onmessage!({ data: JSON.stringify({ case_id: 'case-a', ...event }) })
}
const routedToHaas = { type: 'routing.updated', session_id: 'old', source_event_id: 'input-1', source: 'decisions', route: 'haas', language: 'ja' }

function enablePrewarm(f: ReturnType<typeof fixture>) {
  const clone = { ...f.track, stopped: 0 }
  Object.assign(f.stream, { clone: () => ({ getAudioTracks: () => [clone], getTracks: () => [clone] }) })
  return clone
}

test('early routing activates the prepared specialist before any business result, despite room noise', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture(); enablePrewarm(f); await f.start()
  try {
    assert.equal(f.calls.find(call => call.path.endsWith('/session'))?.body.handoff_before_work, true)
    serverEvent(f, { ...routedToHaas, route: 'recruiting', handoff_before_work: true })
    await f.readyCandidate(); await tick()
    for (let i = 0; i < 20; i++) { f.meters[0].levels(.02, 0); t.mock.timers.tick(100); await tick() }
    assert.equal(f.client.getSnapshot().voice, 'harema')
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 1)
    assert.equal(f.peers[0].closed, true)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('confirmed route prepares muted replacement while old voice works, then activates without a second offer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture(); const clone = enablePrewarm(f); await f.start()
  try {
    serverEvent(f, routedToHaas)
    serverEvent(f, { type: 'backend.started', event_id: 'job' })
    await f.readyCandidate(); await tick()
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.track.enabled, true, 'Original microphone stays live during preparation')
    assert.equal(f.audios[0].paused, false)
    assert.equal(f.audios[1].plays, 0)
    assert.equal(clone.enabled, false, 'No caller audio reaches the waiting replacement')
    assert.equal(f.calls.find(call => call.path.endsWith('/handoff'))?.body.prewarm, true)
    t.mock.timers.tick(2000); await tick()
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0)
    serverEvent(f, { type: 'backend.result', event_id: 'ready', content: 'Verified answer' })
    f.meters[0].levels(0, .2); f.meters[0].levels(0, 0)
    t.mock.timers.tick(1500); await tick(); await tick()
    assert.equal(f.client.getSnapshot().voice, 'marin')
    assert.equal(f.peers.length, 2)
    assert.equal(f.calls.filter(call => call.path.endsWith('/handoff')).length, 1)
    assert.equal(f.peers[1].tracks[0], f.track)
    assert.equal(clone.stopped, 1)
    assert.equal(f.track.stopped, 0)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('route cancellation releases the ready replacement and leaves the original microphone and playback running', async () => {
  const f = fixture(); const clone = enablePrewarm(f); await f.start()
  try {
    serverEvent(f, routedToHaas)
    await f.readyCandidate(); await tick()
    serverEvent(f, { ...routedToHaas, source_event_id: 'input-2', route: 'reception' })
    await tick()
    assert.equal(f.peers[1].closed, true)
    assert.equal(clone.stopped, 1)
    assert.equal(f.peers[0].closed, false)
    assert.equal(f.track.enabled, true)
    assert.equal(f.track.stopped, 0)
    assert.equal(f.audios[0].paused, false)
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0)
    assert.ok(f.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/new')))
  } finally { await f.client.stop(); f.client.dispose() }
})

test('Stop during background creation closes a late replacement without reviving the old call', async () => {
  const f = fixture(); const clone = enablePrewarm(f); await f.start()
  let respond!: (value: Response) => void
  f.setHandoff(() => new Promise(resolve => { respond = resolve }))
  serverEvent(f, routedToHaas); await tick()
  await f.client.stop()
  respond(Response.json({ session: { id: 'late-warm' }, transport: { sdp: 'answer' }, case_id: 'case-a',
    old_session_id: 'old', route: 'haas', voice: 'marin', handoff_token: 'late-token' }))
  await tick(); await tick()
  assert.equal(f.client.getSnapshot().phase, 'ended')
  assert.equal(clone.stopped, 1)
  assert.equal(f.track.stopped, 1)
  assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0)
  assert.ok(f.calls.some(call => call.method === 'DELETE' && call.path.endsWith('/late-warm')))
  f.client.dispose()
})

test('confirmed routing switches voice once after backend result and actual speech become quiet', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture(); await f.start()
  try {
    serverEvent(f, { ...routedToHaas, type: 'routing.candidate' })
    t.mock.timers.tick(2000); await tick()
    assert.equal(f.peers.length, 1)
    serverEvent(f, routedToHaas)
    serverEvent(f, { type: 'backend.started' })
    f.meters[0].levels(0, .2)
    t.mock.timers.tick(2000); await tick()
    assert.equal(f.peers.length, 1, 'Backend work must finish first')
    const result = { type: 'backend.result', event_id: 'result-1', content: 'The verified answer' }
    serverEvent(f, result)
    f.meters[0].levels(0, 0)
    t.mock.timers.tick(2000); await tick()
    assert.equal(f.peers.length, 1, 'Do not interrupt a result before any audio is observed')
    f.meters[0].levels(0, .2); f.meters[0].levels(0, 0)
    t.mock.timers.tick(1400); await tick()
    assert.equal(f.peers.length, 1)
    f.meters[0].levels(.2, 0)
    t.mock.timers.tick(1400); await tick()
    assert.equal(f.peers.length, 1, 'New caller speech gets a grace period before its transcript arrives')
    f.meters[0].levels(0, 0)
    serverEvent(f, result)
    t.mock.timers.tick(1500); await tick()
    assert.equal(f.peers.length, 2)
    assert.equal(f.calls.find(call => call.path.endsWith('/handoff'))!.body.automatic, true)
    await f.readyCandidate(); await tick()
    assert.equal(f.client.getSnapshot().voice, 'marin')
    serverEvent(f, routedToHaas)
    t.mock.timers.tick(5000); await tick()
    assert.equal(f.peers.length, 2, 'Repeated routing event must not start another switch')
    assert.equal(f.track.stopped, 0)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('room noise cannot keep the reception voice after the specialist is ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture(); enablePrewarm(f); await f.start()
  try {
    serverEvent(f, { ...routedToHaas, route: 'recruiting' })
    await f.readyCandidate(); await tick()
    serverEvent(f, { type: 'backend.result', event_id: 'answer', content: '採用担当へおつなぎします。' })
    for (let frame = 0; frame < 30; frame++) {
      f.meters[0].levels(.02, .2)
      t.mock.timers.tick(100); await tick()
    }
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0, 'AI output must finish first')
    const speech = { type: 'session.input_transcript.delta', event_id: 'real-caller', delta: 'はい、お願いします。' }
    serverEvent(f, speech)
    for (let frame = 0; frame < 14; frame++) {
      f.meters[0].levels(frame === 0 ? 0 : .02, 0)
      t.mock.timers.tick(100); await tick()
    }
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 0, 'Fresh caller transcript gets a quiet interval')
    serverEvent(f, speech)
    for (let frame = 0; frame < 4; frame++) {
      f.meters[0].levels(frame % 2 ? .02 : 0, 0)
      t.mock.timers.tick(100); await tick()
    }
    assert.equal(f.client.getSnapshot().voice, 'harema')
    assert.equal(f.calls.filter(call => call.path.endsWith('/activate')).length, 1)
    assert.equal(f.peers[0].closed, true)
    assert.equal(f.audios[0].paused, true)
    assert.ok(f.audios[1].plays > 0)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('automatic busy retries are bounded and duplicate routing cannot reset the budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture(); await f.start()
  f.setHandoff(async () => Response.json({ error: 'still busy', code: 'busy' }, { status: 409 }))
  try {
    serverEvent(f, routedToHaas)
    serverEvent(f, { type: 'backend.result', content: 'Ready' })
    f.meters[0].levels(0, .2); f.meters[0].levels(0, 0)
    for (let attempt = 0; attempt < 3; attempt++) { t.mock.timers.tick(1600); await tick() }
    assert.equal(f.calls.filter(call => call.path.endsWith('/handoff')).length, 3)
    serverEvent(f, routedToHaas)
    t.mock.timers.tick(5000); await tick()
    assert.equal(f.calls.filter(call => call.path.endsWith('/handoff')).length, 3)
    assert.equal(f.client.getSnapshot().phase, 'connected')
    assert.equal(f.peers[0].closed, false)
    assert.equal(f.track.stopped, 0)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('WebRTC audio measurements allow automatic handoff when Web Audio is unavailable', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const f = fixture(); f.runtime.metering = undefined; await f.start()
  let outputLevel = .2
  Object.assign(f.peers[0], { getStats: async () => new Map([
    ['mic', { type: 'media-source', kind: 'audio', audioLevel: 0 }],
    ['speaker', { type: 'inbound-rtp', kind: 'audio', audioLevel: outputLevel }],
  ]) })
  try {
    serverEvent(f, routedToHaas)
    serverEvent(f, { type: 'backend.result', event_id: 'rtc-result', content: 'Verified answer' })
    t.mock.timers.tick(250); await tick()
    assert.equal(f.client.getSnapshot().meteringAvailable, true)
    assert.equal(f.client.getSnapshot().speaking, 'assistant')
    outputLevel = 0
    t.mock.timers.tick(250); await tick()
    t.mock.timers.tick(1500); await tick()
    assert.equal(f.peers.length, 2, 'Unavailable Web Audio must not hold the call forever')
    await f.readyCandidate(); await tick()
    assert.equal(f.client.getSnapshot().voice, 'marin')
  } finally { await f.client.stop(); f.client.dispose() }
})

test('manual selection and Stop cancel a pending automatic handoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const f = fixture(); await f.start()
  try {
    serverEvent(f, routedToHaas)
    serverEvent(f, { type: 'backend.result', content: 'Ready' })
    f.meters[0].levels(0, .2); f.meters[0].levels(0, 0)
    await f.client.switchDepartment('reception')
    t.mock.timers.tick(3000); await tick()
    assert.equal(f.peers.length, 1)
    serverEvent(f, { ...routedToHaas, source_event_id: 'input-2' })
    serverEvent(f, { type: 'backend.result', content: 'Ready' })
    f.meters[0].levels(0, .2); f.meters[0].levels(0, 0)
    await f.client.stop()
    t.mock.timers.tick(3000); await tick()
    assert.equal(f.peers.length, 1)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('recording keeps one microphone, excludes candidate audio until activation and stops once', async () => {
  const inputs: MediaStream[] = []; const outputs: (MediaStream | null)[] = []; const enabled: boolean[][] = []
  let stopped = 0
  const media: LiveMediaObserver = { setInput: stream => inputs.push(stream), setOutput: stream => outputs.push(stream), setEnabled: (input, output) => enabled.push([input, output]), stop: () => { stopped++ } }
  const f = fixture(undefined, media); await f.start()
  let activate!: (response: Response) => void
  f.setActivate(() => new Promise(resolve => { activate = resolve }))
  try {
    assert.deepEqual(inputs, [f.stream]); assert.equal(outputs.at(-1), f.stream)
    const switching = f.client.switchDepartment('haas')
    assert.deepEqual(enabled.at(-1), [false, false])
    await f.readyCandidate(); await tick()
    const candidateAudio = { name: 'candidate' } as unknown as MediaStream
    f.peers[1].ontrack!({ streams: [candidateAudio] })
    assert.equal(outputs.includes(candidateAudio), false)
    assert.equal(stopped, 0); assert.equal(f.track.stopped, 0)
    activate(f.activationResponse()); await switching
    assert.equal(outputs.at(-1), candidateAudio)
    assert.deepEqual(enabled.at(-1), [true, true])
    assert.equal(inputs.length, 1); assert.equal(f.microphoneCalls(), 1)
    f.client.setMuted(true); assert.deepEqual(enabled.at(-1), [false, true])
    await f.client.stop(); f.client.dispose()
    assert.equal(stopped, 1); assert.equal(f.track.stopped, 1)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('recording resumes the old call after a failed switch without restarting or finalizing its capture', async () => {
  const outputs: (MediaStream | null)[] = []; const enabled: boolean[][] = []
  let inputs = 0; let stopped = 0
  const media: LiveMediaObserver = { setInput: () => { inputs++ }, setOutput: stream => outputs.push(stream), setEnabled: (input, output) => enabled.push([input, output]), stop: () => { stopped++ } }
  const f = fixture(undefined, media); await f.start()
  f.setHandoff(async () => Response.json({ error: 'busy' }, { status: 409 }))
  try {
    await f.client.switchDepartment('haas')
    assert.equal(outputs.at(-1), f.stream)
    assert.deepEqual(enabled.at(-1), [true, true])
    assert.equal(inputs, 1); assert.equal(stopped, 0); assert.equal(f.track.stopped, 0)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('the latest manual language survives a delayed old-session reply across handoff', async () => {
  const f = fixture()
  await f.start()
  const originalFetch = f.runtime.fetch
  let serverPreference = 'ja'
  const languageCalls: { path: string; language: string }[] = []
  let completeOld!: (response: Response) => void
  f.runtime.fetch = (async (path: string, options?: RequestInit) => {
    if (!path.endsWith('/language')) return originalFetch(path, options)
    const input = JSON.parse(String(options?.body))
    serverPreference = input.language_preference
    languageCalls.push({ path, language: input.language })
    const result = { session: { id: path.includes('/old/') ? 'old' : 'new' }, case_id: 'case-a', language: input.language, language_preference: input.language_preference }
    if (input.language === 'en') return new Promise<Response>(resolve => { completeOld = resolve })
    return Response.json(result)
  }) as typeof fetch
  try {
    await f.client.setLanguage('ja', 'ja')
    const first = f.client.setLanguage('en', 'en')
    const latest = f.client.setLanguage('ja', 'ja')
    assert.equal(serverPreference, 'en', 'The server applied English before its HTTP response arrives')
    const switching = f.client.switchDepartment('recruiting')
    await f.readyCandidate(); await switching
    assert.equal(f.client.getSnapshot().phase, 'connected')
    // useLiveConnection retries the current selection when the new transport connects.
    await f.client.setLanguage('ja', 'ja')
    completeOld(Response.json({ session: { id: 'old' }, case_id: 'case-a', language: 'en', language_preference: 'en' }))
    await Promise.all([first, latest])
    assert.equal(serverPreference, 'ja', 'The new session must receive the latest manual selection even if it equals the old cached selection')
    assert.deepEqual(languageCalls.at(-1), { path: '/api/live/session/new/language', language: 'ja' })
  } finally { await f.client.stop(); f.client.dispose() }
})
