import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useLiveConnection } from '../live/useLiveConnection.ts'
import type { LiveLanguage, LiveRoute } from '../live/types.ts'

const departments: { route: LiveRoute; number: string; ja: string; en: string; description: [string, string] }[] = [
  { route: 'reception', number: '01', ja: 'まずは、相談したい', en: 'Let’s talk', description: ['サービスのことも、小さな困りごとも。', 'A question, an idea, or a little help.'] },
  { route: 'recruiting', number: '02', ja: 'この会社で働きたい', en: 'Join our team', description: ['仕事を知る。採用AIと面接を体験する。', 'Explore opportunities. Meet our recruiting AI.'] },
  { route: 'haas', number: '03', ja: '人の力を借りたい', en: 'A human touch', description: ['判断や現場の作業を、必要な人へ。', 'Connect a real-world challenge with a person.'] },
]
function Mic({ muted = false }: { muted?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45" aria-hidden="true"><path d="M9 10V6a3 3 0 0 1 6 0v6a3 3 0 0 1-5 2.2M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />{muted ? <path d="m3 3 18 18" /> : <path d="M9 10v2a3 3 0 0 0 6 0" />}</svg>
}
function Arrow() { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6" /></svg> }

export function VoiceRoom() {
  const [caseId] = useState(() => `haas-${crypto.randomUUID()}`)
  const [language, setLanguage] = useState<LiveLanguage>('ja')
  const [showTranscript, setShowTranscript] = useState(false)
  const transcriptEnd = useRef<HTMLDivElement>(null)
  const live = useLiveConnection({ caseId, language })
  const s = live.snapshot
  const en = language === 'en'
  const t = (ja: string, english: string) => en ? english : ja
  const active = ['connected', 'reconnecting', 'switching'].includes(s.phase)
  const busy = ['connecting', 'switching', 'stopping'].includes(s.phase)
  const available = s.configured === true && s.mcpConfigured === true
  const latest = s.transcripts.at(-1)
  const request = s.requests.at(-1)
  const department = s.voiceRoute === 'recruiting' ? t('採用担当AI', 'Recruiting AI') : s.voiceRoute === 'haas' ? t('HaaS担当AI', 'HaaS AI') : t('受付AI', 'Reception AI')
  const energy = Math.min(1, Math.max(s.inputLevel, s.outputLevel) * 4)
  const status = s.phase === 'switching' ? t('会話を引き継いでいます', 'Passing your conversation along')
    : s.phase === 'connecting' ? t('声をつないでいます', 'Connecting your voice')
      : s.phase === 'stopping' ? t('会話を終了しています', 'Ending the conversation')
        : s.phase === 'reconnecting' ? t('接続を確認しています', 'Checking the connection')
          : active && s.muted ? t('マイクをお休みしています', 'Your microphone is muted')
            : active && s.speaking === 'assistant' ? t('AIがお話ししています', 'Your AI is speaking')
              : active && s.speaking === 'both' ? t('声を聞きながら、お話ししています', 'Listening and speaking')
                : active && s.speaking === 'user' ? t('お話を聞いています', 'Listening to you')
                  : active && s.backend === 'running' ? t('担当に確認しています', 'Checking with your specialist')
                    : active ? t('そのまま、お話しください', 'Go ahead. We’re listening.')
                      : !available ? t('音声相談の接続を確認中です', 'Checking voice availability')
                        : t('タップして、話しかけてください', 'Tap and say hello')
  const requestStatus = !request ? '' : request.result ? t('担当者から回答が届きました', 'Your specialist has replied')
    : request.status === 'ringing' ? t('担当者を呼び出しています', 'Calling a specialist')
      : request.status === 'accepted' ? t('受話器の応答がありました', 'The handset was picked up')
        : request.status === 'completed' ? t('対応終了・回答を確認中', 'Handling ended; checking the answer')
          : request.status === 'unavailable' ? t('現在、担当者が対応できません', 'The specialist is unavailable')
            : request.status === 'cancelled' ? t('依頼は取り消されました', 'The request was cancelled')
              : t('人への依頼を受け付けました', 'Your request has been received')
  useEffect(() => {
    if (showTranscript) transcriptEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [s.transcripts, showTranscript])
  const connect = (route: LiveRoute = 'reception') => active ? live.switchDepartment(route) : live.start(route)

  return <div className="haas-app">
    <a className="skip-link" href="#consultation">{t('音声相談へ', 'Skip to voice consultation')}</a>
    <header className="haas-header">
      <a className="brand" href="#" aria-label={t('株式会社HaaS トップ', 'HaaS home')}><span className="wordmark">HaaS<span>.</span></span><span className="brand-sub">{t('株式会社 HaaS', 'HaaS Inc.')}<small>HUMAN AS A SERVICE</small></span></a>
      <nav aria-label={t('メインナビゲーション', 'Main navigation')}><a href="#about">{t('私たちについて', 'About us')}</a><a href="#consultation">{t('AIに相談', 'Talk to AI')}</a><button className="language-switch" onClick={() => setLanguage(en ? 'ja' : 'en')}>{en ? '日本語' : 'EN'}<span aria-hidden="true"> ↗</span></button></nav>
    </header>

    <main>
      <section id="consultation" className="voice-hero" aria-labelledby="hero-title">
        <div className="hero-copy"><p className="eyebrow"><span />{t('クレーム対応から、未来の会社へ。', 'A more human future for work.')}</p>
          <h1 id="hero-title">{t('その「困った」に、', 'When you need help,')}<br /><em>{t('AIと、人の力を。', 'AI. And a human touch.')}</em></h1>
          <p className="hero-description">{t('まずはAIに、なんでも話してみてください。', 'Start with a conversation. Tell our AI what you need.')}<br />{t('人の判断や手が必要になったら、', 'When a human decision or a helping hand makes the difference,')}<br className="desktop-break" />{t('その先の担当者へつなぎます。', 'we’ll connect you with the right person.')}</p>
          <div className="journey" aria-label={t('相談の流れ', 'How it works')}><span className={s.route === 'reception' && !request ? 'current' : ''}>{t('受付AI', 'Reception')}</span><i>→</i><span className={s.route !== 'reception' && !request ? 'current' : ''}>{t('担当AI', 'Specialist AI')}</span><i>→</i><span className={request ? 'current' : ''}>{t('必要なときに、人へ', 'A person, when needed')}</span></div>
        </div>
        <div className={`voice-stage ${active ? 'is-active' : ''}`} style={{ '--voice-level': energy } as CSSProperties}>
          <div className="voice-label"><span className={active ? 'connected-dot' : 'ready-dot'} />{department}<span className="voice-language">{s.language === 'en' ? 'EN' : 'JA'}</span></div>
          <button className="orb-button" disabled={busy || (!active && !available)} aria-label={active ? s.muted ? t('マイクをオンにする', 'Unmute microphone') : t('マイクをミュートする', 'Mute microphone') : t('AIと音声相談を始める', 'Start a voice conversation with AI')} aria-pressed={active && !s.muted} onClick={() => active ? live.toggleMuted() : void connect()}>
            <span className="orb-halo" /><span className="orb-orbit orbit-one" /><span className="orb-orbit orbit-two" />
            <span className={`voice-orb ${s.muted ? 'is-muted' : ''}`}><span className="orb-swirl" /><span className="orb-ribbon ribbon-one" /><span className="orb-ribbon ribbon-two" /><span className="orb-shine" /><span className="orb-icon"><Mic muted={s.muted} /></span></span>
          </button>
          <p className="voice-status" role="status">{status}</p>
          <div className="voice-controls">{active || s.phase === 'connecting' ? <><span className="voice-hint">{t('オーブを押すとマイクを切り替え', 'Tap the orb to mute or unmute')}</span><button className="end-call" disabled={s.phase === 'stopping'} onClick={() => void live.stop()}><span />{t('終了', 'End call')}</button></> : <span className="voice-hint">{t('「すみません」のひと言から。', 'A simple “hello” is all it takes.')}</span>}</div>
        </div>
      </section>

      {(!available || s.error || s.cleanupWarning || s.playbackBlocked) && <aside className="connection-notice" aria-label={t('接続状態', 'Connection status')}>
        {!available && <><span>{t('音声相談は準備中です。接続できると開始ボタンが有効になります。', 'Voice consultation is getting ready. The start button will become available when connected.')}</span><button onClick={() => void live.refreshStatus()}>{t('再確認', 'Check again')}</button></>}
        {s.error && <p role="alert">{s.error}</p>}{s.cleanupWarning && <p role="alert">{s.cleanupWarning}</p>}
        {s.playbackBlocked && <button onClick={() => void live.playAudio()}>{t('AIの音声を再生する', 'Play AI audio')}</button>}
      </aside>}

      <section className="departments" aria-label={t('相談できること', 'What we can help with')}>
        {departments.map(d => <article key={d.route} className={`department-card ${active && s.voiceRoute === d.route ? 'selected' : ''}`}>
          <span className="department-number">{d.number}{active && s.voiceRoute === d.route && <span>{t('会話中', 'ACTIVE')}</span>}</span><strong>{en ? d.en : d.ja}</strong><span className="department-description">{d.description[en ? 1 : 0]}</span>
          {active && <button className="department-action" disabled={busy || !available || !s.switchConfigured || s.voiceRoute === d.route} aria-label={t(`${d.ja}：担当の声に切り替える`, `${d.en}: switch to this specialist’s voice`)} onClick={() => void connect(d.route)}><Arrow /></button>}
        </article>)}
      </section>

      {(active || latest || request) && <section className="conversation-strip" aria-label={t('いまの相談', 'Your conversation')}>
        <div className="conversation-current"><div className="section-caption"><span>{t('いまの会話', 'IN CONVERSATION')}</span>{s.transcripts.length > 0 && <button aria-expanded={showTranscript} onClick={() => setShowTranscript(!showTranscript)}>{showTranscript ? t('閉じる −', 'Close −') : t('会話を見る ＋', 'View conversation +')}</button>}</div>
          {showTranscript ? <div className="transcript-log" aria-label={t('会話の文字起こし', 'Conversation transcript')}>{s.transcripts.map(item => <p key={item.id}><b>{item.role === 'user' ? t('あなた', 'You') : item.role === 'assistant' ? department : t('ご案内', 'Notice')}</b>{item.text}</p>)}<div ref={transcriptEnd} /></div> : <p className="latest-transcript">{latest?.text || t('話した内容が、ここに表示されます。', 'Your conversation will appear here.')}</p>}
        </div>
        <div className="human-progress"><div className="section-caption"><span>{t('人と、つながる', 'A HUMAN CONNECTION')}</span>{request?.simulated && <span className="simulation-tag">{t('模擬デバイス', 'SIMULATED DEVICE')}</span>}</div><h2>{requestStatus || t('人にしかできないことは、人へ。', 'Some things take a person.')}</h2><p>{request?.result?.text || request?.task || request?.summary || t('確認や作業が必要なときは、ここで進み具合をお知らせします。', 'When a person’s help is needed, follow the progress here.')}</p>{request?.status === 'accepted' && !request.audioConnected && <small>{t('音声の接続はまだ確認されていません。', 'A voice connection has not yet been confirmed.')}</small>}</div>
      </section>}

      <section id="about" className="about-haas" aria-labelledby="about-title"><div className="about-image"><img src="/images/haas-office.png" alt={t('緑の見えるオフィスで働く人々と、デスクに置かれた黒電話。HaaSのコンセプトイメージ。', 'A black rotary telephone and colleagues in a sunlit office. A concept image for HaaS.')} width="1536" height="1024" /><span>HUMAN AS A SERVICE</span></div><div className="about-copy"><p className="eyebrow">OUR PHILOSOPHY</p><h2 id="about-title">{t('テクノロジーの先に、', 'Beyond technology,')}<br />{t('いつも、人がいる。', 'there’s always a person.')}</h2><p>{t('すぐに話したい。その想いにAIが応える。', 'AI meets the moment when you need to talk.')}<br />{t('そして、AIだけでは届かないところに、人の力を。', 'And where AI reaches its limit, people bring their judgment and care.')}</p><p>{t('私たちは、人が人にしかできない仕事に向き合える未来をつくります。', 'We’re building a future where people can focus on the work only people can do.')}</p><a href="#consultation">{t('まずは、話してみる', 'Start a conversation')}<Arrow /></a></div></section>
    </main>
    <footer className="haas-footer"><div><span className="footer-wordmark">HaaS.</span><span>HUMAN AS A SERVICE</span></div><p>{t('音声はAIに送信されます。マイクは開始後に使用します。', 'Audio is sent to AI. Your microphone is used only after you start.')}</p><small>{t('ハッカソン・コンセプトデモ ｜ 画像は生成したイメージです', 'HACKATHON CONCEPT DEMO · AI-generated concept image')}</small></footer>
  </div>
}
