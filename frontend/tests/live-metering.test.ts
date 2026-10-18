import { measureSignal, SILENT_SIGNAL } from '../src/features/voice/activity.ts'
import type { VoiceActivity } from '../src/features/voice/activity.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createAudioMeter, LiveClient } from '../src/features/live/client.ts'
import type { LiveAudioLevels, LiveRuntime } from '../src/features/live/client.ts'

function streamFixture() {
  const track = { enabled: true, readyState: 'live', stopped: false, stop() { this.stopped = true; this.readyState = 'ended' } }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  return { track, stream }
}

function audioContextFixture() {
  const analysers: { amplitude: number; disconnected: number; fftSize: number; smoothingTimeConstant: number; getFloatTimeDomainData(data: Float32Array): void; disconnect(): void }[] = []
  const sources: { connected: unknown; disconnected: number; connect(node: unknown): void; disconnect(): void }[] = []
  const context = {
    state: 'running', closed: 0, resumed: 0,
    createMediaStreamSource() {
      const source = { connected: null as unknown, disconnected: 0, connect(node: unknown) { this.connected = node }, disconnect() { this.disconnected++ } }
      sources.push(source)
      return source
    },
    createAnalyser() {
      const analyser = { amplitude: 0, disconnected: 0, fftSize: 0, smoothingTimeConstant: 0,
        getFloatTimeDomainData(data: Float32Array) { data.fill(this.amplitude) },
        disconnect() { this.disconnected++ },
      }
      analysers.push(analyser)
      return analyser
    },
    async close() { this.closed++; this.state = 'closed' },
    async resume() { this.resumed++; this.state = 'running' },
  }
  return { context, analysers, sources }
}

test('Web Audio reads RMS at 10 Hz, silences inactive tracks/context and disconnects every node', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = audioContextFixture()
  const microphone = streamFixture()
  const remote = streamFixture()
  const samples: LiveAudioLevels[] = []
  const meter = createAudioMeter(value => samples.push(value), () => f.context as unknown as AudioContext)!
  meter.setInput(microphone.stream)
  meter.setOutput(remote.stream)
  f.analysers[0].amplitude = 0.25
  f.analysers[1].amplitude = 0.5
  t.mock.timers.tick(99)
  assert.equal(samples.length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(samples.at(-1), { inputLevel: 0.25, outputLevel: 0.5 })
  assert.equal(samples.length, 1)
  assert.equal(f.sources[0].connected, f.analysers[0], 'Microphone connects only to its analyser, never destination')
  microphone.track.enabled = false
  t.mock.timers.tick(100)
  assert.deepEqual(samples.at(-1), { inputLevel: 0, outputLevel: 0.5 })
  remote.track.readyState = 'ended'
  t.mock.timers.tick(100)
  assert.deepEqual(samples.at(-1), { inputLevel: 0, outputLevel: 0 })
  microphone.track.enabled = true
  f.context.state = 'suspended'
  t.mock.timers.tick(100)
  assert.deepEqual(samples.at(-1), { inputLevel: 0, outputLevel: 0 })
  meter.resume?.()
  assert.equal(f.context.resumed, 1)
  const replacement = streamFixture()
  meter.setOutput(replacement.stream)
  assert.equal(f.sources[1].disconnected, 1)
  assert.equal(f.analysers[1].disconnected, 1)
  meter.dispose()
  meter.dispose()
  const count = samples.length
  t.mock.timers.tick(1000)
  assert.equal(samples.length, count, 'Disposed meter cannot publish stale samples')
  assert.equal(f.context.closed, 1)
  assert.equal(f.sources[0].disconnected, 1)
  assert.equal(f.analysers[0].disconnected, 1)
  assert.equal(f.sources[2].disconnected, 1)
  assert.equal(f.analysers[2].disconnected, 1)
  meter.setInput(replacement.stream)
  assert.equal(f.sources.length, 3)
})

test('unavailable Web Audio is optional; partially attached sources still disconnect', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  assert.equal(createAudioMeter(() => assert.fail('No samples expected'), () => { throw new Error('unsupported') }), null)
  const f = audioContextFixture()
  f.context.createAnalyser = () => { throw new Error('unavailable analyser') }
  const samples: LiveAudioLevels[] = []
  const meter = createAudioMeter(value => samples.push(value), () => f.context as unknown as AudioContext)!
  meter.setInput(streamFixture().stream)
  assert.equal(f.sources[0].disconnected, 1)
  t.mock.timers.tick(100)
  assert.deepEqual(samples, [{ inputLevel: 0, outputLevel: 0 }])
  meter.dispose()
  assert.equal(f.context.closed, 1)
})

