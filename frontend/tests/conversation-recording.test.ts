import assert from 'node:assert/strict'
import test from 'node:test'
import { LocalConversationRecorder } from '../src/features/recording/recorder.ts'
import type { RecordingEncoder, RecordingRuntime } from '../src/features/recording/recorder.ts'
import type { EncoderInput, EncoderOutput } from '../src/features/recording/types.ts'
import { ConversationMp3Encoder, pcm16 } from '../src/features/recording/encoding.ts'
import { LiveEventReducer } from '../src/features/live/events.ts'
import { initialSnapshot } from '../src/features/live/types.ts'
import { transcriptText } from '../src/features/recording/transcript.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const messages: EncoderInput[] = []
  const outputs: (MediaStream | null)[] = []
  const enabled: boolean[][] = []
  const urls: Blob[] = []; const revoked: string[] = []
  let samples!: (data: Float32Array) => void
  let resolveReady!: () => void; let rejectReady!: (error: Error) => void
  let resolveFinish!: () => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  let disposed = 0; let terminated = 0; let finishCalls = 0; let stoppedTracks = 0
  const capture = { sampleRate: 48000, ready, setOutput: (stream: MediaStream | null) => outputs.push(stream),
    setEnabled: (input: boolean, output: boolean) => enabled.push([input, output]),
    finish() { finishCalls++; return new Promise<void>(resolve => { resolveFinish = resolve }) }, dispose() { disposed++ },
  }
  const encoder: RecordingEncoder = { onmessage: null, onerror: null,
    postMessage: message => { messages.push(message) }, terminate: () => { terminated++ },
  }
  const runtime: RecordingRuntime = { capture: (_stream, onSamples) => { samples = onSamples; return capture }, encoder: () => encoder,
    createUrl: blob => { urls.push(blob); return `blob:recording-${urls.length}` }, revokeUrl: url => revoked.push(url), now: () => new Date('2026-10-18T07:00:00Z'),
  }
  const stream = { getTracks: () => [{ stop: () => { stoppedTracks++ } }] } as unknown as MediaStream
  const recorder = new LocalConversationRecorder(runtime)
  const emit = (data: EncoderOutput) => encoder.onmessage?.({ data } as MessageEvent<EncoderOutput>)
  return { recorder, runtime, stream, messages, outputs, enabled, urls, revoked, emit, resolveReady, rejectReady,
    finish: () => resolveFinish(), pcm: (data: Float32Array) => samples(data),
    counts: () => ({ disposed, terminated, finishCalls, stoppedTracks }),
  }
}

test('local recording mixes only supplied streams, flushes once and exposes an actual MP3 download', async () => {
  const f = fixture()
  f.recorder.setInput(f.stream); f.resolveReady(); await tick()
  assert.equal(f.recorder.getSnapshot().phase, 'recording')
  assert.deepEqual(f.messages[0], { type: 'start', sampleRate: 48000 })
  f.recorder.setOutput(f.stream); f.recorder.setEnabled(false, true)
  assert.equal(f.outputs.at(-1), f.stream)
  assert.deepEqual(f.enabled.at(-1), [false, true])
  f.pcm(new Float32Array([0.2, -0.1])); assert.equal(f.messages[1].type, 'pcm')
  f.recorder.stop(); f.recorder.stop()
  assert.equal(f.counts().finishCalls, 1)
  assert.equal(f.recorder.getSnapshot().phase, 'encoding')
  assert.equal(f.messages.some(message => message.type === 'finish'), false, 'Wait for final worklet samples')
  f.finish(); await tick()
  assert.equal(f.messages.at(-1)?.type, 'finish')
  const mp3 = new ConversationMp3Encoder(48000)
  mp3.append(Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i * 0.03) * 0.2))
  f.emit({ type: 'finished', ...mp3.finish() })
  assert.equal(f.recorder.getSnapshot().phase, 'ready')
  assert.equal(f.recorder.getSnapshot().url, 'blob:recording-1')
  assert.equal(f.urls[0].type, 'audio/mpeg'); assert.ok(f.urls[0].size > 1000)
  assert.equal(f.counts().terminated, 1); assert.equal(f.counts().stoppedTracks, 0)
  f.recorder.dispose(); assert.deepEqual(f.revoked, ['blob:recording-1'])
})

