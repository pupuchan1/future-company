export type RtcAudioLevels = {
  available: boolean
  inputLevel: number
  outputLevel: number
}

type AudioStats = {
  id?: string
  type?: string
  kind?: string
  mediaType?: string
  audioLevel?: number
  totalAudioEnergy?: number
  totalSamplesDuration?: number
}

type EnergySample = { energy: number; duration: number }

const POLL_MS = 250

function nonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function directLevel(value: unknown): number | null {
  return nonNegative(value) && value <= 1 ? value : null
}

/** Measures the original WebRTC media even when a Web Audio context cannot run. */
export function createRtcMeter(
  peer: RTCPeerConnection,
  callback: (levels: RtcAudioLevels) => void,
): { dispose(): void } {
  let disposed = false
  let pending = false
  let previous = new Map<string, EnergySample>()
  let timer: ReturnType<typeof setInterval> | undefined

  const closed = () => peer.connectionState === 'closed' || peer.signalingState === 'closed'
  const dispose = () => {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
    previous.clear()
  }
  const emit = (levels: RtcAudioLevels) => {
    // A failing UI observer must not leave an unhandled asynchronous poll behind.
    try { callback(levels) } catch { /* The next measurement remains independent. */ }
  }
  const unavailable = () => emit({ available: false, inputLevel: 0, outputLevel: 0 })
  const stopIfClosed = () => {
    if (!closed()) return false
    dispose()
    unavailable()
    return true
  }

  async function poll() {
    if (disposed || stopIfClosed() || pending) return
    pending = true
    try {
      const report = await peer.getStats()
      if (disposed || stopIfClosed()) return
      const next = new Map<string, EnergySample>()
      const input: (number | null)[] = []
      const output: (number | null)[] = []
      report.forEach((value: AudioStats, key: string) => {
        if ((value.kind ?? value.mediaType) !== 'audio') return
        const target = value.type === 'inbound-rtp' ? output : value.type === 'media-source' ? input : null
        if (!target) return
        const id = `${value.type}:${value.id ?? key}`
        const energy = value.totalAudioEnergy
        const duration = value.totalSamplesDuration
        let level = directLevel(value.audioLevel)
        if (nonNegative(energy) && nonNegative(duration)) {
          next.set(id, { energy, duration })
          const before = previous.get(id)
          if (before && duration > before.duration && energy >= before.energy) {
            // W3C interval RMS: sqrt(delta totalAudioEnergy / delta totalSamplesDuration).
            const rms = Math.sqrt((energy - before.energy) / (duration - before.duration))
            if (Number.isFinite(rms) && rms <= 1) level = rms
          }
        }
        target.push(level)
      })
      previous = next
      // Missing or invalid samples are unknown, never evidence of quiet audio.
      const known = (levels: (number | null)[]) => levels.length > 0 && levels.every(level => level !== null)
      const loudest = (levels: (number | null)[]) => levels.reduce<number>((max, level) => Math.max(max, level ?? 0), 0)
      emit({ available: known(input) && known(output), inputLevel: loudest(input), outputLevel: loudest(output) })
    } catch {
      if (disposed || stopIfClosed()) return
      previous.clear()
      unavailable()
    } finally {
      pending = false
    }
  }

  timer = setInterval(() => { void poll() }, POLL_MS)
  void poll()
  return { dispose }
}
