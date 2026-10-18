import { VoiceOrb } from '../voice/VoiceOrb.tsx'
import { useEffect } from 'react'
import { useLiveConnection } from './useLiveConnection.ts'
import type { LiveLanguage, LivePhase, LiveSnapshot } from './types.ts'

export type { LiveSnapshot } from './types.ts'

export interface LiveConnectionPanelProps {
  caseId: string
  language: LiveLanguage
  onSnapshot?: (snapshot: LiveSnapshot) => void
}

const phases: Record<LivePhase, [string, string]> = {
  idle: ['待機中', 'Ready'], connecting: ['接続中', 'Connecting'], connected: ['会話中', 'Connected'],
  reconnecting: ['再接続待ち', 'Reconnecting'], switching: ['担当に引き継ぎ中', 'Switching department'], stopping: ['音声を終了中', 'Stopping voice'], ended: ['音声終了', 'Voice ended'], error: ['接続エラー', 'Connection error'],
}
const requestLabels: Record<string, [string, string]> = {
  requested: ['依頼作成', 'Requested'], ringing: ['リング応答あり', 'Ring acknowledged'],
  accepted: ['受話器の応答あり', 'Handset accepted'], completed: ['対応終了', 'Handling ended'],
  unavailable: ['対応不可', 'Unavailable'], cancelled: ['取消済み', 'Cancelled'],
}

