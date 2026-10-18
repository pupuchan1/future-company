import { ConversationMp3Encoder } from './encoding.ts'
import type { EncoderInput, EncoderOutput } from './types.ts'

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<EncoderInput>) => void) | null
  postMessage(message: EncoderOutput): void
}
let encoder: ConversationMp3Encoder | null = null
let reported = -1
scope.onmessage = ({ data }) => {
  try {
    if (data.type === 'start') encoder = new ConversationMp3Encoder(data.sampleRate)
    else if (data.type === 'pcm' && encoder) {
      encoder.append(data.samples)
      const seconds = Math.floor(encoder.seconds)
      if (seconds !== reported) { reported = seconds; scope.postMessage({ type: 'progress', seconds }) }
    } else if (data.type === 'finish' && encoder) {
      scope.postMessage({ type: 'finished', ...encoder.finish() })
      encoder = null
    }
  } catch {
    encoder = null
    scope.postMessage({ type: 'error' })
  }
}
