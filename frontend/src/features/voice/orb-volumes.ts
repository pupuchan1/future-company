import type { AudioSignal } from './activity.ts'

/** Visual gain only: never feed it back into speech detection or playback. */
export function orbVolumes(input: AudioSignal, output: AudioSignal) {
  const level = (signal: AudioSignal) => signal.active && Number.isFinite(signal.level)
    ? Math.max(0, Math.min(1, signal.level)) : 0
  const inputLevel = level(input)
  const outputLevel = level(output)
  const energy = Math.max(inputLevel, outputLevel)
  // The official deformation input is a visual parameter, not a microphone
  // identity. Both speakers must articulate inside the sphere. A square-root
  // curve brings quiet syllables into view without animating silence.
  return {
    deformation: Math.min(1, Math.sqrt(energy) * 1.25),
    flow: Math.min(1, Math.sqrt(Math.max(inputLevel * .72, outputLevel))),
  }
}
