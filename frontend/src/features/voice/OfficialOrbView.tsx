import { orbVolumes } from './orb-volumes.ts'
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { AudioSignal } from './activity.ts'

const Orb = lazy(() => import('./elevenlabs/Orb.tsx').then(module => ({ default: module.Orb })))
const brandColors: [string, string] = ['#8198B8', '#9ACFC2']
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
  const getInputVolume = useCallback(() => orbVolumes(levels.current.input, levels.current.output).deformation, [])
  const getSurfaceFlow = useCallback(() => orbVolumes(levels.current.input, levels.current.output).flow, [])
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
      <Orb seed={1000} colors={brandColors} volumeMode="manual" getInputVolume={getInputVolume} getOutputVolume={getSurfaceFlow} className="voice-orb-official" />
    </Suspense></OrbBoundary> : fallback}
  </div>
}