function clientFixture() {
  const microphone = streamFixture()
  const remote = streamFixture()
  let publish: (levels: LiveAudioLevels) => void = () => assert.fail('Meter not constructed')
  let publishActivity: ((activity: VoiceActivity) => void) | undefined
  let meterDisposed = 0
  let input: MediaStream | undefined
  let output: MediaStream | undefined
  const audio = { paused: true, muted: false, volume: 1, srcObject: null as unknown,
    async play() { this.paused = false }, pause() { this.paused = true },
  }
  const channel = { onmessage: null as ((event: { data: string }) => void) | null, onclose: null, close() {} }
  const source = { onmessage: null as ((event: { data: string }) => void) | null, close() {} }
  const peer = {
    iceGatheringState: 'complete', connectionState: 'new', localDescription: null as null | { sdp: string },
    ontrack: null as ((event: { streams: MediaStream[] }) => void) | null,
    onconnectionstatechange: null, addTrack() {}, createDataChannel: () => channel,
    async createOffer() { return { type: 'offer', sdp: 'v=0' } },
    async setLocalDescription(offer: { sdp: string }) { this.localDescription = offer },
    async setRemoteDescription() {}, close() {},
  }
  const runtime = {
    fetch: async (path: string, options?: RequestInit) => path === '/api/status'
      ? Response.json({ live_configured: true, mcp_configured: true, requests: [] })
      : options?.method === 'DELETE' ? Response.json({ live_finalized: true, cleanup_pending: [] })
        : Response.json({ session: { id: 'live_1' }, transport: { sdp: 'v=0' }, case_id: 'case-a' }),
    microphone: async () => microphone.stream, peer: () => peer, audio: () => audio, supported: () => true,
    events: () => source,
    metering: (callback: (levels: LiveAudioLevels) => void, activity?: (value: VoiceActivity) => void) => {
      publish = callback
      publishActivity = activity
      return { setInput(stream: MediaStream) { input = stream }, setOutput(stream: MediaStream) { output = stream }, dispose() { meterDisposed++ } }
    },
  } as unknown as LiveRuntime
  const client = new LiveClient('case-a', 'ja', runtime)
  return { client, runtime, microphone, remote, audio, peer, channel, source,
    sample: (inputLevel: number, outputLevel: number) => {
      publish({ inputLevel, outputLevel })
      publishActivity?.({ available: true, input: measureSignal(new Float32Array(512).fill(inputLevel)), output: measureSignal(new Float32Array(512).fill(outputLevel)) })
    },
    disposed: () => meterDisposed, input: () => input, output: () => output,
  }
}

test('speaking comes from measured audio only; muted/paused/inaudible output and near silence do not speak', async () => {
  const f = clientFixture()
  await f.client.refreshStatus()
  await f.client.start()
  try {
    assert.equal(f.client.getSnapshot().meteringAvailable, true)
    assert.equal(f.input(), f.microphone.stream)
    f.sample(0.03, 0.5)
    assert.equal(f.client.getSnapshot().speaking, 'user', 'No output stream is playing yet')
    assert.equal(f.client.getSnapshot().outputLevel, 0)
    assert.ok(f.client.voice.getSnapshot().input.active)
    assert.equal(f.client.voice.getSnapshot().output, SILENT_SIGNAL)
    f.peer.ontrack!({ streams: [f.remote.stream] })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.output(), f.remote.stream)
    f.sample(0.03, 0.04)
    assert.equal(f.client.getSnapshot().speaking, 'both')
    assert.ok(f.client.voice.getSnapshot().input.active && f.client.voice.getSnapshot().output.active)
    f.client.setMuted(true)
    assert.equal(f.client.voice.getSnapshot().input, SILENT_SIGNAL)
    assert.ok(f.client.voice.getSnapshot().output.active)
    assert.equal(f.client.getSnapshot().inputLevel, 0)
    assert.equal(f.client.getSnapshot().speaking, 'assistant')
    f.sample(0.8, 0.04)
    assert.equal(f.client.getSnapshot().inputLevel, 0)
    f.audio.paused = true
    f.sample(0.8, 0.04)
    assert.equal(f.client.getSnapshot().speaking, 'silent')
    assert.equal(f.client.voice.getSnapshot().output, SILENT_SIGNAL)
    f.audio.paused = false; f.audio.muted = true
    f.sample(0.8, 0.04)
    assert.equal(f.client.getSnapshot().outputLevel, 0)
    f.audio.muted = false; f.audio.volume = 0
    f.sample(0.8, 0.04)
    assert.equal(f.client.getSnapshot().speaking, 'silent')
    f.audio.volume = 1; f.client.setMuted(false)
    f.sample(0.001, 0.001)
    assert.equal(f.client.getSnapshot().speaking, 'silent')
    f.channel.onmessage!({ data: JSON.stringify({ type: 'session.output_transcript.delta', delta: 'Text is not sound', event_id: 't1' }) })
    assert.equal(f.client.getSnapshot().speaking, 'silent')
    f.sample(Number.NaN, Number.POSITIVE_INFINITY)
    assert.equal(f.client.getSnapshot().inputLevel, 0)
    assert.equal(f.client.getSnapshot().outputLevel, 0)
    await f.client.stop()
    assert.equal(f.disposed(), 1)
    assert.equal(f.client.getSnapshot().inputLevel, 0)
    assert.equal(f.client.getSnapshot().outputLevel, 0)
    assert.equal(f.client.getSnapshot().meteringAvailable, false)
    f.sample(1, 1)
    assert.equal(f.client.voice.getSnapshot().available, false)
    assert.equal(f.client.getSnapshot().speaking, 'silent')
  } finally { f.client.dispose() }
  assert.equal(f.disposed(), 1)
})

