import { SILENT_SIGNAL } from './activity.ts'
import type { AudioSignal } from './activity.ts'

export interface OrbMotion {
  input: number
  output: number
  wave: number[]
  phase: number
}
export const ORB_DEFORMATION = 2
export const createOrbMotion = (): OrbMotion => ({ input: 0, output: 0, wave: Array(32).fill(0), phase: 0 })
const clamp = (n: number, low = 0, high = 1) => Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : 0

/** Temporal easing plus circular low-pass filtering: PCM never becomes a jagged polyline. */
export function advanceOrbMotion(previous: OrbMotion, input: AudioSignal = SILENT_SIGNAL, output: AudioSignal = SILENT_SIGNAL, seconds = 1 / 60): OrbMotion {
  const dt = clamp(seconds, 0, .05)
  const ease = 1 - Math.exp(-dt * 16)
  const inputLevel = input.active ? clamp(input.level) : 0
  const outputLevel = output.active ? clamp(output.level) : 0
  const smooth = (before: number, target: number) => target === 0 ? 0 : before + (target - before) * ease
  const wave = previous.wave.map((before, index) => {
    if (!input.active) return 0
    let sample = 0
    let weight = 0
    for (let offset = -4; offset <= 4; offset++) {
      const position = (index / previous.wave.length * input.waveform.length + offset + input.waveform.length) % input.waveform.length
      const value = input.waveform[Math.floor(position)] ?? 0
      const w = 5 - Math.abs(offset)
      sample += clamp(value, -1, 1) * w
      weight += w
    }
    return before + (sample / weight - before) * ease
  })
  return {
    input: smooth(previous.input, inputLevel), output: smooth(previous.output, outputLevel), wave,
    phase: previous.phase + dt * (.22 + inputLevel * .65 + outputLevel * .95),
  }
}

/** Small, smooth deviations keep the silhouette recognizably circular at every volume. */
export function orbContour(motion: OrbMotion, radius = 76, strength = ORB_DEFORMATION): [number, number][] {
  return Array.from({ length: 96 }, (_, index) => {
    const angle = index / 96 * Math.PI * 2
    const position = index / 96 * motion.wave.length
    const from = Math.floor(position)
    const wave = (motion.wave[from % motion.wave.length] ?? 0) * (1 - position % 1) + (motion.wave[(from + 1) % motion.wave.length] ?? 0) * (position % 1)
    const ripple = Math.sin(angle * 3 + motion.phase * 2.2) * .55 + Math.sin(angle * 5 - motion.phase * 1.4) * .25 + wave * .8
    const r = radius + motion.input * 3 + motion.output * 7 + strength * motion.input * 5 * ripple
    return [128 + Math.cos(angle) * r, 128 + Math.sin(angle) * r]
  })
}
