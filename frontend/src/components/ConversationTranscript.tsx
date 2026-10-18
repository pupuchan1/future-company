import { useEffect, useRef, useState } from 'react'
import type { LiveLanguage, LivePhase, LiveTranscript } from '@/features/live/types'

type Props = { language: LiveLanguage; phase: LivePhase; messages: LiveTranscript[] }

export function ConversationTranscript({ language, phase, messages }: Props) {
  const text = (ja: string, en: string) => language === 'ja' ? ja : en
  const log = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [messages])

  function scrollToLatest() {
    follow.current = true
    setFollowing(true)
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }

  return (
    <section className="panel reception-transcript conversation-transcript" aria-labelledby="conversation-title">
      <div className="conversation-transcript-heading">
        <p className="eyebrow">{text('AI総合受付', 'AI RECEPTION')}</p>
        <h1 id="conversation-title" tabIndex={-1}>{text('会話履歴', 'Conversation')}</h1>
        <p>{phase === 'ended'
          ? text('会話は終了しました。内容を読み返せます。', 'The conversation has ended. You can still read it here.')
          : text('あなたの言葉と、AIの回答。', 'Your words and the AI’s replies.')}</p>
      </div>
      <div
        ref={log}
        className="transcript"
        role="log"
        tabIndex={0}
        aria-live="polite"
        aria-relevant="additions text"
        aria-label={text('会話の文字起こし', 'Conversation transcript')}
        onScroll={() => {
          if (!log.current) return
          const { scrollHeight, scrollTop, clientHeight } = log.current
          const atBottom = scrollHeight - scrollTop - clientHeight < 48
          follow.current = atBottom
          setFollowing(atBottom)
        }}
      >
        {messages.length ? messages.map(message => (
          <article key={message.id} className={`message message-${message.role}`}>
            <div className="message-label">
              {message.role === 'user' ? text('あなた', 'You') : message.role === 'system' ? text('お知らせ', 'Notice') : 'AI'}
              {!message.final && <span>{message.role === 'user' ? text('聞き取り中', 'Transcribing') : text('回答中', 'Responding')}</span>}
            </div>
            <p>{message.text}</p>
          </article>
        )) : <div className="conversation-empty"><p>{text('会話を始めると、ここに内容が表示されます。', 'Your conversation will appear here once you start.')}</p></div>}
      </div>
      {!following && <button type="button" className="text-button conversation-latest" onClick={scrollToLatest}>
        {text('最新の会話へ', 'Go to latest')} ↓
      </button>}
    </section>
  )
}
