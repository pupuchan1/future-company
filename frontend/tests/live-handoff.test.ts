import assert from 'node:assert/strict'
import test from 'node:test'
import { LiveClient } from '../src/features/live/client.ts'
import type { LiveRuntime } from '../src/features/live/client.ts'
import type { LiveRoute } from '../src/features/live/types.ts'

const voices = { reception: 'shida', recruiting: 'harema', haas: 'marin' }
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const calls: { path: string; body: Record<string, unknown>; method?: string }[] = []
  const track = { enabled: true, stopped: 0, readyState: 'live', stop() { this.stopped++; this.readyState = 'ended' } }
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
      async createOffer() { return { type: 'offer', sdp: `offer-${peers.length}` } },
      async setLocalDescription(value: { sdp: string }) { this.localDescription = value },
      async setRemoteDescription(value: unknown) { this.answer = value },
      close() { this.closed = true; this.connectionState = 'closed' },
      addEventListener() {}, removeEventListener() {},
    }
  }
  const audios: { srcObject: unknown; autoplay: boolean; paused: boolean; muted: boolean; volume: number; plays: number; play(): Promise<void>; pause(): void }[] = []
  const meters: { disposed: number; dispose(): void; setInput(): void; setOutput(): void }[] = []
  let route: LiveRoute = 'reception'
  let handoff = async (): Promise<Response> => Response.json({ session: { id: 'new' }, transport: { sdp: 'answer-new' }, case_id: 'case-a', old_session_id: 'old', route, voice: voices[route], handoff_token: 'token-1' })
  let activate = async (): Promise<Response> => Response.json({ session: { id: 'new' }, case_id: 'case-a', old_session_id: 'old', route, voice: voices[route], active: true })
  const runtime = {
    async fetch(path: string, options?: RequestInit) {
      const body = options?.body ? JSON.parse(String(options.body)) : {}
      calls.push({ path, body, method: options?.method })
      if (path === '/api/status') return Response.json({ live_configured: true, mcp_configured: true, handoff_configured: true, voice_map: voices, requests: [] })
      if (options?.method === 'DELETE') return Response.json({ live_finalized: true, cleanup_pending: [] })
      if (path.endsWith('/handoff')) { route = body.route; return handoff() }
      if (path.endsWith('/activate')) return activate()
      const initialRoute: LiveRoute = body.route ?? 'reception'
      return Response.json({ session: { id: 'old' }, transport: { sdp: 'answer-old' }, case_id: 'case-a', route: initialRoute, voice: voices[initialRoute] })
    },
    async microphone() { microphoneCalls++; return stream },
    peer() { const peer = makePeer(); peers.push(peer); return peer },
    events: () => source,
    audio() {
      const audio = { srcObject: null as unknown, autoplay: true, paused: true, muted: false, volume: 1, plays: 0,
        async play() { this.plays++; this.paused = false }, pause() { this.paused = true },
      }
      audios.push(audio)
      return audio
    },
    supported: () => true,
    metering() { const meter = { disposed: 0, dispose() { this.disposed++ }, setInput() {}, setOutput() {} }; meters.push(meter); return meter },
  } as unknown as LiveRuntime
  const client = new LiveClient('case-a', 'ja', runtime)
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
    const peer = peers[1]
    assert.ok(peer.answer)
    peer.ontrack!({ streams: [stream] })
    peer.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'new' } }) })
    assert.equal(calls.filter(call => call.path.endsWith('/activate')).length, 0, 'Session start alone is insufficient')
    peer.connectionState = 'connected'; peer.onconnectionstatechange!()
  }
  return { client, runtime, peers, track, stream, source, audios, meters, calls, start, readyCandidate,
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
