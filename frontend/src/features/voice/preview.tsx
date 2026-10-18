import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceOrb } from './VoiceOrb.tsx'
import { VoiceActivityStore } from './activity.ts'
import { createAudioMeter } from '../live/client.ts'
import type { LiveAudioMeter } from '../live/client.ts'
import { SILENT_SIGNAL } from './activity.ts'
import '../../styles/global.css'

type Mode = 'microphone' | 'input' | 'output' | 'both' | 'silence' | 'muted' | 'blocked' | 'stopped'
export function Preview() {
  const [store] = useState(() => new VoiceActivityStore())
  const [volume, setVolume] = useState(.14)
  const [error, setError] = useState('')
  const request = useRef(0)
  const [mode, setMode] = useState<Mode>('stopped')
  const graph = useRef<{ monitor: LiveAudioMeter; input: GainNode; output: GainNode; sources: OscillatorNode[]; tracks: MediaStreamTrack[]; microphone: MediaStreamTrack; testInput: MediaStream; capture?: MediaStream; audible: boolean } | null>(null)
  const stop = useCallback(() => {
    request.current++
    graph.current?.capture?.getTracks().forEach(track => track.stop())
    graph.current?.monitor.dispose()
    store.reset()
    graph.current?.sources.forEach(source => source.stop())
    graph.current?.tracks.forEach(track => track.stop())
    graph.current = null
  }, [store])
  useEffect(() => { window.addEventListener('pagehide', stop); return () => { window.removeEventListener('pagehide', stop); stop() } }, [stop])
  async function change(next: Mode) {
    const operation = ++request.current
    setError('')
    setMode(next)
    if (next === 'stopped') { stop(); return }
    if (!graph.current) {
      const context = new AudioContext()
      const input = context.createGain(); const output = context.createGain()
      const inputStream = context.createMediaStreamDestination(); const outputStream = context.createMediaStreamDestination()
      const inputEnvelope = context.createGain(); const outputEnvelope = context.createGain()
      input.connect(inputEnvelope); inputEnvelope.connect(inputStream)
      output.connect(outputEnvelope); outputEnvelope.connect(outputStream)
      // Real PCM with syllable-like level changes, rather than a constant-volume demo.
      const modulation = [context.createOscillator(), context.createOscillator()]
      modulation[0].frequency.value = 2; modulation[1].frequency.value = 1.4
      for (let i = 0; i < modulation.length; i++) {
        const depth = context.createGain(); depth.gain.value = .4
        const envelope = i === 0 ? inputEnvelope : outputEnvelope
        envelope.gain.value = .6
        modulation[i].connect(depth); depth.connect(envelope.gain)
      }
      const sources = [context.createOscillator(), context.createOscillator()]
      sources[0].frequency.value = 220; sources[1].frequency.value = 330
      sources[0].connect(input); sources[1].connect(output); sources.push(...modulation); sources.forEach(source => source.start())
      const monitor = createAudioMeter(() => {}, () => context, activity => {
        store.publish({ ...activity, output: graph.current?.audible ? activity.output : SILENT_SIGNAL })
      })!
      const current = { monitor, input, output, sources, tracks: [...inputStream.stream.getTracks(), ...outputStream.stream.getTracks()], microphone: inputStream.stream.getAudioTracks()[0], testInput: inputStream.stream, audible: false }
      graph.current = current
      monitor.setInput(inputStream.stream)
      monitor.setOutput(outputStream.stream)
      // Neither source connects to speakers: this development fixture is silent.
    }
    const current = graph.current
    current.capture?.getTracks().forEach(track => track.stop())
    current.capture = undefined
    current.monitor.setInput(current.testInput)
    current.input.gain.value = ['input', 'both', 'muted', 'blocked'].includes(next) ? volume : 0
    current.output.gain.value = ['output', 'both', 'muted', 'blocked'].includes(next) ? volume : 0
    current.audible = next !== 'blocked'
    current.microphone.enabled = next !== 'muted'
    if (next === 'microphone') {
      try {
        const capture = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false })
        if (request.current !== operation || graph.current !== current) { capture.getTracks().forEach(track => track.stop()); return }
        current.capture = capture
        current.monitor.setInput(capture)
      } catch {
        if (request.current === operation) { setError('マイクを利用できませんでした。ブラウザのマイク許可を確認してください。'); setMode('silence') }
      }
    }
  }
  const names: [Mode, string][] = [['microphone', '自分のマイクで試す'], ['input', 'ユーザー入力'], ['output', 'AI出力'], ['both', '同時発話'], ['silence', '無音'], ['muted', 'マイクOFF・AI出力'], ['blocked', 'AI再生ブロック'], ['stopped', '終了']]
  return <main className="page-width" style={{ paddingTop: 36, paddingBottom: 80 }}>
    <p className="eyebrow">VOICE EFFECTS / DEVELOPMENT TEST</p><h1 style={{ fontSize: '2rem' }}>音声の入力と出力を、見分ける。</h1>
    <p>マイクまたは合成音声の実音量でオーブが変化します。音声は端末内で解析し、AIへの送信・録音の保存・スピーカー再生は行いません。</p>
    <div className="row" style={{ flexWrap: 'wrap', marginTop: 24 }}>{names.map(([value, label]) => <button className={`button ${mode === value ? 'primary' : 'secondary'}`} key={value} aria-pressed={mode === value} onClick={() => void change(value)}>{label}</button>)}</div>
    {mode !== 'microphone' && <label style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 24, maxWidth: 360 }}>テスト音量<input aria-label="テスト音量" type="range" min="0" max=".25" step=".005" value={volume} onChange={event => {
      const value = Number(event.target.value)
      setVolume(value)
      if (graph.current) {
        graph.current.input.gain.value = ['input', 'both', 'muted', 'blocked'].includes(mode) ? value : 0
        graph.current.output.gain.value = ['output', 'both', 'muted', 'blocked'].includes(mode) ? value : 0
      }
    }} /></label>}
    {error && <p role="alert">{error}</p>}
    <VoiceOrb activity={store} phase={mode === 'stopped' ? 'ended' : 'connected'} muted={mode === 'muted'} playbackBlocked={mode === 'blocked'} />
    <section style={{ minHeight: '120vh', paddingTop: 80 }}><h2>スクロールして常駐表示を確認</h2><p>大きなオーブが画面外になると、右下に同じ入出力の状態が残ります。右下の丸を押すと会話画面を開きます。</p></section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
