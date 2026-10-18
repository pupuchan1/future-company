import type { ConversationState } from './conversation.ts'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { SILENT_SIGNAL, VoiceActivityStore } from './activity.ts'
import type { AudioSignal, VoiceActivitySource } from './activity.ts'
import { OfficialOrbView } from './OfficialOrbView.tsx'
import { animateOrb } from './orb-renderer.ts'
import './voice-orb.css'

const idleSource = new VoiceActivityStore()
export interface VoiceOrbProps {
  conversation?: ConversationState
  activity?: VoiceActivitySource
  phase?: string
  language?: 'ja' | 'en'
  muted?: boolean
  playbackBlocked?: boolean
  floating?: boolean
}

function OrbArt({ input, output, waiting }: { input: AudioSignal; output: AudioSignal; waiting: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const signals = useRef({ input, output })
  useEffect(() => { signals.current = { input, output } }, [input, output])
  useEffect(() => {
    if (canvas.current) return animateOrb(canvas.current, () => signals.current)
  }, [])
  return <div className="voice-orb-art" data-waiting={waiting} data-input={input.active} data-output={output.active} aria-hidden="true">
    <OfficialOrbView input={input} output={output} />
    <canvas ref={canvas} className="voice-orb-canvas" />
  </div>
}

export function VoiceOrb({ activity = idleSource, conversation, phase = 'idle', language = 'ja', muted = false, playbackBlocked = false, floating = true }: VoiceOrbProps) {
  const audio = useSyncExternalStore(activity.subscribe, activity.getSnapshot, activity.getSnapshot)
  const host = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(true)
  const text = (ja: string, en: string) => language === 'ja' ? ja : en
  const running = ['connecting', 'connected', 'reconnecting'].includes(phase)
  const input = running && !muted && audio.available ? audio.input : SILENT_SIGNAL
  const output = running && !playbackBlocked && audio.available ? audio.output : SILENT_SIGNAL
  const turn = conversation ?? (input.active && output.active ? 'both' : output.active ? 'assistant' : input.active ? 'user' : 'listening')
  const waiting = phase === 'connected' && turn === 'waiting' && !playbackBlocked
  const status = phase === 'switching' ? text('担当に引き継ぎ中', 'Switching assistant')
    : phase === 'stopping' ? text('会話を終了中', 'Ending conversation')
    : phase === 'ended' ? text('会話を終了しました', 'Conversation ended')
    : phase === 'error' ? text('接続を確認してください', 'Check the connection')
    : phase === 'connecting' ? text('接続しています', 'Connecting')
    : phase === 'reconnecting' ? text('再接続しています', 'Reconnecting')
    : !running ? text('AI受付 · 待機中', 'AI reception · Ready')
    : playbackBlocked ? text('AI音声の再生待ち', 'AI audio paused')
    : turn === 'both' ? text('あなたの声とAI音声', 'Your voice & AI audio')
    : turn === 'assistant' ? text('AIが話しています', 'AI is speaking')
    : turn === 'user' && !muted ? text('あなたの声を入力中', 'Receiving your voice')
    : waiting ? text('回答を待っています', 'Waiting for a response')
    : muted ? text('マイクはオフ', 'Microphone off')
    : !audio.available ? text('音量表示を利用できません', 'Audio meter unavailable')
    : text('声を待っています', 'Waiting for speech')

  useEffect(() => {
    if (!floating || !host.current || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [floating])

  return <>
    <div className="voice-orb-stage" data-conversation={turn} ref={host} aria-label={text('音声の入出力', 'Voice input and output')}>
      <OrbArt input={input} output={output} waiting={waiting} />
      <p className="voice-orb-status" role="status">{status}</p>
    </div>
    {floating && <button type="button" className="voice-orb-dock" hidden={visible} aria-label={`${text('音声受付へ戻る', 'Return to voice reception')} · ${status}`} onClick={() => host.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })}>
      <OrbArt input={input} output={output} waiting={waiting} />
    </button>}
  </>
}
