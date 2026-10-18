import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { radialWavePath, SILENT_SIGNAL, VoiceActivityStore } from './activity.ts'
import type { AudioSignal, VoiceActivitySource } from './activity.ts'
import './voice-orb.css'

const idleSource = new VoiceActivityStore()
export interface VoiceOrbProps {
  activity?: VoiceActivitySource
  phase?: string
  language?: 'ja' | 'en'
  muted?: boolean
  playbackBlocked?: boolean
  floating?: boolean
}

function OrbArt({ input, output }: { input: AudioSignal; output: AudioSignal }) {
  const id = useId().replaceAll(':', '')
  const style = { '--orb-output': output.level, '--orb-input': input.level } as CSSProperties
  return <div className="voice-orb-art" style={style} data-input={input.active} data-output={output.active} aria-hidden="true">
    <div className="voice-orb-core"><i /><b /><span /></div>
    <svg viewBox="0 0 256 256" focusable="false">
      <defs><linearGradient id={`voice-wave-${id}`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#1447e6" /><stop offset="1" stopColor="#1447e6" stopOpacity=".4" /></linearGradient></defs>
      <circle className="voice-orb-orbit" cx="128" cy="128" r="88" />
      <path className="voice-orb-user-wave" d={radialWavePath(input.waveform, input.level)} stroke={`url(#voice-wave-${id})`} />
      <circle className="voice-orb-user-static" cx="128" cy="128" r="91" />
      <g className="voice-orb-output-rings">{[0, 1, 2].map(index => <circle key={index} cx="128" cy="128" r="96" style={{ animationDelay: `${index * -0.6}s` }} />)}</g>
    </svg>
  </div>
}

export function VoiceOrb({ activity = idleSource, phase = 'idle', language = 'ja', muted = false, playbackBlocked = false, floating = true }: VoiceOrbProps) {
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
                : running ? text('声を待っています', 'Waiting for speech') : text('AI受付 · 待機中', 'AI reception · Ready')

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
    {floating && <button type="button" className="voice-orb-dock" hidden={visible} aria-label={`${text('音声受付へ戻る', 'Return to voice reception')} · ${status}`} onClick={() => host.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })}>
      <OrbArt input={input} output={output} />
    </button>}
  </>
}
