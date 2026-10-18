import { Mp3Encoder } from '@breezystack/lamejs'

export function pcm16(samples: Float32Array): Int16Array {
  return Int16Array.from(samples, value => {
    const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
    return Math.round(sample * (sample < 0 ? 32768 : 32767))
  })
}

/** Runs in the encoding worker, retaining compressed bytes rather than raw audio. */
export class ConversationMp3Encoder {
  private encoder: Mp3Encoder
  private chunks: ArrayBuffer[] = []
  private samples = 0
  private sampleRate: number
  private finished = false

  constructor(sampleRate: number) {
    if (![8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000].includes(sampleRate)) throw new Error('Unsupported sample rate')
    this.sampleRate = sampleRate
    this.encoder = new Mp3Encoder(1, sampleRate, 128)
  }

  append(samples: Float32Array) {
    if (this.finished) return
    const pcm = pcm16(samples)
    for (let i = 0; i < pcm.length; i += 1152) this.keep(this.encoder.encodeBuffer(pcm.subarray(i, i + 1152)))
    this.samples += samples.length
  }

  private keep(bytes: Uint8Array) {
    if (bytes.length) this.chunks.push(new Uint8Array(bytes).buffer)
  }

  get seconds() { return this.samples / this.sampleRate }

  finish() {
    if (this.finished) throw new Error('Recording already finished')
    this.finished = true
    this.keep(this.encoder.flush())
    const blob = new Blob(this.samples ? this.chunks : [], { type: 'audio/mpeg' })
    this.chunks = []
    return { blob, seconds: this.seconds }
  }
}