test('autoplay refusal keeps remote samples silent until explicit playback succeeds', async () => {
  const f = clientFixture()
  f.audio.play = async () => { throw new Error('blocked') }
  await f.client.refreshStatus(); await f.client.start()
  try {
    f.peer.ontrack!({ streams: [f.remote.stream] })
    await new Promise(resolve => setImmediate(resolve))
    f.sample(0, 0.5)
    assert.equal(f.client.getSnapshot().playbackBlocked, true)
    assert.equal(f.client.voice.getSnapshot().output, SILENT_SIGNAL)
    assert.equal(f.client.getSnapshot().speaking, 'silent')
    f.audio.play = async () => { f.audio.paused = false }
    await f.client.playAudio()
    f.sample(0, 0.5)
    assert.equal(f.client.getSnapshot().speaking, 'assistant')
    assert.ok(f.client.voice.getSnapshot().output.active)
  } finally { await f.client.stop(); f.client.dispose() }
})

test('stop/dispose closes the meter even while the microphone permission is pending', async () => {
  const f = clientFixture()
  let allow!: (stream: MediaStream) => void
  f.runtime.microphone = () => new Promise(resolve => { allow = resolve })
  await f.client.refreshStatus()
  const pending = f.client.start()
  f.client.dispose()
  assert.equal(f.disposed(), 1)
  allow(f.microphone.stream)
  await pending
  assert.equal(f.microphone.track.stopped, true)
  assert.equal(f.input(), undefined)
  f.sample(1, 1)
  assert.equal(f.disposed(), 1)
})

test('active transcript changes intent but not sound; late session events and stopped callbacks cannot restore it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = clientFixture()
  await f.client.refreshStatus(); await f.client.start()
  const deliver = f.channel.onmessage!
  try {
    deliver({ data: JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }) })
    deliver({ data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'こんにちは', event_id: 'input-1' }) })
    assert.equal(f.client.getSnapshot().conversation, 'waiting')
    assert.equal(f.client.getSnapshot().speaking, 'silent')
    f.peer.ontrack!({ streams: [f.remote.stream] })
    await new Promise(resolve => setImmediate(resolve))
    t.mock.timers.tick(400)
    f.sample(0, .2)
    assert.equal(f.client.getSnapshot().conversation, 'assistant')
    f.sample(0, 0)
    assert.equal(f.client.getSnapshot().conversation, 'assistant', 'Short output gap keeps turn label, not fake energy')
    assert.equal(f.client.getSnapshot().outputLevel, 0)
    t.mock.timers.tick(700); f.sample(0, 0)
    assert.equal(f.client.getSnapshot().conversation, 'listening')
    deliver({ data: JSON.stringify({ type: 'session.input_transcript.delta', delta: 'こんにちは', event_id: 'input-1' }) })
    assert.equal(f.client.getSnapshot().conversation, 'listening', 'Duplicate input cannot reopen a completed response')
    deliver({ data: JSON.stringify({ type: 'session.input_transcript.delta', session_id: 'old', delta: '古い入力', event_id: 'old-1' }) })
    assert.equal(f.client.getSnapshot().conversation, 'listening')
    await f.client.stop()
    deliver({ data: JSON.stringify({ type: 'session.input_transcript.delta', delta: '遅延', event_id: 'late-1' }) })
    f.sample(.2, .2)
    assert.equal(f.client.getSnapshot().conversation, 'listening')
    assert.equal(f.client.getSnapshot().phase, 'ended')
  } finally { await f.client.stop(); f.client.dispose() }
})

