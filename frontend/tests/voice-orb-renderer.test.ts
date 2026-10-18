import assert from 'node:assert/strict'
import test from 'node:test'
import { animateOrb } from '../src/features/voice/orb-renderer.ts'
import { SILENT_SIGNAL } from '../src/features/voice/activity.ts'

test('drawing sleeps offscreen/hidden, honors reduced motion and releases observers and scheduling', () => {
  const keys = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver']
  const original = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))
  const frames = new Map<number, FrameRequestCallback>()
  const timers = new Set<number>()
  const visibility = new Set<() => void>(); const preference = new Set<() => void>()
  let next = 0; let intersection: (entries: { isIntersecting: boolean }[]) => void = () => {}
  let observersClosed = 0
  const media = { matches: false, addEventListener(_name: string, f: () => void) { preference.add(f) }, removeEventListener(_name: string, f: () => void) { preference.delete(f) } }
  const document = { hidden: false, addEventListener(_name: string, f: () => void) { visibility.add(f) }, removeEventListener(_name: string, f: () => void) { visibility.delete(f) } }
  const gradient = { addColorStop() {} }
  const context = new Proxy({}, { get: (_target, key) => String(key).startsWith('create') ? () => gradient : () => {} })
  const canvas = { getContext: () => context, clientWidth: 220, width: 0, height: 0, dataset: {} } as unknown as HTMLCanvasElement
  Object.assign(globalThis, {
    window: { devicePixelRatio: 2, matchMedia: () => media, setInterval() { const id = ++next; timers.add(id); return id } }, document,
    requestAnimationFrame(callback: FrameRequestCallback) { const id = ++next; frames.set(id, callback); return id },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    IntersectionObserver: class { constructor(callback: typeof intersection) { intersection = callback } observe() {} disconnect() { observersClosed++ } },
    ResizeObserver: class { observe() {} disconnect() { observersClosed++ } },
  })
  const clear = globalThis.clearInterval
  globalThis.clearInterval = ((id: number) => { timers.delete(id) }) as unknown as typeof clearInterval
  const paint = () => { const [id, callback] = frames.entries().next().value!; frames.delete(id); callback(100) }
  try {
    const dispose = animateOrb(canvas, () => ({ input: SILENT_SIGNAL, output: SILENT_SIGNAL }))
    assert.equal(frames.size, 1)
    paint()
    assert.equal(canvas.dataset.ready, 'true')
    assert.equal(canvas.width, 440)
    assert.equal(frames.size, 1)
    intersection([{ isIntersecting: false }]); assert.equal(frames.size, 0)
    intersection([{ isIntersecting: true }]); assert.equal(frames.size, 1)
    document.hidden = true; visibility.forEach(callback => callback()); assert.equal(frames.size, 0)
    document.hidden = false; visibility.forEach(callback => callback()); assert.equal(frames.size, 1)
    media.matches = true; preference.forEach(callback => callback()); paint()
    assert.equal(frames.size, 0, 'Reduced motion renders one static frame, not a continuous animation')
    dispose(); dispose()
    assert.equal(frames.size, 0); assert.equal(timers.size, 0)
    assert.equal(visibility.size, 0); assert.equal(preference.size, 0)
    assert.equal(observersClosed, 2)
  } finally {
    globalThis.clearInterval = clear
    keys.forEach((key, i) => { if (original[i]) Object.defineProperty(globalThis, key, original[i]!); else Reflect.deleteProperty(globalThis, key) })
  }
})
