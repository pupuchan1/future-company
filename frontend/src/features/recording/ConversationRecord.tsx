import { ConversationTranscript } from '../../components/ConversationTranscript'
import type { LiveLanguage, LivePhase, LiveTranscript } from '../live/types.ts'
import type { RecordingSnapshot } from './types.ts'
import { transcriptText } from './transcript.ts'

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

export function ConversationRecord({ entries, recording, language, phase }: {
  entries: LiveTranscript[]
  recording: RecordingSnapshot
  language: LiveLanguage
  phase: LivePhase
}) {
  const text = (ja: string, en: string) => language === 'ja' ? ja : en
  function downloadText() {
    const url = URL.createObjectURL(new Blob([transcriptText(entries, language)], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = (recording.filename || `conversation-${Date.now()}.mp3`).replace(/\.mp3$/, '.txt')
    document.body.append(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <ConversationTranscript language={language} phase={phase} messages={entries}>
    <div className="conversation-record-actions">
      {entries.length > 0 && <button type="button" className="text-button" onClick={downloadText}>{text('文字起こしを保存', 'Save transcript')} ↓</button>}
    </div>
    <div className="conversation-record-audio">
      <p className="small" role="status">
        {recording.phase === 'recording' ? <><span className="recording-dot" aria-hidden="true" />{text('音声を記録中', 'Recording audio')} · {duration(recording.seconds)}</>
          : recording.phase === 'preparing' ? text('音声の記録を準備しています', 'Preparing the audio recording')
          : recording.phase === 'encoding' ? text('MP3を仕上げています…', 'Finishing your MP3…')
          : recording.phase === 'ready' ? `${text('会話音声', 'Conversation audio')} · ${duration(recording.seconds)}`
          : recording.phase === 'unavailable' ? text('このブラウザーは音声の保存に対応していません。文字起こしは保存できます。', 'Audio saving is unavailable in this browser. You can still save the transcript.')
          : recording.phase === 'error' ? text('音声ファイルを作成できませんでした。文字起こしは保存できます。', 'The audio file could not be created. You can still save the transcript.')
          : text('会話終了後に、音声をMP3で保存できます。', 'Save your conversation as an MP3 when it ends.')}
      </p>
      {recording.url && <>
        <audio controls preload="metadata" src={recording.url} aria-label={text('記録した会話音声', 'Recorded conversation audio')} />
        <a className="button secondary" href={recording.url} download={recording.filename}>{text('MP3を保存', 'Download MP3')} ↓</a>
        <p className="small">{text('この端末内の記録です。ページを閉じる前に保存してください。', 'This recording stays on this device. Save it before closing the page.')}</p>
      </>}
    </div>
  </ConversationTranscript>
}
