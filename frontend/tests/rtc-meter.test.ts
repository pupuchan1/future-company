import assert from 'node:assert/strict'
import test from 'node:test'
import { createRtcMeter } from '../src/features/live/rtc-meter.ts'
import type { RtcAudioLevels } from '../src/features/live/rtc-meter.ts'

type Row = Record<string, unknown>
const input = (values: Row = {}) => ({ id: 'mic', type: 'media-source', kind: 'audio', ...values })
const output = (values: Row = {}) => ({ id: 'speaker', type: 'inbound-rtp', kind: 'audio', ...values })
const report = (...rows: Row[]) => new Map(rows.map((row, index) => [String(row.id ?? index), row])) as unknown as RTCStatsReport
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture(getStats: () => Promise<RTCStatsReport>) {
  const peer = { connectionState: 'connected', signalingState: 'stable', getStats }
  const samples: RtcAudioLevels[] = []
  const meter = createRtcMeter(peer as unknown as RTCPeerConnection, value => samples.push(value))
  return { peer, samples, meter }
}

test('uses interval energy RMS at 250 ms, not cumulative audio energy', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  const f = fixture(async () => ++calls === 1
    ? report(input({ totalAudioEnergy: 10, totalSamplesDuration: 100 }), output({ totalAudioEnergy: 20, totalSamplesDuration: 100 }))
    : report(input({ totalAudioEnergy: 10.01, totalSamplesDuration: 100.25 }), output({ totalAudioEnergy: 20.0625, totalSamplesDuration: 100.25 })))
  try {
    await flush()
    assert.deepEqual(f.samples, [{ available: false, inputLevel: 0, outputLevel: 0 }])
    t.mock.timers.tick(249)
    await flush()
    assert.equal(calls, 1)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(calls, 2)
    assert.equal(f.samples.at(-1)!.available, true)
    assert.ok(Math.abs(f.samples.at(-1)!.inputLevel - 0.2) < 1e-12)
    assert.equal(f.samples.at(-1)!.outputLevel, 0.5)
  } finally { f.meter.dispose() }
})

test('audioLevel is a valid first-sample fallback; zero is measured silence and unrelated stats are ignored', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const f = fixture(async () => report(
    input({ audioLevel: 0 }), output({ audioLevel: 0.4 }),
    { id: 'video', type: 'inbound-rtp', kind: 'video', audioLevel: 1 },
    { id: 'remote', type: 'remote-inbound-rtp', kind: 'audio', audioLevel: Number.NaN },
  ))
  try {
    await flush()
    assert.deepEqual(f.samples, [{ available: true, inputLevel: 0, outputLevel: 0.4 }])
  } finally { f.meter.dispose() }
})

test('missing, non-finite, and stalled/reset counters cannot establish quiet audio', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let current = report(input({ audioLevel: 0.1 }), output({ audioLevel: Number.NaN }))
  const f = fixture(async () => current)
  const next = async (value: RTCStatsReport) => { current = value; t.mock.timers.tick(250); await flush() }
  try {
    await flush()
    assert.equal(f.samples.at(-1)!.available, false)
    await next(report(output({ audioLevel: 0 })))
    assert.equal(f.samples.at(-1)!.available, false, 'Missing microphone is not silence')
    await next(report(input({ audioLevel: Number.POSITIVE_INFINITY }), output({ audioLevel: 0 })))
    assert.equal(f.samples.at(-1)!.available, false)
    const counts = (energy: number, duration: number) => report(input({ audioLevel: 0 }), output({ totalAudioEnergy: energy, totalSamplesDuration: duration }))
    await next(counts(2, 10))
    await next(counts(2, 10))
    assert.equal(f.samples.at(-1)!.available, false, 'No duration progress cannot prove silence')
    await next(counts(0, 0))
    assert.equal(f.samples.at(-1)!.available, false, 'Counter reset must establish a fresh baseline')
    await next(counts(0, 0.25))
    assert.deepEqual(f.samples.at(-1), { available: true, inputLevel: 0, outputLevel: 0 })
  } finally { f.meter.dispose() }
})

test('uses the loudest audio track and does not hide an unknown track', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let unknown = false
  const f = fixture(async () => report(input({ audioLevel: 0.1 }), output({ audioLevel: 0.2 }), output({ id: 'second', audioLevel: unknown ? Number.NaN : 0.7 })))
  try {
    await flush()
    assert.deepEqual(f.samples.at(-1), { available: true, inputLevel: 0.1, outputLevel: 0.7 })
    unknown = true
    t.mock.timers.tick(250)
    await flush()
    assert.deepEqual(f.samples.at(-1), { available: false, inputLevel: 0.1, outputLevel: 0.2 })
  } finally { f.meter.dispose() }
})

test('failed getStats invalidates the measurement and resets the RMS baseline', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let fail = false
  let energy = 1
  const f = fixture(async () => {
    if (fail) throw new Error('peer unavailable')
    return report(input({ audioLevel: 0 }), output({ totalAudioEnergy: energy, totalSamplesDuration: energy * 4 }))
  })
  try {
    await flush()
    energy = 2
    t.mock.timers.tick(250)
    await flush()
    assert.equal(f.samples.at(-1)!.available, true)
    fail = true
    t.mock.timers.tick(250)
    await flush()
    assert.deepEqual(f.samples.at(-1), { available: false, inputLevel: 0, outputLevel: 0 })
    fail = false; energy = 3
    t.mock.timers.tick(250)
    await flush()
    assert.equal(f.samples.at(-1)!.available, false, 'Recovery seeds a fresh baseline')
    energy = 4
    t.mock.timers.tick(250)
    await flush()
    assert.equal(f.samples.at(-1)!.outputLevel, 0.5)
    assert.equal(f.samples.at(-1)!.available, true)
  } finally { f.meter.dispose() }
})

test('never overlaps getStats and discards resolution after idempotent disposal', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  let resolve!: (value: RTCStatsReport) => void
  const f = fixture(() => { calls++; return new Promise(done => { resolve = done }) })
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(calls, 1)
  f.meter.dispose()
  f.meter.dispose()
  resolve(report(input({ audioLevel: 1 }), output({ audioLevel: 1 })))
  await flush()
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(calls, 1)
  assert.deepEqual(f.samples, [])
})

test('a pending rejection after disposal cannot publish or resume polling', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let reject!: (error: Error) => void
  let calls = 0
  const f = fixture(() => { calls++; return new Promise((_resolve, fail) => { reject = fail }) })
  f.meter.dispose()
  reject(new Error('closed during measurement'))
  await flush()
  t.mock.timers.tick(1000)
  assert.equal(calls, 1)
  assert.deepEqual(f.samples, [])
})

test('closed peer invalidates an in-flight sample and stops polling', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  let resolve!: (value: RTCStatsReport) => void
  const f = fixture(() => { calls++; return new Promise(done => { resolve = done }) })
  f.peer.connectionState = 'closed'
  t.mock.timers.tick(250)
  await flush()
  assert.deepEqual(f.samples, [{ available: false, inputLevel: 0, outputLevel: 0 }], 'Close does not wait for a pending getStats call')
  resolve(report(input({ audioLevel: 1 }), output({ audioLevel: 1 })))
  await flush()
  assert.deepEqual(f.samples, [{ available: false, inputLevel: 0, outputLevel: 0 }])
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(calls, 1)
  f.meter.dispose()
})