test('unsupported capture and encoding failures do not own or stop the Live microphone', async () => {
  const f = fixture()
  f.runtime.capture = () => null
  f.recorder.setInput(f.stream)
  assert.equal(f.recorder.getSnapshot().phase, 'unavailable')
  assert.equal(f.messages.length, 0)
  const failed = fixture(); failed.recorder.setInput(failed.stream); failed.rejectReady(new Error('Unavailable'))
  await tick()
  assert.equal(failed.recorder.getSnapshot().phase, 'error')
  assert.equal(failed.counts().disposed, 1); assert.equal(failed.counts().terminated, 1)
  assert.equal(failed.counts().stoppedTracks, 0)
  f.recorder.dispose(); failed.recorder.dispose()
})

test('dispose during preparation or final encoding cleans resources and ignores late output', async () => {
  const f = fixture(); f.recorder.setInput(f.stream); f.recorder.stop(); f.recorder.dispose()
  f.resolveReady(); f.finish(); await tick()
  f.emit({ type: 'finished', blob: new Blob(['late'], { type: 'audio/mpeg' }), seconds: 1 })
  assert.equal(f.urls.length, 0); assert.equal(f.recorder.getSnapshot().phase, 'idle')
  assert.equal(f.messages.some(message => message.type === 'finish'), false)
  assert.equal(f.counts().disposed, 1); assert.equal(f.counts().terminated, 1)
  assert.equal(f.counts().stoppedTracks, 0)
})

test('worker construction failure closes capture and handles its delayed rejection', async () => {
  const f = fixture(); f.runtime.encoder = () => { throw new Error('Worker unavailable') }
  f.recorder.setInput(f.stream); f.rejectReady(new Error('Closed context')); await tick()
  assert.equal(f.recorder.getSnapshot().phase, 'error'); assert.equal(f.counts().disposed, 1)
  assert.equal(f.counts().stoppedTracks, 0); f.recorder.dispose()
})

test('PCM conversion clamps invalid input and a real encoder creates MPEG frames with the expected duration', async () => {
  assert.deepEqual([...pcm16(new Float32Array([-2, -1, 0, 1, 2, NaN]))], [-32768, -32768, 0, 32767, 32767, 0])
  const encoder = new ConversationMp3Encoder(48000)
  for (let block = 0; block < 10; block++) encoder.append(Float32Array.from({ length: 4800 }, (_, i) => Math.sin((i + block * 4800) * 2 * Math.PI * 440 / 48000) * 0.4))
  const { blob, seconds } = encoder.finish()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  assert.equal(seconds, 1); assert.equal(blob.type, 'audio/mpeg')
  assert.ok(bytes.length > 12000 && bytes.length < 20000)
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1] & 0xe0, 0xe0, 'MPEG frame sync, not WAV/WebM renamed as MP3')
  assert.throws(() => encoder.finish(), /already finished/)
})

test('all transcript turns and old event IDs remain available without a 200-turn or 1000-event eviction', () => {
  const reducer = new LiveEventReducer()
  let snapshot = initialSnapshot('case-a', 'ja')
  for (let i = 0; i < 1100; i++) snapshot = reducer.apply(snapshot, { type: 'session.input_transcript.done', event_id: `event-${i}`, item_id: `item-${i}`, transcript: `発言 ${i}` }, 'datachannel')
  assert.equal(snapshot.transcripts.length, 1100)
  assert.equal(snapshot.transcripts[0].text, '発言 0')
  const repeat = reducer.apply(snapshot, { type: 'session.input_transcript.done', case_id: 'case-a', event_id: 'event-0', item_id: 'item-0', transcript: 'duplicated' }, 'server')
  assert.equal(repeat, snapshot)
  const text = transcriptText(snapshot.transcripts, 'ja')
  assert.ok(text.startsWith('あなた\n発言 0')); assert.ok(text.endsWith('発言 1099'))
})

test('ID-less speaker turns stay in conversation order and textless completion finalizes the right speaker', () => {
  const reducer = new LiveEventReducer()
  let s = initialSnapshot('case-a', 'ja')
  s = reducer.apply(s, { type: 'session.input_transcript.delta', delta: '質問' }, 'datachannel', 1)
  s = reducer.apply(s, { type: 'session.output_transcript.delta', delta: '回答' }, 'datachannel', 2)
  s = reducer.apply(s, { type: 'session.input_transcript.delta', delta: '次の質問' }, 'datachannel', 3)
  s = reducer.apply(s, { type: 'session.output_transcript.delta', delta: '次の回答' }, 'datachannel', 4)
  s = reducer.apply(s, { type: 'session.input_transcript.done' }, 'datachannel', 5)
  assert.equal(s.transcripts.length, 4)
  assert.deepEqual(s.transcripts.map(entry => [entry.text, entry.final]), [['質問', false], ['回答', false], ['次の質問', true], ['次の回答', false]])
})
