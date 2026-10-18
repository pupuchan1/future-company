import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { createIntegration } from '../../integration/server.mjs'
import { LiveClient } from '../src/features/live/client.ts'
import type { LiveAudioLevels, LiveRuntime } from '../src/features/live/client.ts'
import type { LiveEventTransport } from '../src/features/live/event-transport.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check: () => boolean) {
  const deadline = performance.now() + 3000
  while (!check()) {
    assert.ok(performance.now() < deadline, 'Local backend/SSE condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

class Sideband extends EventEmitter {
  readyState = 0
  sent: Record<string, unknown>[] = []
  constructor() {
    super()
    queueMicrotask(() => { this.readyState = 1; this.emit('open') })
  }
  receive(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))) }
  send(raw: string) {
    const event = JSON.parse(raw)
    this.sent.push(event)
    if (event.type === 'session.close') queueMicrotask(() => this.receive({ type: 'session.closed', reason: 'close_requested' }))
  }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close') } }
  terminate() { this.close() }
}

// Only the provider and browser media are fake. BusinessBackend,
// LiveConversation, the HTTP SSE endpoint and LiveClient run unchanged.
async function fixture(t: TestContext) {
  const stateDir = await mkdtemp(join(tmpdir(), 'live-backend-contract-'))
  const sockets: Sideband[] = []
  const turns: { finish: (error?: Error) => void }[] = []
  const provider = {
    live: { async create() { return { session: { id: `live-${sockets.length + 1}` }, transport: { sdp: 'v=0\r\nanswer' } } } },
    decisions: { async create() { return { answers: [] } } },
    beta: { agents: { sessions: {
      async create() {
        let finish!: (error?: Error) => void
        const pending = new Promise<Error | undefined>(resolve => { finish = resolve })
        turns.push({ finish })
        return {
          controller: { abort() { finish(new Error('Cancelled')) } }, withResultCollection() {},
          async *[Symbol.asyncIterator]() {
            yield { type: 'agent.session.created', session: { id: 'agent-actual' } }
            const error = await pending
            if (error) throw error
          },
          async finalResult() {
            return { session_id: 'agent-actual', turn_id: 'turn-actual', turn: { status: 'completed' }, output_text: 'Verified answer' }
          },
        }
      },
      async delete() {}, events: { async create() {} },
    } } },
  }
  const app = createIntegration({ client: provider, stateDir, closeTimeoutMs: 20,
    env: { HUMAN_MCP_URL: 'https://mcp.example.invalid/mcp', HUMAN_MCP_TOKEN: 'contract-test-only' },
    socketFactory() { const socket = new Sideband(); sockets.push(socket); return socket },
  })
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const abort = new AbortController()
  const events: Record<string, unknown>[] = []
  let readyState = 0
  const source: LiveEventTransport = { get readyState() { return readyState }, onopen: null, onmessage: null, onerror: null, close() { abort.abort() } }
  const pump = (async () => {
    const response = await fetch(base + '/api/events', { signal: abort.signal })
    readyState = 1
    source.onopen?.(new Event('open'))
    let buffer = ''
    const decoder = new TextDecoder()
    for await (const chunk of response.body!) {
      buffer += decoder.decode(chunk, { stream: true })
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (frame.startsWith('data: ')) {
          const data = frame.slice(6)
          events.push(JSON.parse(data))
          source.onmessage?.({ data } as MessageEvent<string>)
        }
      }
    }
  })().catch(error => { if (!abort.signal.aborted) throw error })
  const track = { enabled: true, readyState: 'live', stop() {} }
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream
  const channel = { onmessage: null as ((event: { data: string }) => void) | null, onclose: null, close() {} }
  const peer = {
    iceGatheringState: 'complete', connectionState: 'new', localDescription: null as null | { sdp: string },
    ontrack: null as ((event: { streams: MediaStream[] }) => void) | null, onconnectionstatechange: null,
    addTrack() {}, createDataChannel: () => channel, close() {},
    async createOffer() { return { type: 'offer', sdp: 'v=0' } },
    async setLocalDescription(value: { sdp: string }) { this.localDescription = value }, async setRemoteDescription() {},
  }
  const audio = { paused: true, muted: false, volume: 1, async play() { this.paused = false }, pause() { this.paused = true } }
  let sample: (levels: LiveAudioLevels) => void = () => {}
  const runtime = {
    fetch: (path: string, init?: RequestInit) => fetch(base + path, init), events: () => source,
    microphone: async () => stream, peer: () => peer, audio: () => audio, supported: () => true,
    metering(callback: typeof sample) { sample = callback; return { setInput() {}, setOutput() {}, dispose() {} } },
  } as unknown as LiveRuntime
  const client = new LiveClient('case-contract', 'ja', runtime)
  t.after(async () => {
    for (const turn of turns) turn.finish()
    await client.stop(); client.dispose(); abort.abort()
    await pump; await app.close(); await rm(stateDir, { recursive: true, force: true })
  })
  await client.refreshStatus(); client.observe()
  await until(() => source.readyState === 1)
  async function start() {
    await client.start()
    channel.onmessage!({ data: JSON.stringify({ type: 'session.started', session: { id: `live-${sockets.length}` } }) })
    peer.ontrack!({ streams: [stream] }); await tick()
  }
  await start()
  let inputId = 0
  async function input() {
    sockets.at(-1)!.receive({ type: 'session.input_transcript.delta', event_id: `input-${++inputId}`, delta: 'Question' })
    await until(() => events.some(event => event.event_id === `input-${inputId}`))
  }
  async function delegate() {
    sockets.at(-1)!.receive({ type: 'session.delegation.created', delegation: { id: `delegation-${inputId}`, target: 'client' } })
    await until(() => turns.length > 0 && events.some(event => event.type === 'backend.started'))
  }
  function replay(event: Record<string, unknown>) { source.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>) }
  return { client, sockets, turns, events, start, input, delegate, replay,
    sample: (outputLevel: number) => sample({ inputLevel: 0, outputLevel }),
  }
}

