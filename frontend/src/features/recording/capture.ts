export interface AudioCapture {
  readonly sampleRate: number
  readonly ready: Promise<void>
  setOutput(stream: MediaStream | null): void
  setEnabled(input: boolean, output: boolean): void
  finish(): Promise<void>
  dispose(): void
}

/** Mix the already-authorized microphone and active AI stream locally. */
export function createAudioCapture(input: MediaStream, onSamples: (samples: Float32Array) => void): AudioCapture | null {
  if (typeof AudioContext !== 'function' || typeof AudioWorkletNode !== 'function') return null
  const context = new AudioContext({ sampleRate: 48000 })
  if (!context.audioWorklet) { void context.close(); return null }
  const inputGain = context.createGain()
  const outputGain = context.createGain()
  // Reserve headroom when the user interrupts the AI.
  inputGain.gain.value = 0.5
  outputGain.gain.value = 0
  let inputSource: MediaStreamAudioSourceNode | null = null
  let outputSource: MediaStreamAudioSourceNode | null = null
  try {
    inputSource = context.createMediaStreamSource(input)
    inputSource.connect(inputGain)
  } catch (error) {
    inputSource?.disconnect(); inputGain.disconnect(); outputGain.disconnect()
    void context.close().catch(() => {})
    throw error
  }
  let worklet: AudioWorkletNode | null = null
  let disposed = false
  let finishing: Promise<void> | null = null
  let flushed: (() => void) | null = null
  let flushTimeout: ReturnType<typeof setTimeout> | undefined
  // Resume is attempted before async work; a failed recording never stops the call.
  const resumed = context.resume()
  const ready = Promise.all([
    resumed,
    context.audioWorklet.addModule(new URL('./capture.worklet.js?no-inline', import.meta.url).href),
  ]).then(() => {
    if (disposed) return
    if (context.state !== 'running') throw new Error('Recording audio context unavailable')
    worklet = new AudioWorkletNode(context, 'conversation-capture', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] })
    worklet.port.onmessage = ({ data }) => {
      if (data.type === 'pcm' && data.samples instanceof Float32Array && !disposed) onSamples(data.samples)
      else if (data.type === 'finished') flushed?.()
    }
    inputGain.connect(worklet)
    outputGain.connect(worklet)
    worklet.connect(context.destination)
  })
  function dispose() {
    if (disposed) return
    disposed = true
    clearTimeout(flushTimeout)
    flushed?.()
    inputSource?.disconnect(); inputSource = null
    outputSource?.disconnect(); outputSource = null
    inputGain.disconnect(); outputGain.disconnect()
    if (worklet) { worklet.port.onmessage = null; worklet.port.close(); worklet.disconnect(); worklet = null }
    void context.close().catch(() => {})
  }
  return {
    sampleRate: context.sampleRate, ready,
    setOutput(stream) {
      if (disposed) return
      outputSource?.disconnect(); outputSource = null
      if (stream) { outputSource = context.createMediaStreamSource(stream); outputSource.connect(outputGain) }
    },
    setEnabled(mic, ai) {
      if (disposed) return
      inputGain.gain.value = mic ? 0.5 : 0
      outputGain.gain.value = ai ? 0.5 : 0
    },
    finish() {
      finishing ??= (async () => {
        try {
          await ready
          if (!disposed && worklet) await new Promise<void>((resolve, reject) => {
            flushed = resolve
            flushTimeout = setTimeout(() => reject(new Error('Recording flush timeout')), 3000)
            worklet!.port.postMessage('finish')
          })
        } finally { dispose() }
      })()
      return finishing
    },
    dispose,
  }
}
