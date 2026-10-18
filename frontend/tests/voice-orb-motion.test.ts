import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceOrbMotion, createOrbMotion, orbContour } from '../src/features/voice/orb-motion.ts'
import { measureSignal, SILENT_SIGNAL } from '../src/features/voice/activity.ts'

const voice = (volume: number) => measureSignal(Float32Array.from({ length: 512 }, (_, i) => Math.sin(i * Math.PI / 16) * volume))
const radius = (points: [number, number][]) => points.map(([x, y]) => Math.hypot(x - 128, y - 128))
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

test('actual audio volume controls deformation while silence remains circular', () => {
  const silent = advanceOrbMotion(createOrbMotion(), SILENT_SIGNAL, SILENT_SIGNAL)
  assert.ok(radius(orbContour(silent)).every(r => Math.abs(r - 76) < .001))
  const quiet = advanceOrbMotion(createOrbMotion(), voice(.02), SILENT_SIGNAL, .05)
  const loud = advanceOrbMotion(createOrbMotion(), voice(.2), SILENT_SIGNAL, .05)
  const qr = radius(orbContour(quiet)); const lr = radius(orbContour(loud))
  assert.ok(average(lr) > average(qr))
  assert.ok(Math.max(...lr) - Math.min(...lr) > Math.max(...qr) - Math.min(...qr))
  assert.ok(lr.every(r => r > 68 && r < 94), 'Loud input stays a round orb, never a spiky star')
  const ended = advanceOrbMotion(loud, SILENT_SIGNAL, SILENT_SIGNAL)
  assert.equal(ended.input, 0)
  assert.ok(radius(orbContour(ended)).every(r => Math.abs(r - 76) < .001))
})

test('input, output and duplex have independent motion; smoothing limits frame discontinuities', () => {
  const input = advanceOrbMotion(createOrbMotion(), voice(.2), SILENT_SIGNAL)
  const output = advanceOrbMotion(createOrbMotion(), SILENT_SIGNAL, voice(.2))
  const both = advanceOrbMotion(createOrbMotion(), voice(.2), voice(.2))
  assert.equal(input.output, 0); assert.equal(output.input, 0)
  assert.ok(both.input > 0 && both.output > 0)
  assert.notDeepEqual(orbContour(input), orbContour(output))
  assert.ok(input.input < voice(.2).level, 'Ease audio frames into the visual instead of snapping')
  const alternating = { level: 1, active: true, waveform: Array.from({ length: 64 }, (_, i) => i % 2 ? -1 : 1) }
  let motion = createOrbMotion()
  for (let i = 0; i < 30; i++) motion = advanceOrbMotion(motion, alternating, alternating)
  const radii = radius(orbContour(motion))
  assert.ok(radii.every((r, i) => Math.abs(r - radii[(i + 1) % radii.length]) < 4), 'Circular low pass rejects jagged PCM edges, including the closing seam')
  const invalid = advanceOrbMotion(createOrbMotion(), { level: Infinity, active: true, waveform: [NaN, Infinity] })
  assert.ok(orbContour(invalid).flat().every(Number.isFinite))
})

test('requested stronger contour doubles the edge displacement without changing its base circle', () => {
  const motion = advanceOrbMotion(createOrbMotion(), voice(.2), voice(.2), .05)
  const regular = radius(orbContour(motion, 76, 1))
  const doubled = radius(orbContour(motion))
  const base = 76 + motion.input * 3 + motion.output * 7
  regular.forEach((r, index) => assert.ok(Math.abs((doubled[index] - base) - (r - base) * 2) < .0001))
})

test('AI-only output keeps an exact circle while volume still controls its size', () => {
  for (const phase of [0, .5, 1, 5]) {
    const motion = { ...advanceOrbMotion(createOrbMotion(), SILENT_SIGNAL, voice(.2), .05), phase }
    const radii = radius(orbContour(motion))
    assert.ok(radii.every(r => Math.abs(r - (76 + motion.output * 7)) < .0001))
  }
})
