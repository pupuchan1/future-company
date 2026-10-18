import { advanceOrbMotion, createOrbMotion } from './orb-motion.ts'
import type { AudioSignal } from './activity.ts'

type Signals = { input: AudioSignal; output: AudioSignal }

/** Gray dotted output rings only. The sphere is the unchanged official ElevenLabs Orb. */
export function animateOrb(canvas: HTMLCanvasElement, signals: () => Signals) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let motion = createOrbMotion()
  let frame = 0; let last = 0
  let visible = true; let disposed = false
  let lastInput: AudioSignal | undefined; let lastOutput: AudioSignal | undefined
  function draw(time: number) {
    frame = 0
    if (disposed || !visible || document.hidden) return
    const target = signals()
    const dt = last ? Math.min((time - last) / 1000, .05) : 1 / 60
    last = time
    motion = advanceOrbMotion(motion, target.input, target.output, reduced.matches ? .05 : dt)
    if (reduced.matches) motion.phase = 0
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const size = Math.round(Math.max(1, canvas.clientWidth) * ratio)
    if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size }
    ctx!.setTransform(size / 256, 0, 0, size / 256, 0, 0)
    ctx!.clearRect(0, 0, 256, 256)
    const { output, phase } = motion
    if (output > .001) {
      ctx!.setLineDash([3, 5]); ctx!.lineWidth = 1.8 + output * .4
      for (let layer = 0; layer < (reduced.matches ? 1 : 3); layer++) {
        const spread = reduced.matches ? .35 : (phase * .85 + layer / 3) % 1
        ctx!.strokeStyle = `rgba(105,108,116,${(.55 + output * .4) * (1 - spread)})`
        ctx!.beginPath(); ctx!.arc(128, 128, 84 + output * 4 + spread * 25, 0, Math.PI * 2); ctx!.stroke()
      }
      ctx!.setLineDash([])
    }
    canvas.dataset.ready = 'true'
    canvas.dataset.renderer = 'gray-dotted-output'
    canvas.dataset.energy = Math.max(motion.input, motion.output).toFixed(3)
    lastInput = target.input; lastOutput = target.output
    if (!reduced.matches) frame = requestAnimationFrame(draw)
  }
  function wake() { if (!disposed && visible && !document.hidden && !frame) frame = requestAnimationFrame(draw) }
  function visibility() {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0 }
    else wake()
  }
  const check = window.setInterval(() => {
    const next = signals()
    if (reduced.matches && (next.input !== lastInput || next.output !== lastOutput)) wake()
  }, 100)
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    if (!visible) { cancelAnimationFrame(frame); frame = 0; last = 0 }
    else wake()
  })
  observer?.observe(canvas)
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(wake)
  resize?.observe(canvas)
  document.addEventListener('visibilitychange', visibility)
  reduced.addEventListener('change', wake)
  wake()
  return () => {
    if (disposed) return
    disposed = true; cancelAnimationFrame(frame); clearInterval(check)
    observer?.disconnect(); resize?.disconnect()
    document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', wake)
  }
}
