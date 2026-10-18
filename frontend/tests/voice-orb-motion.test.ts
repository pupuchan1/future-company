import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceOrbMotion, createOrbMotion } from '../src/features/voice/orb-motion.ts'
import { SILENT_SIGNAL } from '../src/features/voice/activity.ts'

test('output-ring levels ease real audio independently and silence immediately on stop', () => {
  const signal = { level: .6, active: true, waveform: Array(64).fill(.2) }
  const input = advanceOrbMotion(createOrbMotion(), signal, SILENT_SIGNAL)
  const both = advanceOrbMotion(input, signal, signal)
  assert.equal(input.output, 0)
  assert.ok(both.input > 0 && both.output > 0 && both.output < signal.level)
  const stopped = advanceOrbMotion(both, SILENT_SIGNAL, SILENT_SIGNAL)
  assert.equal(stopped.input, 0); assert.equal(stopped.output, 0)
})
