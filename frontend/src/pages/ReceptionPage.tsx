import { useEffect, useRef, useState } from "react";
import { useReceptionConnection } from "@/features/worker/useReceptionConnection";
import { VoiceOrb } from "@/features/voice/VoiceOrb";
import type { LiveLanguage, LiveRoute } from "@/features/live/types";
import { useDisplayLanguage } from "@/lib/useDisplayLanguage";
import { LanguageSelector } from "@/components/LanguageSelector";
import { systemMessage } from "@/lib/system-message";
import { LANGUAGE_CHANGE_ERROR } from "@/features/live/types";
import { ReceptionIntro, ReceptionOffice, ReceptionCapabilities } from "@/components/ReceptionHome";
import "@/styles/reception-conversation.css";

const phrase = (language: LiveLanguage, ja: string, en: string) =>
  language === "ja" ? ja : en;
const routes: Record<LiveRoute, [string, string]> = {
  reception: ["AI受付", "AI reception"],
  recruiting: ["採用の相談", "Recruiting"],
  haas: ["仕事・人への依頼", "Work & human assistance"],
};
const requestLabels: Record<string, [string, string]> = {
  requested: ["担当者へ依頼中", "Requested"],
  ringing: ["着信要求に応答あり", "Ring request acknowledged"],
  accepted: ["受話器の応答あり", "Handset answered"],
  completed: ["対応終了", "Handling ended"],
  unavailable: ["対応できません", "Unavailable"],
  cancelled: ["取消済み", "Cancelled"],
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
  const { language, preference, selectLanguage } = useDisplayLanguage();
  const live = useReceptionConnection(language, preference);
  const caseId = live.caseId;
  const s = live.snapshot;
  const text = (ja: string, en: string) => phrase(language, ja, en);
  const [showDetails, setShowDetails] = useState(false);
  const [conversationView, setConversationView] = useState(() => window.location.hash === "#conversation");
  const conversationHeading = useRef<HTMLHeadingElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const active = live.preparing || [
    "connecting",
    "connected",
    "reconnecting",
    "switching",
    "stopping",
  ].includes(s.phase);
  const available = Boolean(s.configured && s.mcpConfigured);
  const isEnglish = language === "en";
  const hasConversation = conversationView || Boolean(s.transcripts.length || s.requests.length || s.backendResult || s.phase === "connected");
  useEffect(() => {
    const updateView = () => setConversationView(window.location.hash === "#conversation");
    window.addEventListener("hashchange", updateView);
    return () => window.removeEventListener("hashchange", updateView);
  }, []);
  useEffect(() => {
    if (conversationView) {
      conversationHeading.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [conversationView]);
  function openConversation() {
    if (window.location.hash !== "#conversation") window.location.hash = "conversation";
    else {
      conversationHeading.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
    }
  }
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [s.transcripts]);
  async function toggleCall() {
    if (active) await live.stop();
    else await live.start();
  }
  return (
    <div className={`app-shell reception-shell haas-homepage${hasConversation ? " haas-in-conversation" : ""}${conversationView ? " haas-conversation-view" : ""}`}>
      <a className="skip-link" href={conversationView ? "#conversation" : "#main"}>
        {text("本文へ移動", "Skip to content")}
      </a>
      <header className="site-header">
        <a className="brand" href={conversationView ? "#home" : "/"} aria-label={text("株式会社HaaS ホーム", "HaaS home")}>
          <span className="brand-mark brand-reserved" aria-hidden="true">
            H<span>↗</span>
          </span>
          <span className="haas-brand-name brand-reserved" aria-hidden="true">
            {text("株式会社HaaS", "HaaS, Inc.")}
            <small lang="en">Human as a Service.</small>
          </span>
          <svg className="haas-brand-logo" viewBox="190 165 1608 450" aria-hidden="true">
            <image href="/images/haas-logo.png" width="1983" height="793" />
          </svg>
        </a>
        <span className="reception-header-label">
          {text("AI総合受付", "AI RECEPTION")}
        </span>
        <LanguageSelector language={language} preference={preference} onChange={selectLanguage} />
      </header>
      <main id="main" className="page-width reception-main">
        {conversationView && <div className="reception-conversation-heading">
          <a className="text-button" href="#home">← {text("ホームへ戻る", "Back to home")}</a>
          <h1 id="conversation" ref={conversationHeading} tabIndex={-1}>{text("AIとの会話", "Conversation with AI")}</h1>
        </div>}
        <section className="reception-hero">
          {!conversationView && <ReceptionIntro language={language} />}
          {!hasConversation && <ReceptionOffice language={language} />}
          <section
            className="reception-voice"
            aria-label={text("共通音声受付", "Shared voice reception")}
          >
            <VoiceOrb activity={live.voice} phase={s.phase} language={language} muted={s.muted} playbackBlocked={s.playbackBlocked} onOpenConversation={openConversation} />
            <div className="reception-controls">
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
            {["connected", "switching"].includes(s.phase) && (
              <button
                className="text-button reception-mute"
                aria-pressed={s.muted}
                onClick={live.toggleMuted}
              >
                <Mic off={s.muted} />
                {s.muted
                  ? text("マイクをオンにする", "Unmute microphone")
                  : text("マイクをオフにする", "Mute microphone")}
              </button>
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
            {(s.error || s.cleanupWarning || live.worker.error) && (
              <p role="alert" className="inline-error">
                {systemMessage(s.error || s.cleanupWarning || live.worker.error, language)}
              </p>
            )}
            {s.error === LANGUAGE_CHANGE_ERROR && (
              <button type="button" className="text-button" onClick={() => void live.retryLanguage()}>
                {text("言語の変更を再試行", "Retry language change")}
              </button>
            )}
            </div>
          </section>
        </section>
        {!hasConversation && <ReceptionCapabilities language={language} />}
        {hasConversation && <section
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
        </section>}
        {hasConversation && <div className="reception-content">
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
                        <span className="tag">{requestLabels[request.status]?.[isEnglish ? 1 : 0] ?? text("状態を確認中", "Checking status")}</span>
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
                        {request.status === "completed" && !request.result && (
                          <p className="small">
                            {text("対応の終了を受信しました。回答本文はまだ届いていません。", "Handling ended. The answer text has not arrived yet.")}
                          </p>
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
        </div>}
        <div className="reception-bottom">
          {["ended", "error"].includes(s.phase) && (
            <button
              className="text-button"
              onClick={() => void live.resetCase()}
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
            <dd>{caseId || text("音声開始時に作成", "Created when you start")}</dd>
          </dl>
        )}
      </main>
      <footer className="site-footer">
        <span>{text("株式会社HaaS", "HaaS, Inc.")}</span>
        <span>
          {text(
            "Human as a Service.",
            "Human as a Service.",
          )}
        </span>
        <span>{text("DEVDAY 2026 · プロジェクトデモ", "DEVDAY 2026 · PROJECT DEMO")}</span>
      </footer>
    </div>
  );
}
