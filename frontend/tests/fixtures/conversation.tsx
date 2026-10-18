// Development-only fixture: no microphone, network connection, or real conversation.
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ReceptionPageView } from '../../src/pages/ReceptionPage'
import { initialSnapshot } from '../../src/features/live/types'
import { LiveEventReducer } from '../../src/features/live/events'
import { VoiceActivityStore } from '../../src/features/voice/activity'
import type { LiveLanguage, LiveLanguagePreference, LiveSnapshot } from '../../src/features/live/types'
import '../../src/styles/global.css'

function ready() { return { ...initialSnapshot('fixture-case', 'ja'), configured: true, mcpConfigured: true } }
export function Fixture() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>(ready)
  const [preference, setPreference] = useState<LiveLanguagePreference>('ja')
  const language: LiveLanguage = preference === 'en' ? 'en' : 'ja'
  const [voice] = useState(() => new VoiceActivityStore())
  const reducer = useRef(new LiveEventReducer())
  const [counts, setCounts] = useState({ starts: 0, stops: 0 })
  const utterance = useRef(0)
  function appendConversation() {
    const id = ++utterance.current
    setSnapshot(value => {
      let next = reducer.current.apply(value, { type: 'session.input_transcript.completed', item_id: `user-${id}`, transcript: `仕事の依頼について相談したいです。 ${id}`, role: 'user' }, 'datachannel')
      next = reducer.current.apply(next, { type: 'session.output_transcript.delta', item_id: `ai-${id}`, delta: 'どのようなお仕事を', role: 'assistant' }, 'datachannel')
      return next
    })
  }
  return <>
    <div style={{ padding: 10, borderBottom: '1px solid #111', display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 12 }} aria-label="UI test controls">
      <strong>表示検証用・テストデータ（音声接続なし）</strong>
      <button onClick={() => setSnapshot(value => ({ ...value, phase: 'connected' }))}>接続成功</button>
      <button onClick={() => setSnapshot(value => ({ ...value, phase: 'error', error: '接続失敗テスト' }))}>接続失敗</button>
      <button onClick={appendConversation}>発言を受信</button>
      <button onClick={() => setSnapshot(value => reducer.current.apply(value, { type: 'session.output_transcript.completed', item_id: `ai-${utterance.current}`, transcript: 'どのようなお仕事をご希望ですか？必要に応じて担当者に確認します。', role: 'assistant' }, 'datachannel'))}>回答を確定</button>
      <output aria-label="Connection counts">開始 {counts.starts} / 終了 {counts.stops}</output>
    </div>
    <ReceptionPageView language={language} preference={preference} selectLanguage={setPreference} live={{
      snapshot, voice, preparing: false, caseId: 'fixture-case',
      worker: { phase: 'ready', case: { id: 'fixture-case', revision: 0, kind: 'haas', locale: language }, error: '' },
      start: async () => { setCounts(value => ({ ...value, starts: value.starts + 1 })); setSnapshot(value => ({ ...value, phase: 'connecting', transcripts: [], error: '' })) },
      stop: async () => { setCounts(value => ({ ...value, stops: value.stops + 1 })); setSnapshot(value => ({ ...value, phase: 'ended' })) },
      resetCase: async () => { reducer.current.reset(); setSnapshot(ready()) },
      toggleMuted: () => setSnapshot(value => ({ ...value, muted: !value.muted })),
      retryLanguage: async () => {}, switchDepartment: async () => {}, playAudio: async () => {}, refreshStatus: async () => {},
    }} />
  </>
}

createRoot(document.getElementById('root')!).render(<Fixture />)
