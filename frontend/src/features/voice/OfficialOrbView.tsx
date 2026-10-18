import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AudioSignal } from './activity.ts'

const Orb = lazy(() => import('./elevenlabs/Orb.tsx').then(module => ({ default: module.Orb })))
const officialColors: [string, string] = ['#7F9FC9', '#E8D5B5']
const fallback = <div className="voice-orb-static" />

class OrbBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? fallback : this.props.children }
}

/** Keep the upstream Orb intact. Only bind real levels and mount it while visible. */
export function OfficialOrbView({ input, output }: { input: AudioSignal; output: AudioSignal }) {
  const host = useRef<HTMLDivElement>(null)
  const levels = useRef({ input, output })
  const [enabled, setEnabled] = useState(true)
  useEffect(() => { levels.current = { input, output } }, [input, output])
  const getInputVolume = useCallback(() => levels.current.input.active ? levels.current.input.level : 0, [])
  // Upstream's Listening demo drives this flow parameter too (targetOut=.45).
  // Drive it from measured input while listening; AI labels/rings still use real output only.
  const getSurfaceFlow = useCallback(() => Math.max(
    levels.current.input.active ? levels.current.input.level : 0,
    levels.current.output.active ? levels.current.output.level : 0,
  ), [])
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    let visible = true
    const update = () => setEnabled(visible && !document.hidden && !preference.matches)
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update() })
    if (host.current) observer?.observe(host.current)
    document.addEventListener('visibilitychange', update)
    preference.addEventListener('change', update)
    update()
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); preference.removeEventListener('change', update) }
  }, [])
  return <div className="voice-orb-surface" ref={host} data-renderer="elevenlabs-official">
    {enabled ? <OrbBoundary><Suspense fallback={fallback}>
      <Orb seed={1000} colors={officialColors} volumeMode="manual" getInputVolume={getInputVolume} getOutputVolume={getSurfaceFlow} className="voice-orb-official" />
    </Suspense></OrbBoundary> : fallback}
  </div>
}