test('a duplicate backend result cannot reopen finished Orb response intent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = clientFixture()
  await f.client.refreshStatus(); await f.client.start()
  const receive = (f.client as unknown as { receive: (event: unknown, source: string) => void }).receive.bind(f.client)
  const result = { name: 'backend.result', eventId: 'backend-result-1', data: { case_id: 'case-a', session_id: 'live_1', content: 'done' } }
  try {
    f.channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: 'live_1' } }) })
    f.peer.ontrack!({ streams: [f.remote.stream] })
    await new Promise(resolve => setImmediate(resolve))
    receive(result, 'server')
    assert.equal(f.client.getSnapshot().conversation, 'waiting')
    f.sample(0, .2)
    t.mock.timers.tick(700); f.sample(0, 0)
    assert.equal(f.client.getSnapshot().conversation, 'listening')
    receive(result, 'server')
    assert.equal(f.client.getSnapshot().conversation, 'listening', 'Seen event must not restart waiting after audible response completed')
  } finally { await f.client.stop(); f.client.dispose() }
})

for (const type of ['backend.started', 'backend.result']) {
  for (const transport of ['server', 'datachannel'] as const) {
    test(`replayed ${type} from ${transport} cannot reopen a spoken response`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: 10000 })
      const f = clientFixture()
      await f.client.refreshStatus(); f.client.observe(); await f.client.start()
      const deliver = (event: Record<string, unknown>, source = transport) => {
        const target = source === 'server' ? f.source : f.channel
        target.onmessage!({ data: JSON.stringify(event) })
      }
      const event = { type, case_id: 'case-a', session_id: 'live_1', event_id: 'backend-1', content: 'Confirmed' }
      try {
        // Rejected cases must not consume the active case's event ID.
        deliver({ ...event, case_id: 'other-case' }, 'server')
        assert.equal(f.client.getSnapshot().conversation, 'listening')
        deliver(event)
        assert.equal(f.client.getSnapshot().conversation, 'waiting')
        f.peer.ontrack!({ streams: [f.remote.stream] })
        await new Promise(resolve => setImmediate(resolve))
        f.sample(0, .2)
        assert.equal(f.client.getSnapshot().conversation, 'assistant')
        t.mock.timers.tick(700); f.sample(0, 0)
        assert.equal(f.client.getSnapshot().conversation, 'listening')

        deliver(event)
        assert.equal(f.client.getSnapshot().conversation, 'listening', 'Same transport replay must stay complete')
        deliver(event, transport === 'server' ? 'datachannel' : 'server')
        assert.equal(f.client.getSnapshot().conversation, 'listening', 'Cross transport replay must stay complete')
        deliver({ ...event, event_id: 'old-session', session_id: 'old' })
        assert.equal(f.client.getSnapshot().conversation, 'listening', 'Old session cannot change active voice intent')
        deliver({ ...event, event_id: 'backend-2' })
        assert.equal(f.client.getSnapshot().conversation, 'waiting', 'A new event with identical content still waits')
      } finally { await f.client.stop(); f.client.dispose() }
    })
  }
}

test('replayed backend errors cannot clear a new pending response', async () => {
  const f = clientFixture()
  await f.client.refreshStatus(); await f.client.start()
  const deliver = (event: Record<string, unknown>) => f.channel.onmessage!({ data: JSON.stringify(event) })
  try {
    const error = { type: 'backend.error', event_id: 'error-1', message: 'Try again' }
    deliver(error)
    deliver({ type: 'backend.started', event_id: 'work-2' })
    assert.equal(f.client.getSnapshot().conversation, 'waiting')
    deliver(error)
    assert.equal(f.client.getSnapshot().conversation, 'waiting')
    deliver({ ...error, event_id: 'error-2' })
    assert.equal(f.client.getSnapshot().conversation, 'listening')
  } finally { await f.client.stop(); f.client.dispose() }
})
