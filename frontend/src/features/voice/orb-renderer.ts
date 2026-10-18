import { advanceOrbMotion, createOrbMotion, orbContour, ORB_DEFORMATION } from './orb-motion.ts'
import type { AudioSignal } from './activity.ts'

type Signals = { input: AudioSignal; output: AudioSignal }

/** Canvas paint only. Capture, playback and Web Audio graphs remain owned by LiveClient. */
export function animateOrb(canvas: HTMLCanvasElement, signals: () => Signals) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  let motion = createOrbMotion()
  let frame = 0
  let last = 0
  let visible = true
  let disposed = false
  let lastInput: AudioSignal | undefined
  let lastOutput: AudioSignal | undefined

  function path(points: [number, number][]) {
    ctx!.beginPath()
    // Quadratic midpoint interpolation closes the contour without corners or a seam.
    const lastPoint = points.at(-1)!
    ctx!.moveTo((lastPoint[0] + points[0][0]) / 2, (lastPoint[1] + points[0][1]) / 2)
    points.forEach((point, index) => {
      const next = points[(index + 1) % points.length]
      ctx!.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2)
    })
    ctx!.closePath()
  }
  function cloud(x: number, y: number, radius: number, color: string, opacity: number) {
    const gradient = ctx!.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, color)
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    ctx!.globalAlpha = opacity
    ctx!.fillStyle = gradient
    ctx!.fillRect(0, 0, 256, 256)
    ctx!.globalAlpha = 1
  }
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
    const { input, output, phase } = motion
    const level = Math.max(input, output)

    // Preserve the original dotted circles; only the orb surface uses gradients.
    if (output > .001) {
      ctx!.setLineDash([3, 5])
      ctx!.lineWidth = 1.8 + output * .4
      for (let layer = 0; layer < (reduced.matches ? 1 : 3); layer++) {
        const spread = reduced.matches ? .35 : (phase * .85 + layer / 3) % 1
        const radius = 84 + output * 4 + spread * 25
        const alpha = (.55 + output * .4) * (1 - spread)
        ctx!.strokeStyle = `rgba(105,108,116,${alpha})`
        ctx!.beginPath()
        ctx!.arc(128, 128, radius, 0, Math.PI * 2)
        ctx!.stroke()
      }
      ctx!.setLineDash([])
    }
    const contour = orbContour(motion, 76, reduced.matches ? 0 : ORB_DEFORMATION)
    ctx!.save()
    path(contour)
    ctx!.clip()
    const base = ctx!.createLinearGradient(75, 60, 176, 215)
    base.addColorStop(0, '#e7eeff')
    base.addColorStop(.38, '#b9ceff')
    base.addColorStop(.7, '#426ce8')
    base.addColorStop(1, '#1946cc')
    ctx!.fillStyle = base
    ctx!.fillRect(0, 0, 256, 256)

    // Large overlapping gradients form a moving blue/white surface, not a line chart.
    const drift = reduced.matches ? 0 : phase
    const flow = 9 + input * 11 + output * 20
    cloud(105 + Math.sin(drift * 1.1) * flow, 103 + Math.cos(drift * .8) * flow * .7, 86 + output * 13, '#ffffff', .97)
    cloud(71 + Math.cos(drift * .7) * 19, 136 + Math.sin(drift * 1.3) * flow, 59 + input * 20, '#f5faff', .86)
    cloud(157 + Math.cos(drift) * flow, 168 + Math.sin(drift * .9) * flow * .8, 83, '#2754e7', .72)
    cloud(139 + Math.sin(drift * .8 + 2) * flow, 96 + Math.cos(drift * .6) * 25, 53 + output * 19, '#ffffff', .84)
    cloud(114 + Math.cos(drift * 1.2) * 26, 183, 64, '#668eff', .46)
    const light = ctx!.createRadialGradient(97, 79, 8, 123, 125, 85)
    light.addColorStop(0, '#ffffff70')
    light.addColorStop(.65, '#ffffff00')
    light.addColorStop(1, '#163db314')
    ctx!.fillStyle = light
    ctx!.fillRect(0, 0, 256, 256)
    ctx!.restore()
    canvas.dataset.ready = 'true'
    // Visible DOM diagnostics also make volume response inspectable without reading audio data.
    canvas.dataset.energy = level.toFixed(3)
    canvas.dataset.silhouette = (76 + input * 3 + output * 7).toFixed(2)
    lastInput = target.input; lastOutput = target.output
    if (!reduced.matches || target.input !== signals().input || target.output !== signals().output) frame = requestAnimationFrame(draw)
  }
  function wake() {
    if (!disposed && visible && !document.hidden && !frame) frame = requestAnimationFrame(draw)
  }
  function visibility() {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; last = 0 }
    else wake()
  }
  // Reduced motion needs a new static painting only when the source changes.
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
    disposed = true
    cancelAnimationFrame(frame)
    clearInterval(check)
    observer?.disconnect()
    resize?.disconnect()
    document.removeEventListener('visibilitychange', visibility)
    reduced.removeEventListener('change', wake)
  }
}
