import type { CSSProperties } from 'react'
import type { LiveSnapshot } from './types'
import './audio-orb.css'

type AudioOrbProps = Pick<LiveSnapshot, 'inputLevel' | 'outputLevel' | 'inputWaveform' | 'speaking' | 'meteringAvailable' | 'phase'> & {
  language: 'ja' | 'en'
  compact?: boolean
}
const gain = (value: number) => Math.min(1, Math.sqrt(Math.max(0, value)) * 3)

export function AudioOrb({ inputLevel, outputLevel, inputWaveform, speaking, meteringAvailable, phase, language, compact = false }: AudioOrbProps) {
  const user = meteringAvailable && (speaking === 'user' || speaking === 'both')
  const assistant = meteringAvailable && (speaking === 'assistant' || speaking === 'both')
  const output = assistant ? gain(outputLevel) : 0
  const scale = 1 + Math.max(user ? gain(inputLevel) : 0, output) * 0.07
  const wave = user && inputWaveform.length > 1 ? inputWaveform.map((sample, index) => {
    const angle = index / inputWaveform.length * Math.PI * 2 - Math.PI / 2
    const radius = 64 + Math.max(-1, Math.min(1, sample * 3)) * 21
    return `${index ? 'L' : 'M'}${(100 + Math.cos(angle) * radius).toFixed(2)},${(100 + Math.sin(angle) * radius).toFixed(2)}`
  }).join(' ') + ' Z' : ''
  const idle = phase === 'idle' || phase === 'ended' || phase === 'error'
  const label = language === 'ja'
    ? assistant && user ? 'あなたとAIの音声を検出' : assistant ? 'AIの音声を再生中' : user ? 'あなたの音声を検出' : '音声は検出されていません'
    : assistant && user ? 'You and the AI are speaking' : assistant ? 'AI audio is playing' : user ? 'Your audio is detected' : 'No audio detected'
  return <figure className={`audio-orb${compact ? ' audio-orb--compact' : ''}${idle ? ' audio-orb--idle' : ''}`}>
    <div className="audio-orb-visual" role="img" aria-label={label}>
      <div className="audio-orb-core" style={{ '--orb-scale': scale } as CSSProperties} />
      <svg viewBox="0 0 200 200" aria-hidden="true">
        <circle className="audio-orb-guide" cx="100" cy="100" r="64" />
        <circle className="audio-orb-output audio-orb-output--outer" cx="100" cy="100" r={66 + output * 27} style={{ opacity: output * 0.45 }} />
        <circle className="audio-orb-output" cx="100" cy="100" r={61 + output * 21} style={{ opacity: output * 0.95, strokeWidth: 1 + output * 2 }} />
        {wave && <path className="audio-orb-input" d={wave} />}
      </svg>
    </div>
    {!compact && <figcaption className="audio-orb-legend">
      <span className={user ? 'is-speaking' : ''}><i />{language === 'ja' ? 'あなたの声' : 'Your voice'}</span>
      <span className={assistant ? 'is-speaking' : ''}><i />{language === 'ja' ? 'AIの声' : 'AI voice'}</span>
    </figcaption>}
  </figure>
}
