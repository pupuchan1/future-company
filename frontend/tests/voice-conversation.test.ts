import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationActivity } from '../src/features/voice/conversation.ts'

test('accepted input waits for audible response, holding short gaps in both voices', () => {
  const turn = new ConversationActivity()
  assert.equal(turn.sample(0, 0, true, false, 1000), 'listening')
  assert.equal(turn.sample(.1, 0, true, false, 1100), 'user')
  turn.acceptInput(1200)
  assert.equal(turn.sample(0, 0, true, false, 1400), 'user')
  assert.equal(turn.sample(0, 0, true, false, 1500), 'waiting')
  assert.equal(turn.sample(0, .1, false, false, 1600), 'waiting', 'Received but blocked audio does not speak')
  assert.equal(turn.sample(0, .1, true, false, 1700), 'assistant')
  assert.equal(turn.sample(0, 0, true, false, 2200), 'assistant')
  assert.equal(turn.sample(0, 0, true, false, 2400), 'listening')
})
test('simultaneous speech preserves input intent until output follows the interruption', () => {
  const turn = new ConversationActivity()
  turn.sample(0, .1, true, false, 1000)
  turn.acceptInput(1100)
  assert.equal(turn.sample(.1, .1, true, false, 1100), 'both')
  assert.equal(turn.sample(0, 0, true, false, 1800), 'waiting')
  assert.equal(turn.sample(0, .1, true, false, 1900), 'assistant')
  assert.equal(turn.sample(0, 0, true, false, 2600), 'listening')
})
test('mute only cancels input hold; pause cancels output hold; reset discards pending intent', () => {
  const turn = new ConversationActivity()
  turn.acceptInput(1000)
  turn.sample(.2, .2, true, false, 1000)
  assert.equal(turn.sample(.2, .2, true, true, 1100), 'assistant')
  assert.equal(turn.sample(0, .2, false, true, 1200), 'waiting')
  turn.reset()
  assert.equal(turn.sample(0, 0, false, false, 1300), 'listening')
  turn.awaitResponse()
  assert.equal(turn.sample(0, 0, false, false, 1400), 'waiting')
  turn.fail()
  assert.equal(turn.sample(0, 0, false, false, 1500), 'listening')
})
test('noise without accepted input does not invent a pending response', () => {
  const turn = new ConversationActivity()
  turn.sample(.1, 0, false, false, 1000)
  assert.equal(turn.sample(0, 0, false, false, 1400), 'listening')
})

import { orbVolumes } from '../src/features/voice/orb-volumes.ts'
import { SILENT_SIGNAL } from '../src/features/voice/activity.ts'
test('both speakers articulate inside the sphere; visual gain is bounded and silence stays silent', () => {
  const quiet = { ...SILENT_SIGNAL, active: true, level: .04 }
  const loud = { ...quiet, level: .36 }
  const input = orbVolumes(quiet, SILENT_SIGNAL)
  const output = orbVolumes(SILENT_SIGNAL, quiet)
  assert.ok(input.deformation > quiet.level)
  assert.equal(output.deformation, input.deformation, 'AI output must deform the interior too')
  assert.ok(output.flow > input.flow)
  assert.ok(orbVolumes(loud, SILENT_SIGNAL).deformation > input.deformation)
  assert.deepEqual(orbVolumes(SILENT_SIGNAL, SILENT_SIGNAL), { deformation: 0, flow: 0 })
  assert.deepEqual(orbVolumes({ ...quiet, level: NaN }, SILENT_SIGNAL), { deformation: 0, flow: 0 })
  assert.deepEqual(orbVolumes({ ...loud, level: 2 }, { ...loud, level: 2 }), { deformation: 1, flow: 1 })
})
