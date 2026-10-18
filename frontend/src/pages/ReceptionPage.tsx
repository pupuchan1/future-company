import { useEffect, useRef, useState } from "react";
import { useLiveConnection } from "@/features/live/useLiveConnection";
import { AudioOrb } from "@/features/live/AudioOrb";
import type { LiveLanguage, LivePhase, LiveRoute } from "@/features/live/types";

const phrase = (language: LiveLanguage, ja: string, en: string) =>
  language === "ja" ? ja : en;
const routes: Record<LiveRoute, [string, string]> = {
  reception: ["AI受付", "AI reception"],
  recruiting: ["採用の相談", "Recruiting"],
  haas: ["仕事・人への依頼", "Work & human assistance"],
};
const phases: Record<LivePhase, [string, string]> = {
  idle: ["受付待機中", "Ready"],
  connecting: ["接続しています", "Connecting"],
  connected: ["会話中", "Connected"],
  reconnecting: ["再接続を待っています", "Reconnecting"],
  switching: ["担当の声に切り替えています", "Switching the assistant voice"],
  stopping: ["会話を終了しています", "Ending conversation"],
  ended: ["会話を終了しました", "Conversation ended"],
  error: ["接続を確認してください", "Check the connection"],
};
function Mic({ off = false }: { off?: boolean }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
      {off && <path d="m2 2 20 20" />}
    </svg>
  );
}
export function ReceptionPage() {
  const [language, setLanguage] = useState<LiveLanguage>(() =>
    navigator.language.startsWith("ja") ? "ja" : "en",
  );
  const [caseId, setCaseId] = useState(() => crypto.randomUUID());
  const live = useLiveConnection({ caseId, language });
  const s = live.snapshot;
  const text = (ja: string, en: string) => phrase(language, ja, en);
  const [showDetails, setShowDetails] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const orb = useRef<HTMLDivElement>(null);
  const [orbVisible, setOrbVisible] = useState(true);
  const active = [
    "connecting",
    "connected",
    "reconnecting",
    "switching",
    "stopping",
  ].includes(s.phase);
  const available = Boolean(s.configured && s.mcpConfigured);
  const isEnglish = language === "en";
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  useEffect(() => {
    if (s.phase === "connected" && s.language !== language)
      setLanguage(s.language);
  }, [s.language, s.phase, language]);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [s.transcripts]);
  useEffect(() => {
    if (!orb.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setOrbVisible(entry.isIntersecting));
    observer.observe(orb.current);
    return () => observer.disconnect();
  }, []);
  async function toggleCall() {
    if (active) await live.stop();
    else await live.start();
  }
  return (
    <div className="app-shell reception-shell">
      <a className="skip-link" href="#main">
        {text("本文へ移動", "Skip to content")}
      </a>
      <header className="site-header">
        <a className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            F<span>↗</span>
          </span>
          <span>
            FUTURE
            <br />
            COMPANY
          </span>
        </a>
        <span className="reception-header-label">
          {text("AI総合受付", "AI RECEPTION")}
        </span>
        <div className="language-switch" aria-label="Display language">
          <button aria-pressed={!isEnglish} onClick={() => setLanguage("ja")}>
            JP
          </button>
          <span>/</span>
          <button aria-pressed={isEnglish} onClick={() => setLanguage("en")}>
            EN
          </button>
        </div>
      </header>
      <main id="main" className="page-width reception-main">
        <section className="reception-hero">
          <div className="reception-intro">
            <p className="eyebrow">ONE CONVERSATION. THE RIGHT HELP.</p>
            <h1>
              {text("まずは、", "Start with")}
              <br />
              <span>{text("話してください。", "a conversation.")}</span>
            </h1>
            <p className="hero-description">
              {text(
                "仕事の相談も、人への確認も。\n話した内容に合わせて、AIが必要な担当につなぎます。",
                "A question about work. A request for a person.\nTell the AI what you need, and it will find the right help.",
              )}
            </p>
            <div className="reception-examples">
              <p>
                {text(
                  "たとえば、こんなお話から。",
                  "For example, you can say:",
                )}
              </p>
              <ul>
                <li>
                  {text(
                    "「募集している仕事について聞きたい」",
                    "“I’d like to hear about the open roles.”",
                  )}
                </li>
                <li>
                  {text(
                    "「現場の担当者に確認してほしい」",
                    "“Could you check with someone on the team?”",
                  )}
                </li>
                <li>
                  {text(
                    "「この作業を人にお願いしたい」",
                    "“I need someone to help with this task.”",
                  )}
                </li>
              </ul>
            </div>
          </div>
          <section
            className="reception-voice"
            aria-label={text("共通音声受付", "Shared voice reception")}
          >
            <div className="row spread">
              <span className="section-label">
                {text("ひとつの窓口から", "ONE SHARED RECEPTION")}
              </span>
              <span className="connection">
                <span className="status-square" />
                {available || active
                  ? phases[s.phase][isEnglish ? 1 : 0]
                  : text("準備中", "Preparing")}
              </span>
            </div>
            <div ref={orb}>
              <AudioOrb {...s} language={language} />
            </div>
            <h2>
              {active
                ? text(
                    "そのまま、お話しください。",
                    "Go ahead. We’re listening.",
                  )
                : text(
                    "用件は、話しながらで大丈夫。",
                    "Tell us what’s on your mind.",
                  )}
            </h2>
            <p className="small voice-description">
              {text(
                "最初に担当や言語を選ぶ必要はありません。\nAIが会話を聞いて、必要なツールへ引き継ぎます。",
                "No need to choose a department or language first.\nThe AI listens and hands your request to the right tools.",
              )}
            </p>
            <button
              className="button primary reception-start"
              onClick={() => void toggleCall()}
              disabled={s.phase === "stopping" || (!active && !available)}
              aria-label={
                active
                  ? text("会話を終了", "End conversation")
                  : text("AIに話しかける", "Talk to AI")
              }
            >
              <Mic off={active} />
              <span>
                {active
                  ? text("会話を終了", "End conversation")
                  : text("AIに話しかける", "Talk to AI")}
              </span>
              <span aria-hidden="true">{active ? "■" : "→"}</span>
            </button>
            {active && s.phase !== "stopping" && (
              <button
                className="text-button reception-mute"
                aria-pressed={s.muted}
                onClick={live.toggleMuted}
                disabled={s.phase === "switching"}
              >
                <Mic off={s.muted} />
                {s.muted
                  ? text("マイクをオンにする", "Unmute microphone")
                  : text("マイクをオフにする", "Mute microphone")}
              </button>
            )}
            {active && s.voice && (
              <div className="reception-voice-switch">
                <p className="small">{text("現在の声", "Current voice")}: {routes[s.voiceRoute][isEnglish ? 1 : 0]}</p>
                {s.switchConfigured && s.voiceRoute !== s.route && s.phase === "connected" && (
                  <button className="button secondary full" onClick={() => void live.switchDepartment(s.route)}>
                    {text(`${routes[s.route][0]}の声に切り替える`, `Switch to the ${routes[s.route][1]} voice`)}
                  </button>
                )}
              </div>
            )}
            <p className="small reception-consent">
              {text(
                "開始するとマイクを使用し、音声をAIに送信します。",
                "Starting uses your microphone and sends audio to the AI.",
              )}
            </p>
            {!available && !active && (
              <div className="reception-unavailable" role="status">
                <p>
                  {s.configured === null
                    ? text(
                        "受付への接続を確認しています。",
                        "Checking the reception connection.",
                      )
                    : text(
                        "音声受付の準備中です。準備ができると開始できます。",
                        "Voice reception is being prepared. You can start when it is ready.",
                      )}
                </p>
                <button
                  className="text-button"
                  onClick={() => void live.refreshStatus()}
                >
                  {text("接続を再確認", "Check again")} ↻
                </button>
              </div>
            )}
            {s.playbackBlocked && (
              <div role="status">
                <p className="small">
                  {text(
                    "ブラウザが音声再生を停止しています。",
                    "Your browser has paused audio playback.",
                  )}
                </p>
                <button
                  className="button secondary full"
                  onClick={() => void live.playAudio()}
                >
                  {text("AIの音声を再生", "Play AI audio")}
                </button>
              </div>
            )}
            {(s.error || s.cleanupWarning) && (
              <p role="alert" className="inline-error">
                {s.error || s.cleanupWarning}
              </p>
            )}
          </section>
        </section>
        <section
          className="reception-progress"
          aria-label={text("仕事の進行", "Work progress")}
        >
          <div>
            <span className="section-label">
              {text("現在の担当", "CURRENT ASSISTANT")}
            </span>
            <strong>{routes[s.route][isEnglish ? 1 : 0]}</strong>
          </div>
          <div>
            <span className="section-label">
              {text("ツールの処理", "TOOL ACTIVITY")}
            </span>
            <strong>
              {s.backend === "running"
                ? text("依頼を進めています", "Working on your request")
                : s.backend === "result"
                  ? text("結果を受け取りました", "Result received")
                  : s.backend === "error"
                    ? text("確認が必要です", "Needs attention")
                    : text(
                        "用件に合わせてAIが選択",
                        "Selected by the AI as needed",
                      )}
            </strong>
          </div>
          <div>
            <span className="section-label">
              {text("人への依頼", "HUMAN ASSISTANCE")}
            </span>
            <strong>
              {s.requests.length
                ? text(
                    `${s.requests.length}件の依頼`,
                    `${s.requests.length} request(s)`,
                  )
                : text("必要になったらAIが依頼", "The AI asks when needed")}
            </strong>
          </div>
        </section>
        <div className="reception-content">
          <section className="panel reception-transcript">
            <h2 className="panel-heading">
              {text("会話", "Conversation")}
              <span>
                {text(
                  "話した内容とAIの回答",
                  "Your words and the AI’s replies",
                )}
              </span>
            </h2>
            <div
              ref={log}
              className="transcript"
              role="log"
              aria-live="polite"
              aria-label={text("会話の文字起こし", "Conversation transcript")}
            >
              {s.transcripts.length ? (
                s.transcripts.map((m) => (
                  <article key={m.id} className={`message message-${m.role}`}>
                    <div className="message-label">
                      {m.role === "user"
                        ? text("あなた", "You")
                        : m.role === "system"
                          ? text("お知らせ", "Notice")
                          : "AI"}
                      {!m.final && (
                        <span>{text("聞き取り中", "In progress")}</span>
                      )}
                    </div>
                    <p>{m.text}</p>
                  </article>
                ))
              ) : (
                <div className="reception-empty">
                  <Mic />
                  <p>
                    {text(
                      "会話を始めると、ここに内容が表示されます。",
                      "Your conversation will appear here once you start.",
                    )}
                  </p>
                  <span className="small">
                    {text(
                      "どんな用件でも、同じ入口からどうぞ。",
                      "Whatever you need, start in the same place.",
                    )}
                  </span>
                </div>
              )}
            </div>
          </section>
          <aside className="reception-work">
            <section className="panel">
              <h2 className="panel-heading">
                {text("担当への引き継ぎ", "Handoffs & results")}
              </h2>
              <div className="task-body">
                {s.backendResult && (
                  <div className="answer">
                    <strong>
                      {text("ツールからの結果", "Result from the tools")}
                    </strong>
                    <p>{s.backendResult}</p>
                  </div>
                )}
                {s.requests.length
                  ? s.requests.map((request) => (
                      <article
                        className="reception-request"
                        key={request.handoffId}
                      >
                        <span className="tag">{request.status}</span>
                        <h3>{request.task || request.summary}</h3>
                        {request.targetRole && (
                          <p className="small">
                            {text("依頼先", "For")}: {request.targetRole}
                          </p>
                        )}
                        {request.expectedResult && (
                          <p className="small">
                            {text("確認したいこと", "Expected result")}:{" "}
                            {request.expectedResult}
                          </p>
                        )}
                        {request.simulated === true && (
                          <p className="small">
                            {text(
                              "模擬デバイスによるデモ",
                              "Simulated device demo",
                            )}
                          </p>
                        )}
                        {request.status === "accepted" && (
                          <p className="small">
                            {text(
                              "受話器が応答しました。音声通話の接続とは別の状態です。",
                              "The handset answered. This is separate from a voice connection.",
                            )}
                          </p>
                        )}
                        {request.result && (
                          <div className="answer">
                            <strong>
                              {text(
                                "担当者の回答（原文）",
                                "Team reply (original)",
                              )}
                            </strong>
                            <p>{request.result.text}</p>
                          </div>
                        )}
                        {request.unavailableReason && (
                          <p className="small">{request.unavailableReason}</p>
                        )}
                      </article>
                    ))
                  : !s.backendResult && (
                      <div className="reception-handoff-empty">
                        <span>01</span>
                        <p>
                          {text(
                            "AIが用件を整理",
                            "The AI understands your request",
                          )}
                        </p>
                        <span>02</span>
                        <p>
                          {text(
                            "必要な担当・ツールに依頼",
                            "It asks the right assistant or tool",
                          )}
                        </p>
                        <span>03</span>
                        <p>
                          {text(
                            "結果をこの会話に戻す",
                            "The result returns to this conversation",
                          )}
                        </p>
                      </div>
                    )}
              </div>
            </section>
          </aside>
        </div>
        <div className="reception-bottom">
          {["ended", "error"].includes(s.phase) && (
            <button
              className="text-button"
              onClick={() => setCaseId(crypto.randomUUID())}
            >
              {text("新しい会話を用意する", "Prepare a new conversation")} →
            </button>
          )}
          <button
            className="text-button"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((v) => !v)}
          >
            {text("接続情報", "Connection details")} {showDetails ? "−" : "＋"}
          </button>
        </div>
        {showDetails && (
          <dl className="facts reception-connection">
            <dt>{text("イベント", "Events")}</dt>
            <dd>{s.events}</dd>
            <dt>{text("音声", "Voice")}</dt>
            <dd>
              {s.configured === null
                ? text("未確認", "Unconfirmed")
                : s.configured
                  ? text("設定済み", "Configured")
                  : text("設定待ち", "Not configured")}
            </dd>
            <dt>MCP</dt>
            <dd>
              {s.mcpConfigured
                ? text("設定済み", "Configured")
                : text("設定待ち", "Not configured")}
            </dd>
            <dt>{text("会話ID", "Case ID")}</dt>
            <dd>{caseId}</dd>
          </dl>
        )}
      </main>
      {active && !orbVisible && (
        <div className="reception-floating-voice" aria-label={text("音声通話", "Voice call")}>
          <AudioOrb {...s} language={language} compact />
          <span>{phases[s.phase][isEnglish ? 1 : 0]}</span>
          <button className="button secondary" disabled={s.phase === "stopping"} onClick={() => void live.stop()}>
            {text("終了", "End")}
          </button>
        </div>
      )}
      <footer className="site-footer">
        <span>FUTURE COMPANY</span>
        <span>
          {text(
            "ひとつの会話から、仕事を前へ。",
            "One conversation. Moving work forward.",
          )}
        </span>
        <span>DEVDAY 2026</span>
      </footer>
    </div>
  );
}