test('real backend start and result restore waiting after announcement audio; result replay stays complete', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 10000 })
  const f = await fixture(t)
  async function finishSpeech() {
    t.mock.timers.tick(400); f.sample(.2)
    t.mock.timers.tick(700); f.sample(0)
    assert.equal(f.client.getSnapshot().conversation, 'listening')
  }
  await f.input(); await finishSpeech()
  await f.delegate()
  const started = f.events.find(event => event.type === 'backend.started')!
  assert.equal(f.client.getSnapshot().conversation, 'waiting')
  assert.equal(started.live_session_id, 'live-1')
  assert.equal(started.agent_session_id, null)
  assert.equal(typeof started.event_id, 'string')
  await finishSpeech()
  f.turns[0].finish()
  await until(() => f.events.some(event => event.type === 'backend.result'))
  const result = f.events.find(event => event.type === 'backend.result')!
  assert.equal(result.live_session_id, 'live-1')
  assert.equal(result.agent_session_id, 'agent-actual')
  assert.equal(result.session_id, 'agent-actual', 'Retain the legacy Agent ID')
  assert.equal(f.client.getSnapshot().conversation, 'waiting')
  assert.equal(f.client.getSnapshot().backendResult, 'Verified answer')
  await finishSpeech()
  f.replay(started); f.replay(result)
  assert.equal(f.client.getSnapshot().conversation, 'listening')
  assert.ok(f.sockets[0].sent.some(event => event.type === 'session.commentary.append' && event.content === 'Verified answer'))
})

for (const failure of ['upstream', 'processing', 'socket', 'agent'] as const) {
  test(`real ${failure} error clears waiting and cannot clear a newer input on replay`, async t => {
    const f = await fixture(t)
    await f.input()
    assert.equal(f.client.getSnapshot().conversation, 'waiting')
    if (failure === 'upstream') f.sockets[0].receive({ type: 'error', error: { code: 'provider-error' } })
    if (failure === 'processing') f.sockets[0].emit('message', Buffer.from('{'))
    if (failure === 'socket') f.sockets[0].emit('error', new Error('Fake sideband error'))
    if (failure === 'agent') { await f.delegate(); f.turns[0].finish(new Error('Fake Agent error')) }
    await until(() => f.events.some(event => event.type === 'backend.error'))
    const error = f.events.find(event => event.type === 'backend.error')!
    assert.equal(f.client.getSnapshot().conversation, 'listening')
    assert.equal(f.client.getSnapshot().backend, 'error')
    assert.equal(error.live_session_id, 'live-1')
    assert.equal(typeof error.event_id, 'string')
    await f.input()
    f.replay(error)
    assert.equal(f.client.getSnapshot().conversation, 'waiting')
  })
}

test('real events from the previous Live cannot alter the current voice intent', async t => {
  const f = await fixture(t)
  await f.input(); await f.delegate(); f.turns[0].finish()
  await until(() => f.events.some(event => event.type === 'backend.result'))
  f.sockets[0].receive({ type: 'error', error: { code: 'old-provider-error' } })
  await until(() => f.events.some(event => event.type === 'backend.error'))
  const oldEvents = f.events.filter(event => String(event.type).startsWith('backend.'))
  await f.client.stop()
  await until(() => f.events.some(event => event.type === 'live.closed' && event.session_id === 'live-1'))
  await f.start()
  for (const event of oldEvents.filter(event => event.type !== 'backend.error')) f.replay(event)
  assert.equal(f.client.getSnapshot().conversation, 'listening')
  await f.input()
  for (const event of oldEvents.filter(event => event.type === 'backend.error')) f.replay(event)
  assert.equal(f.client.getSnapshot().conversation, 'waiting')
})
