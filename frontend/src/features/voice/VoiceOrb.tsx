import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SILENT_SIGNAL, VoiceActivityStore } from './activity.ts'
import type { AudioSignal, VoiceActivitySource } from './activity.ts'
import { OfficialOrbView } from './OfficialOrbView.tsx'
import { animateOrb } from './orb-renderer.ts'
import './voice-orb.css'

const idleSource = new VoiceActivityStore()
export interface VoiceOrbProps {
  activity?: VoiceActivitySource
  phase?: string
  language?: 'ja' | 'en'
  muted?: boolean
  playbackBlocked?: boolean
  floating?: boolean
  onOpenConversation?: () => void
}

function OrbArt({ input, output }: { input: AudioSignal; output: AudioSignal }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const signals = useRef({ input, output })
  useEffect(() => { signals.current = { input, output } }, [input, output])
  useEffect(() => {
    if (canvas.current) return animateOrb(canvas.current, () => signals.current)
  }, [])
  return <div className="voice-orb-art" data-input={input.active} data-output={output.active} aria-hidden="true">
    <OfficialOrbView input={input} output={output} />
    <canvas ref={canvas} className="voice-orb-canvas" />
  </div>
}

export function VoiceOrb({ activity = idleSource, phase = 'idle', language = 'ja', muted = false, playbackBlocked = false, floating = true, onOpenConversation }: VoiceOrbProps) {
  const audio = useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot)
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const text = (ja: string, en: string) => language === 'ja' ? ja : en
  const running = ['connecting', 'connected', 'reconnecting'].includes(phase)
  const input = running && !muted && audio.available ? audio.input : SILENT_SIGNAL
  const output = running && !playbackBlocked && audio.available ? audio.output : SILENT_SIGNAL
  const status = input.active && output.active ? text('あなたの声とAI音声', 'Your voice & AI audio')
    : output.active ? text('AIが話しています', 'AI is speaking')
      : input.active ? text('あなたの声を入力中', 'Receiving your voice')
        : playbackBlocked ? text('AI音声の再生待ち', 'AI audio paused')
          : muted ? text('マイクはオフ', 'Microphone off')
            : phase === 'switching' ? text('担当に引き継ぎ中', 'Switching assistant')
              : phase === 'stopping' ? text('会話を終了中', 'Ending conversation')
                : phase === 'ended' ? text('会話を終了しました', 'Conversation ended')
                  : phase === 'error' ? text('接続を確認してください', 'Check the connection')
            : phase === 'connecting' ? text('接続しています', 'Connecting')
              : running && !audio.available ? text('音量表示を利用できません', 'Audio meter unavailable')
                : running ? text('声を待っています', 'Waiting for speech') : text('ご相談をお待ちしています', 'Ready when you are')

  useEffect(() => {
    if (!floating || !host.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [floating])

  return <>
    <div className="voice-orb-stage" ref={host} aria-label={text('音声の入出力', 'Voice input and output')}>
      <OrbArt input={input} output={output} />
      <p className="voice-orb-status" role="status">{status}</p>
    </div>
    {floating && <button type="button" className="voice-orb-dock" hidden={visible} aria-label={`${text('会話画面を開く', 'Open conversation')} · ${status}`} onClick={onOpenConversation ?? (() => window.location.assign('/conversation'))}>
      <OrbArt input={input} output={output} />
    </button>}
  </>
}
