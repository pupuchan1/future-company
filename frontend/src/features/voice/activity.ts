export interface AudioSignal {
  level: number
  active: boolean
  waveform: readonly number[]
}
export interface VoiceActivity {
  available: boolean
  input: AudioSignal
  output: AudioSignal
}
export interface VoiceActivitySource {
  getSnapshot: () => VoiceActivity
  subscribe: (listener: () => void) => () => void
}

export const SILENT_SIGNAL: AudioSignal = { level: 0, active: false, waveform: Array(64).fill(0) }
export const SILENT_ACTIVITY: VoiceActivity = { available: false, input: SILENT_SIGNAL, output: SILENT_SIGNAL }

/** Kept separate from conversation snapshots so audio frames only rerender the orb. */
export class VoiceActivityStore implements VoiceActivitySource {
  private snapshot = SILENT_ACTIVITY
  private listeners = new Set<() => void>()
  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  publish(snapshot: VoiceActivity) {
    if (snapshot === this.snapshot) return
    this.snapshot = snapshot
    this.listeners.forEach(listener => listener())
  }
  reset() { this.publish(SILENT_ACTIVITY) }
}

/** A noise gate excludes ambient noise; a short release avoids flickering between syllables. */
export function measureSignal(samples: Float32Array, previous: AudioSignal = SILENT_SIGNAL): AudioSignal {
  let power = 0
  for (const sample of samples) power += Number.isFinite(sample) ? sample * sample : 0
  const rms = Math.sqrt(power / Math.max(1, samples.length))
  const target = rms >= 0.008 ? Math.min(1, rms * 7) : 0
  const level = target > previous.level ? previous.level * 0.3 + target * 0.7 : previous.level * 0.5 + target * 0.5
  if (level < 0.025) return SILENT_SIGNAL
  const scale = Math.max(0.025, rms * 3)
  const waveform = Array.from({ length: 64 }, (_, index) => {
    // Preserve each bin's signed peak; fixed-step sampling can land on every
    // zero crossing of a clear tone and incorrectly draw a flat circle.
    const from = Math.floor(index * samples.length / 64)
    const to = Math.max(from + 1, Math.floor((index + 1) * samples.length / 64))
    let peak = 0
    for (let i = from; i < to; i++) {
      const sample = samples[i] ?? 0
      if (Number.isFinite(sample) && Math.abs(sample) > Math.abs(peak)) peak = sample
    }
    return Math.max(-1, Math.min(1, peak / scale))
  })
  return { level, active: true, waveform }
}

export function radialWavePath(waveform: readonly number[], level: number, radius = 91): string {
  const strength = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0))
  const points = Array.from({ length: 128 }, (_, index) => {
    const phase = index / 128
    const position = phase * waveform.length
    const a = waveform[Math.floor(position) % waveform.length] ?? 0
    const b = waveform[(Math.floor(position) + 1) % waveform.length] ?? 0
    const sample = Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * (position % 1) : 0
    const r = radius + sample * (7 + strength * 20)
    const angle = phase * Math.PI * 2 - Math.PI / 2
    return `${(128 + Math.cos(angle) * r).toFixed(2)},${(128 + Math.sin(angle) * r).toFixed(2)}`
  })
  return `M${points.join(' L')} Z`
}
