import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { VoiceOrb } from './VoiceOrb.tsx'
import { VoiceActivityStore } from './activity.ts'
import { createAudioMeter } from '../live/client.ts'
import type { LiveAudioMeter } from '../live/client.ts'
import { SILENT_SIGNAL } from './activity.ts'
import '../../styles/global.css'

type Mode = 'input' | 'output' | 'both' | 'silence' | 'muted' | 'blocked' | 'stopped'
export function Preview() {
  const [store] = useState(() => new VoiceActivityStore())
  const [mode, setMode] = useState<Mode>('stopped')
  const graph = useRef<{ monitor: LiveAudioMeter; input: GainNode; output: GainNode; sources: OscillatorNode[]; tracks: MediaStreamTrack[]; microphone: MediaStreamTrack; audible: boolean } | null>(null)
  const stop = useCallback(() => {
    graph.current?.monitor.dispose()
    store.reset()
    graph.current?.sources.forEach(source => source.stop())
    graph.current?.tracks.forEach(track => track.stop())
    graph.current = null
  }, [store])
  useEffect(() => { window.addEventListener('pagehide', stop); return () => { window.removeEventListener('pagehide', stop); stop() } }, [stop])
  function change(next: Mode) {
    setMode(next)
    if (next === 'stopped') { stop(); return }
    if (!graph.current) {
      const context = new AudioContext()
      const input = context.createGain(); const output = context.createGain()
      const inputStream = context.createMediaStreamDestination(); const outputStream = context.createMediaStreamDestination()
      input.connect(inputStream); output.connect(outputStream)
      const sources = [context.createOscillator(), context.createOscillator()]
      sources[0].frequency.value = 220; sources[1].frequency.value = 330
      sources[0].connect(input); sources[1].connect(output); sources.forEach(source => source.start())
      const monitor = createAudioMeter(() => {}, () => context, activity => {
        store.publish({ ...activity, output: graph.current?.audible ? activity.output : SILENT_SIGNAL })
      })!
      const current = { monitor, input, output, sources, tracks: [...inputStream.stream.getTracks(), ...outputStream.stream.getTracks()], microphone: inputStream.stream.getAudioTracks()[0], audible: false }
      graph.current = current
      monitor.setInput(inputStream.stream)
      monitor.setOutput(outputStream.stream)
      // Neither source connects to speakers: this development fixture is silent.
    }
    const current = graph.current
    current.input.gain.value = ['input', 'both', 'muted', 'blocked'].includes(next) ? 0.14 : 0
    current.output.gain.value = ['output', 'both', 'muted', 'blocked'].includes(next) ? 0.14 : 0
    current.audible = next !== 'blocked'
    current.microphone.enabled = next !== 'muted'
  }
  const names: [Mode, string][] = [['input', 'ユーザー入力'], ['output', 'AI出力'], ['both', '同時発話'], ['silence', '無音'], ['muted', 'マイクOFF・AI出力'], ['blocked', 'AI再生ブロック'], ['stopped', '終了']]
  return <main className="page-width" style={{ paddingTop: 36, paddingBottom: 80 }}>
    <p className="eyebrow">VOICE EFFECTS / DEVELOPMENT TEST</p><h1 style={{ fontSize: '2rem' }}>音声の入力と出力を、見分ける。</h1>
    <p>合成した音声信号を実際の解析処理へ渡す表示テストです。マイク・AI APIは使用せず、スピーカーからも音を出しません。AIの再生可否はこの画面で模擬します。</p>
    <div className="row" style={{ flexWrap: 'wrap', marginTop: 24 }}>{names.map(([value, label]) => <button className={`button ${mode === value ? 'primary' : 'secondary'}`} key={value} aria-pressed={mode === value} onClick={() => change(value)}>{label}</button>)}</div>
    <VoiceOrb activity={store} phase={mode === 'stopped' ? 'ended' : 'connected'} muted={mode === 'muted'} playbackBlocked={mode === 'blocked'} />
    <section style={{ minHeight: 700, paddingTop: 80 }}><h2>スクロールして常駐表示を確認</h2><p>大きなオーブが画面外になると、右下に同じ入出力の状態が残ります。右下の受付を押すと元の位置へ戻ります。</p></section>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
