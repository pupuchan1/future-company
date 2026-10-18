import { SILENT_SIGNAL } from './activity.ts'
import type { AudioSignal } from './activity.ts'

export interface OrbMotion {
  input: number
  output: number
  wave: number[]
  phase: number
}
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