/** Uses existing FE utility classes; no edits to App.tsx or global.css. */
export function LiveConnectionPanel({ caseId, language, onSnapshot }: LiveConnectionPanelProps) {
  const live = useLiveConnection({ caseId, language })
  const s = live.snapshot
  const en = language === 'en'
  const text = (ja: string, english: string) => en ? english : ja
  const active = ['connecting', 'connected', 'reconnecting', 'switching'].includes(s.phase)
  const stopping = s.phase === 'stopping'
  useEffect(() => { onSnapshot?.(s) }, [s, onSnapshot])
  return <section className="panel" aria-label={text('AI音声接続', 'AI voice connection')}>
    <h2 className="panel-heading">{text('AI音声接続', 'AI voice connection')}</h2>
    <div className="task-body">
      <VoiceOrb activity={live.voice} conversation={s.conversation} phase={s.phase} language={language} muted={s.muted} playbackBlocked={s.playbackBlocked} />
      <div className="row spread"><strong>{phases[s.phase][en ? 1 : 0]}</strong><span className="tag">{text('サーバー接続モード', 'Server connection mode')}</span></div>
      <p className="small">{text('音声はAIに送信されます。開始するとマイクを使います。言語と担当は会話から自動判定します。', 'Audio is sent to the AI. Starting uses your microphone. Language and department are detected from the conversation.')}</p>
      <p role="status">{s.configured === null
        ? text('音声サーバーの状態を取得できません。接続先を確認してください。', 'Voice server status is unavailable. Check the connection.')
        : !s.configured || !s.mcpConfigured
          ? text('音声サーバーの設定待ちです。', 'Waiting for voice server configuration.')
          : text('音声サーバーの設定あり。開始ボタンで接続できます。', 'Voice server configured. Press Start to connect.')}</p>
      <div className="row">
        <button type="button" className="button primary" disabled={active || stopping || !s.configured || !s.mcpConfigured} onClick={() => void live.start()}>{text('AI音声を開始', 'Start AI voice')}</button>
        <button type="button" className="button secondary" disabled={!active} onClick={() => void live.stop()}>{text('音声を停止', 'Stop voice')}</button>
      </div>
      {active && <button type="button" className="text-button" aria-pressed={s.muted} onClick={live.toggleMuted}>{s.muted ? text('マイクをオン', 'Unmute microphone') : text('マイクをミュート', 'Mute microphone')}</button>}
      {!active && <button type="button" className="text-button" onClick={() => void live.refreshStatus()}>{text('接続状態を再確認', 'Refresh connection status')}</button>}
      {s.playbackBlocked && <div role="status"><p>{text('ブラウザが音声再生を止めています。', 'Your browser has blocked audio playback.')}</p><button type="button" className="button secondary" onClick={() => void live.playAudio()}>{text('AI音声を再生', 'Play AI audio')}</button></div>}
      {s.error && <p role="alert">{s.error}</p>}
      {s.cleanupWarning && <p role="alert">{s.cleanupWarning}</p>}
      <dl className="facts">
        <dt>{text('担当', 'Department')}</dt><dd>{s.route === 'recruiting' ? text('採用担当AI', 'Recruiting AI') : s.route === 'haas' ? text('作業担当AI', 'Work AI') : text('受付AI', 'Reception AI')}</dd>
        <dt>{text('会話言語', 'Conversation language')}</dt><dd>{s.language === 'en' ? 'English' : '日本語'}</dd>
        <dt>{text('イベント接続', 'Events')}</dt><dd>{s.events === 'connected' ? text('受信中', 'Connected') : s.events === 'reconnecting' ? text('再接続待ち', 'Reconnecting') : text('接続待ち', 'Waiting')}</dd>
      </dl>
      <p className="small">{text('この接続は音声専用です。文字のデモ送信やローカル担当者画面の操作は、音声サーバーへ送信されません。', 'This connection supports voice. Demo text messages and local team workspace actions are not sent to the voice server.')}</p>
      {s.transcripts.length > 0 && <section aria-label={text('実接続の文字起こし', 'Live transcript')}><h3>{text('音声の会話', 'Voice conversation')}</h3>{s.transcripts.map(item => <p key={item.id}><strong>{item.role === 'user' ? text('あなた', 'You') : item.role === 'system' ? text('システム', 'System') : 'AI'}: </strong>{item.text}</p>)}</section>}
      {s.backend !== 'idle' && <section><h3>{text('担当の処理', 'Department processing')}</h3><p>{s.backend === 'running' ? text('処理中', 'Working') : s.backend === 'error' ? text('処理エラー', 'Processing error') : text('処理結果を受信', 'Result received')}</p>{s.backendResult && <p>{s.backendResult}</p>}</section>}
      {s.requests.length > 0 && <section aria-label={text('サーバーの人間依頼', 'Server human requests')}><h3>{text('担当者への依頼', 'Requests to the team')}</h3>{s.requests.map(request => <article key={request.handoffId}>
        <p><strong>{requestLabels[request.status]?.[en ? 1 : 0] ?? request.status}</strong> · {request.simulated === true ? text('模擬デバイス', 'Simulated device') : request.simulated === false ? text('実機として報告', 'Reported as physical device') : text('デバイス種別未確認', 'Device type unconfirmed')}</p>
        <p>{request.summary}</p>
        {(request.targetRole || request.task || request.expectedResult) && <dl className="facts">
          {request.targetRole && <><dt>{text('依頼先', 'Requested role')}</dt><dd>{request.targetRole}</dd></>}
          {request.task && <><dt>{text('依頼内容', 'Task')}</dt><dd>{request.task}</dd></>}
          {request.expectedResult && <><dt>{text('必要な回答', 'Expected result')}</dt><dd>{request.expectedResult}</dd></>}
        </dl>}
        {request.status === 'accepted' && <p className="small">{text('受話器の応答です。人間との音声通話がつながったことは意味しません。', 'The handset responded. This does not confirm a human audio connection.')}</p>}
        {request.unavailableReason && <p>{text('対応できなかった理由', 'Unavailable reason')}: {request.unavailableReason}</p>}
        {request.result ? <div className="answer"><strong>{request.simulated ? text('架空の模擬回答（原文）', 'Fictional simulated reply (original)') : text('担当者の回答（原文）', 'Team reply (original)')}</strong><p>{request.result.text}</p></div> : request.status === 'completed' && <p className="small">{text('対応終了を確認しました。回答本文はまだ届いていません。', 'Handling ended. No answer text has arrived.')}</p>}
      </article>)}</section>}
    </div>
  </section>
}
