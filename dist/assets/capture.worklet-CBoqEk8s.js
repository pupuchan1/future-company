/* Same-origin AudioWorklet: no network, storage or microphone access. */
class ConversationCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(4096)
    this.used = 0
    this.running = true
    this.port.onmessage = ({ data }) => {
      if (data === 'finish') {
        this.flush()
        this.running = false
        this.port.postMessage({ type: 'finished' })
      }
    }
  }
  flush() {
    if (!this.used) return
    const samples = this.buffer.slice(0, this.used)
    this.port.postMessage({ type: 'pcm', samples }, [samples.buffer])
    this.used = 0
  }
  process(inputs) {
    if (!this.running) return false
    const input = inputs[0]?.[0]
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.buffer[this.used++] = input[i]
        if (this.used === this.buffer.length) this.flush()
      }
    }
    // The output remains silent; captured microphone audio never goes to speakers.
    return true
  }
}
registerProcessor('conversation-capture', ConversationCapture)
