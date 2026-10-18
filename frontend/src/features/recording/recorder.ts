import { createAudioCapture } from './capture.ts'
import type { AudioCapture } from './capture.ts'
import type { EncoderInput, EncoderOutput, LiveMediaObserver, RecordingSnapshot } from './types.ts'

export interface RecordingEncoder {
  onmessage: ((event: MessageEvent<EncoderOutput>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: EncoderInput, transfer?: Transferable[]): void
  terminate(): void
}
export interface RecordingRuntime {
  capture(input: MediaStream, onSamples: (samples: Float32Array) => void): AudioCapture | null
  encoder(): RecordingEncoder
  createUrl(blob: Blob): string
  revokeUrl(url: string): void
  now(): Date
}
const browserRuntime: RecordingRuntime = {
  capture: createAudioCapture,
  encoder: () => new Worker(new URL('./mp3.worker.ts', import.meta.url), { type: 'module' }),
  createUrl: blob => URL.createObjectURL(blob), revokeUrl: url => URL.revokeObjectURL(url), now: () => new Date(),
}
export const emptyRecording = (): RecordingSnapshot => ({ phase: 'idle', url: null, filename: '', seconds: 0, bytes: 0 })
interface Run { capture: AudioCapture; encoder: RecordingEncoder; stopping: boolean; timer?: ReturnType<typeof setTimeout> }

/** No upload, persistence, extra microphone request, or ownership of Live tracks. */
export class LocalConversationRecorder implements LiveMediaObserver {
  private runtime: RecordingRuntime
  private state = emptyRecording()
  private listeners = new Set<() => void>()
  private run: Run | null = null
  private output: MediaStream | null = null
  private inputEnabled = true
  private outputEnabled = false

  constructor(runtime = browserRuntime) { this.runtime = runtime }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private patch(next: Partial<RecordingSnapshot>) { this.state = { ...this.state, ...next }; this.listeners.forEach(listener => listener()) }

  setInput(stream: MediaStream) {
    this.clear()
    this.inputEnabled = true; this.outputEnabled = false
    this.patch({ ...emptyRecording(), phase: 'preparing', filename: `conversation-${this.runtime.now().toISOString().replace(/[:.]/g, '-')}.mp3` })
    let capture: AudioCapture | null = null
    let encoder: RecordingEncoder | null = null
    try {
      capture = this.runtime.capture(stream, samples => {
        if (this.run?.capture === capture) {
          try { encoder?.postMessage({ type: 'pcm', samples }, [samples.buffer]) }
          catch { if (this.run) this.fail(this.run) }
        }
      })
      if (!capture) { this.patch({ phase: 'unavailable' }); return }
      encoder = this.runtime.encoder()
      const run: Run = { capture, encoder, stopping: false }
      this.run = run
      encoder.onmessage = ({ data }) => {
        if (this.run !== run) return
        if (data.type === 'progress') this.patch({ seconds: data.seconds })
        else if (data.type === 'error') this.fail(run)
        else if (data.type === 'finished') {
          try {
            const url = data.blob.size ? this.runtime.createUrl(data.blob) : null
            this.release(run)
            this.patch({ phase: url ? 'ready' : 'idle', url, seconds: data.seconds, bytes: data.blob.size })
          } catch { this.fail(run) }
        }
      }
      encoder.onerror = () => this.fail(run)
      encoder.postMessage({ type: 'start', sampleRate: capture.sampleRate })
      capture.setOutput(this.output)
      capture.setEnabled(this.inputEnabled, this.outputEnabled)
      void capture.ready.then(() => {
        if (this.run === run && !run.stopping) this.patch({ phase: 'recording' })
      }).catch(() => this.fail(run))
    } catch {
      void capture?.ready.catch(() => {})
      capture?.dispose(); encoder?.terminate()
      this.run = null
      this.patch({ phase: 'error' })
    }
  }

  setOutput(stream: MediaStream | null) {
    this.output = stream
    try { this.run?.capture.setOutput(stream) } catch { if (this.run) this.fail(this.run) }
  }
  setEnabled(input: boolean, output: boolean) {
    this.inputEnabled = input; this.outputEnabled = output
    try { this.run?.capture.setEnabled(input, output) } catch { if (this.run) this.fail(this.run) }
  }
  stop() {
    const run = this.run
    if (!run || run.stopping) return
    run.stopping = true
    this.output = null
    this.patch({ phase: 'encoding' })
    run.timer = setTimeout(() => this.fail(run), 15000)
    void run.capture.finish().then(() => {
      if (this.run === run) run.encoder.postMessage({ type: 'finish' })
    }).catch(() => this.fail(run))
  }
  private release(run: Run) {
    clearTimeout(run.timer)
    run.capture.dispose()
    run.encoder.onmessage = null; run.encoder.onerror = null; run.encoder.terminate()
    if (this.run === run) this.run = null
  }
  private fail(run: Run) {
    if (this.run !== run) return
    this.release(run)
    this.patch({ phase: 'error' })
  }
  clear() {
    if (this.run) this.release(this.run)
    if (this.state.url) this.runtime.revokeUrl(this.state.url)
    this.output = null
    this.patch(emptyRecording())
  }
  dispose() { this.clear(); this.listeners.clear() }
}
