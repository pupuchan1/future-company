import assert from 'node:assert/strict'
import test from 'node:test'
import { measureSignal, SILENT_ACTIVITY, SILENT_SIGNAL, VoiceActivityStore } from '../src/features/voice/activity.ts'
import { createAudioMeter } from '../src/features/live/client.ts'

const samples = (amplitude: number) => Float32Array.from({ length: 1024 }, (_, index) => amplitude * Math.sin(index * Math.PI / 16))

test('silence and noise stay quiet; actual PCM controls level and waveform geometry', () => {
  assert.equal(measureSignal(samples(0)), SILENT_SIGNAL)
  assert.equal(measureSignal(samples(0.001)), SILENT_SIGNAL)
  const quiet = measureSignal(samples(0.03)); const loud = measureSignal(samples(0.2))
  assert.ok(quiet.active && loud.active && loud.level > quiet.level)
  assert.ok(loud.waveform.some(value => value > 0) && loud.waveform.some(value => value < 0))
  let release = loud
  for (let i = 0; i < 12; i++) release = measureSignal(samples(0), release)
  assert.equal(release, SILENT_SIGNAL)
})

test('one analyser per stream supplies fast waveforms, slower levels, and releases all resources', t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const store = new VoiceActivityStore()
  const analysers: { fftSize: number; amplitude: number; disconnected: boolean; getFloatTimeDomainData: (buffer: Float32Array) => void; disconnect: () => void }[] = []
  const sources: { disconnected: boolean; connect: (node: unknown) => void; disconnect: () => void }[] = []
  const context = {
    state: 'running', closed: 0,
    async close() { this.closed++ },
    createMediaStreamSource() {
      const source = { disconnected: false, connect() {}, disconnect() { this.disconnected = true } }
      sources.push(source); return source
    },
    createAnalyser() {
      const analyser = { fftSize: 512, amplitude: 0, disconnected: false,
        getFloatTimeDomainData(buffer: Float32Array) { buffer.set(samples(this.amplitude).subarray(0, buffer.length)) },
        disconnect() { this.disconnected = true },
      }
      analysers.push(analyser); return analyser
    },
  }
  const track = { enabled: true, muted: false, readyState: 'live', stopped: false }
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream
  let levels = 0; let frames = 0
  const meter = createAudioMeter(() => { levels++ }, () => context as unknown as AudioContext, activity => { frames++; store.publish(activity) })!
  meter.setInput(stream); meter.setOutput(stream)
  analysers[0].amplitude = .2
  t.mock.timers.tick(34)
  assert.equal(frames, 1); assert.equal(levels, 0)
  assert.ok(store.getSnapshot().input.active)
  assert.equal(store.getSnapshot().output.active, false)
  analysers[1].amplitude = .1
  t.mock.timers.tick(34)
  assert.ok(store.getSnapshot().input.active && store.getSnapshot().output.active)
  track.enabled = false; t.mock.timers.tick(34)
  assert.equal(levels, 1)
  assert.equal(store.getSnapshot().input, SILENT_SIGNAL)
  assert.equal(store.getSnapshot().output, SILENT_SIGNAL)
  track.enabled = true; track.muted = true; t.mock.timers.tick(34)
  assert.equal(store.getSnapshot().input, SILENT_SIGNAL)
  track.muted = false; track.readyState = 'ended'; t.mock.timers.tick(34)
  assert.equal(store.getSnapshot().input, SILENT_SIGNAL)
  track.readyState = 'live'; context.state = 'suspended'; t.mock.timers.tick(34)
  assert.equal(store.getSnapshot().available, false)
  context.state = 'running'; t.mock.timers.tick(34)
  assert.ok(store.getSnapshot().input.active)
  meter.setInput(stream)
  assert.equal(sources.length, 2, 'Same stream does not create a second graph')
  meter.setInput({ getAudioTracks: () => [track] } as unknown as MediaStream)
  assert.ok(sources[0].disconnected && analysers[0].disconnected)
  meter.dispose(); meter.dispose()
  assert.deepEqual(store.getSnapshot(), SILENT_ACTIVITY)
  const count = frames; t.mock.timers.tick(1000)
  assert.equal(frames, count)
  assert.equal(context.closed, 1)
  assert.ok(sources.every(source => source.disconnected) && analysers.every(analyser => analyser.disconnected))
  assert.equal(track.stopped, false, 'Meter never stops caller-owned tracks')
})
