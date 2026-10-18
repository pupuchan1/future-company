import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createAudioCapture } from '../src/features/recording/capture.ts'

test('audio worklet preserves final partial samples and never writes microphone samples to its output', () => {
  const messages: { type: string; samples?: Float32Array }[] = []
  let Processor!: new () => { port: { onmessage: (event: { data: string }) => void }; process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
  runInNewContext(readFileSync(new URL('../src/features/recording/capture.worklet.js', import.meta.url), 'utf8'), {
    Float32Array,
    AudioWorkletProcessor: class { port = { onmessage: null, postMessage: (data: { type: string; samples?: Float32Array }) => messages.push(data) } },
    registerProcessor: (_name: string, constructor: typeof Processor) => { Processor = constructor },
  })
  const capture = new Processor()
  const output = new Float32Array(4097)
  capture.process([[new Float32Array(4097).fill(0.25)]], [[output]])
  capture.port.onmessage({ data: 'finish' })
  assert.deepEqual(messages.filter(message => message.samples).map(message => message.samples!.length), [4096, 1])
  assert.equal(messages.at(-1)?.type, 'finished')
  assert.ok(output.every(value => value === 0), 'No local microphone echo')
  assert.equal(capture.process([[new Float32Array(128)]], [[output]]), false)
})

function mockAudio(t: TestContext, failSource = false) {
  const audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')
  const workletDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode')
  const nodes: { gain?: { value: number }; disconnected: boolean; connect(target: unknown): void; disconnect(): void }[] = []
  const captured: unknown[] = []
  let closed = 0; const worklets: { port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(message: string): void; close(): void }; disconnected: boolean }[] = []
  const node = (gain = false) => {
    const value = { ...(gain ? { gain: { value: 1 } } : {}), disconnected: false, connect() {}, disconnect() { this.disconnected = true } }
    nodes.push(value); return value
  }
  class Context {
    state = 'running'; sampleRate = 48000; destination = {}
    audioWorklet = { addModule: async (url: string) => { assert.match(url, /capture\.worklet\.js/); assert.ok(!url.startsWith('https://')) } }
    createGain() { return node(true) }
    createMediaStreamSource(stream: unknown) { if (failSource) throw new Error('No audio'); captured.push(stream); return node() }
    async resume() {}
    async close() { closed++ }
  }
  class Worklet {
    disconnected = false
    port = { onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (message: string) => { if (message === 'finish') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'finished' } })) }, close() {},
    }
    constructor() { worklets.push(this) }
    connect() {}
    disconnect() { this.disconnected = true }
  }
  Object.defineProperty(globalThis, 'AudioContext', { value: Context, configurable: true })
  Object.defineProperty(globalThis, 'AudioWorkletNode', { value: Worklet, configurable: true })
  t.after(() => {
    if (audioDescriptor) Object.defineProperty(globalThis, 'AudioContext', audioDescriptor); else delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext
    if (workletDescriptor) Object.defineProperty(globalThis, 'AudioWorkletNode', workletDescriptor); else delete (globalThis as unknown as { AudioWorkletNode?: unknown }).AudioWorkletNode
  })
  return { nodes, captured, closed: () => closed, worklet: () => worklets[0] }
}

test('capture gates the microphone and AI independently, replaces only the output node and closes all resources', async t => {
  const f = mockAudio(t)
  const input = {} as MediaStream; const output = {} as MediaStream; const nextOutput = {} as MediaStream
  const capture = createAudioCapture(input, () => {})!
  await capture.ready
  capture.setOutput(output); capture.setEnabled(false, true)
  assert.deepEqual(f.nodes.slice(0, 2).map(node => node.gain!.value), [0, 0.5])
  capture.setOutput(nextOutput)
  assert.equal(f.nodes[3].disconnected, true, 'Old AI source is detached during handoff')
  assert.equal(f.nodes[2].disconnected, false, 'Microphone source is retained')
  capture.setEnabled(false, false)
  assert.deepEqual(f.nodes.slice(0, 2).map(node => node.gain!.value), [0, 0])
  await capture.finish(); capture.dispose()
  assert.equal(f.closed(), 1); assert.ok(f.nodes.every(node => node.disconnected)); assert.ok(f.worklet().disconnected)
})

test('invalid capture input closes its context even when setup throws before returning a controller', t => {
  const f = mockAudio(t, true)
  assert.throws(() => createAudioCapture({} as MediaStream, () => {}), /No audio/)
  assert.equal(f.closed(), 1); assert.ok(f.nodes.every(node => node.disconnected))
})
