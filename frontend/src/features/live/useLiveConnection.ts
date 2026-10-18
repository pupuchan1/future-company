import { VoiceActivityStore } from '../voice/activity.ts'
import { useEffect, useRef, useState } from 'react'
import { LiveClient } from './client.ts'
import type { LiveClientOptions } from './client.ts'
import { initialSnapshot } from './types.ts'
import type { LiveLanguage, LiveRoute } from './types.ts'

export function useLiveConnection({ caseId, language, apiPrefix, bridgeToken, enabled = true }: { caseId: string; language: LiveLanguage; enabled?: boolean } & LiveClientOptions) {
  const [snapshot, setSnapshot] = useState(() => initialSnapshot(caseId, language))
  const [voice, setVoice] = useState(() => new VoiceActivityStore())
  const client = useRef<LiveClient | null>(null)
  const languageRef = useRef(language)
  useEffect(() => { languageRef.current = language }, [language])
  useEffect(() => {
    if (!enabled) return
    const next = new LiveClient(caseId, languageRef.current, undefined, { apiPrefix, bridgeToken })
    client.current = next
    setSnapshot(next.getSnapshot())
    setVoice(next.voice)
    const unsubscribe = next.subscribe(setSnapshot)
    const pagehide = () => next.dispose()
    // A BFCache restore needs a fresh event stream and a user-started new call.
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload() }
    window.addEventListener('pagehide', pagehide)
    window.addEventListener('pageshow', pageshow)
    next.observe()
    return () => {
      unsubscribe(); next.dispose()
      if (client.current === next) client.current = null
      window.removeEventListener('pagehide', pagehide)
      window.removeEventListener('pageshow', pageshow)
    }
  }, [caseId, apiPrefix, bridgeToken, enabled])
  return {
    snapshot: enabled && snapshot.caseId === caseId ? snapshot : initialSnapshot(caseId, language),
    voice,
    start: (route?: LiveRoute) => client.current?.start(languageRef.current, route),
    switchDepartment: (route: LiveRoute) => client.current?.switchDepartment(route),
    stop: () => client.current?.stop(),
    toggleMuted: () => client.current?.setMuted(!client.current.getSnapshot().muted),
    playAudio: () => client.current?.playAudio(),
    refreshStatus: () => client.current?.refreshStatus(),
  }
}
