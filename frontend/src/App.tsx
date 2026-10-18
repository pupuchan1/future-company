import { LiveConnectionPanel } from "@/features/live/LiveConnectionPanel";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  activeTask,
  createSession,
  mutateSession,
  readSessions,
  requestHuman,
  saveSession,
  say,
  sendMessage,
  updateTask,
} from "@/lib/demo";
import type { HumanTask, Language, Session, TaskStatus } from "@/lib/demo";

const copy = {
  ja: {
    home: "受付",
    operator: "担当者の作業受付",
    start: "AI受付と話す",
    direct: "この仕事について話す",
    conversation: "会話",
    info: "仕事・依頼の状況",
    recruiting: "採用担当AI",
    reception: "受付AI",
    end: "会話を終了",
    send: "送信",
    ask: "人に確認を依頼",
    resume: "会話を再開",
    back: "トップに戻る",
    role: "ソフトウェアエンジニア",
    pending: "回答待ち",
    empty: "まだありません",
    summary: "会話のメモ",
  },
  en: {
    home: "Reception",
    operator: "Team workspace",
    start: "Talk to reception",
    direct: "Discuss this role",
    conversation: "Conversation",
    info: "Role & requests",
    recruiting: "Recruiting AI",
    reception: "Reception AI",
    end: "End conversation",
    send: "Send",
    ask: "Ask a person",
    resume: "Resume conversation",
    back: "Back to home",
    role: "Software engineer",
    pending: "Awaiting reply",
    empty: "Nothing yet",
    summary: "Conversation notes",
  },
};
const statuses: Record<TaskStatus, [string, string]> = {
  created: ["依頼作成", "Created"],
  ringing: ["呼び出し中（デモ）", "Calling (demo)"],
  accepted: ["対応中", "In progress"],
  completed: ["完了", "Completed"],
  unanswered: ["応答なし", "No response"],
  cancelled: ["取消済み", "Cancelled"],
};
const statusLabel = (t: HumanTask, l: Language) =>
  statuses[t.status][l === "ja" ? 0 : 1];
function Icon({
  name,
  size = 20,
}: {
  name: "arrow" | "mic" | "send" | "stop" | "check" | "person" | "plus";
  size?: number;
}) {
  const paths = {
    arrow: "M4 12h16m-6-6 6 6-6 6",
    mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8",
    send: "m3 3 18 9-18 9 4-9-4-9Zm4 9h14",
    stop: "M6 6h12v12H6z",
    check: "m5 12 4 4L19 6",
    person: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 22v-3a8 8 0 0 1 16 0v3",
    plus: "M12 4v16M4 12h16",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
function useRoute() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const sync = () => setPath(location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  function go(next: string) {
    history.pushState(null, "", next);
    setPath(next);
    window.scrollTo(0, 0);
  }
  return { path, go };
}
function useSessions() {
  const [sessions, setSessions] = useState<Session[]>(() => readSessions());
  useEffect(() => {
    const sync = () => setSessions(readSessions());
    window.addEventListener("storage", sync);
    window.addEventListener("demo-update", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("demo-update", sync);
    };
  }, []);
  return sessions;
}
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((e: { results: { transcript: string }[][] }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};
function useVoice(language: Language, receive: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const instance = useRef<Recognition | null>(null);
  const callback = useRef(receive);
  callback.current = receive;
  useEffect(
    () => () => {
      instance.current?.abort();
    },
    [],
  );
  const supported = Boolean(
    (window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition,
  );
  function toggle() {
    if (listening) {
      instance.current?.stop();
      return;
    }
    const Constructor =
      (window as SpeechWindow).SpeechRecognition ||
      (window as SpeechWindow).webkitSpeechRecognition;
    if (!Constructor) return;
    setError("");
    const recognition = new Constructor();
    instance.current = recognition;
    recognition.lang = language === "ja" ? "ja-JP" : "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (e) =>
      callback.current(e.results[0]?.[0]?.transcript || "");
    recognition.onerror = (e) => {
      setError(
        e.error === "not-allowed"
          ? say(
              language,
              "マイクが許可されていません。文字入力で続けられます。",
              "Microphone access was denied. You can continue by typing.",
            )
          : say(
              language,
              "音声を聞き取れませんでした。もう一度試すか、文字で入力してください。",
              "Speech was not captured. Try again or type your message.",
            ),
      );
      setListening(false);
    };
    recognition.onend = () => setListening(false);
    try {
      recognition.start();
      setListening(true);
    } catch {
      setError(
        say(
          language,
          "音声入力を開始できません。文字で入力してください。",
          "Could not start voice input. Please type instead.",
        ),
      );
    }
  }
  return {
    listening,
    error,
    supported,
    toggle,
    stop: () => instance.current?.abort(),
  };
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 className="panel-heading">{title}</h2>
      {children}
    </section>
  );
}
function JobCard({
  language: l,
  onStart,
}: {
  language: Language;
  onStart?: () => void;
}) {
  return (
    <div className="job-card">
      <div className="section-label">
        ENGINEERING <span>{say(l, "募集例 / 01", "Sample role / 01")}</span>
      </div>
      <h3>{copy[l].role}</h3>
      <p>
        {say(
          l,
          "AIと人が一緒に働く、新しい仕事の仕組みをつくる。",
          "Build a new way of working, where AI and people work together.",
        )}
      </p>
      <div className="job-meta">
        <span>{say(l, "プロダクト開発", "Product development")}</span>
        <span>React / TypeScript</span>
      </div>
      <details>
        <summary>{say(l, "募集内容を確認", "View role details")}</summary>
        <dl className="facts">
          <dt>{say(l, "仕事", "Work")}</dt>
          <dd>
            {say(
              l,
              "Webアプリの設計・実装、AIと人の協働体験の改善。",
              "Build web applications and improve collaboration between AI and people.",
            )}
          </dd>
          <dt>{say(l, "経験", "Experience")}</dt>
          <dd>
            {say(
              l,
              "Web開発の経験。詳しい条件は面談で確認します。",
              "Web development experience. Discuss specific requirements in the conversation.",
            )}
          </dd>
          <dt>{say(l, "働き方", "Work style")}</dt>
          <dd>
            {say(
              l,
              "勤務地・雇用形態・報酬は未設定。担当者へ確認できます。",
              "Location, employment terms and compensation are not set. Ask the team for details.",
            )}
          </dd>
        </dl>
      </details>
      {onStart && (
        <button className="button secondary full" onClick={onStart}>
          {copy[l].direct}
          <Icon name="arrow" />
        </button>
      )}
    </div>
  );
}
function HumanTaskCard({
  session: s,
  language: l,
  run,
}: {
  session: Session;
  language: Language;
  run: Run;
}) {
  const task = s.tasks.at(-1);
  return (
    <Panel title={say(l, "人への確認", "Ask the team")}>
      {!task ? (
        <div className="empty-inline">
          <Icon name="person" size={26} />
          <p>
            {say(
              l,
              "AIだけではわからないことは、\n現場の担当者へ確認できます。",
              "For questions beyond the AI,\nask a person on the team.",
            )}
          </p>
        </div>
      ) : (
        <div className="task-body">
          <div className="row spread">
            <span className="tag">{statusLabel(task, l)}</span>
            <span className="mono">#{task.id.slice(0, 6)}</span>
          </div>
          <h3>{task.question}</h3>
          <ol className="task-steps">
            {(
              ["created", "ringing", "accepted", "completed"] as TaskStatus[]
            ).map((status, i) => (
              <li
                key={status}
                className={
                  (task.history || [task.status]).includes(status)
                    ? "reached"
                    : ""
                }
              >
                <span>{i + 1}</span>
                {statuses[status][l === "ja" ? 0 : 1]}
              </li>
            ))}
          </ol>
          {task.answer && (
            <div className="answer">
              <strong>{say(l, "担当者の回答", "Team reply")}</strong>
              <p>{task.answer}</p>
            </div>
          )}
          {activeTask(s) && (
            <>
              <p className="small">
                {say(
                  l,
                  "回答を待つ間も会話を続けられます。",
                  "You can keep talking while waiting.",
                )}
              </p>
              <button
                className="text-button"
                onClick={() =>
                  void run((next) => updateTask(next, task.id, "cancelled"))
                }
              >
                {say(l, "依頼を取り消す", "Cancel request")}
              </button>
            </>
          )}
        </div>
      )}
      <a
        className="panel-link"
        href="/operator"
        target="_blank"
        rel="noreferrer"
      >
        {say(l, "担当者画面を別タブで開く", "Open team workspace in a new tab")}{" "}
        <span>↗</span>
      </a>
    </Panel>
  );
}
type Run = (change: (s: Session) => Session) => Promise<boolean>;
type PageProps = {
  session: Session;
  language: Language;
  go: (path: string) => void;
  run: Run;
};
export default function App() {
  const { path, go } = useRoute();
  const sessions = useSessions();
  const [language, setLanguage] = useState<Language>(() =>
    navigator.language.startsWith("ja") ? "ja" : "en",
  );
  const [error, setError] = useState("");
  const id = path.match(/^\/session\/([^/]+)(?:\/result)?\/?$/)?.[1];
  const session = sessions.find((s) => s.id === id);
  const l = session?.language || language;
  const t = copy[l];
  const operator = path === "/operator";
  const home = path === "/";
  useEffect(() => {
    document.documentElement.lang = l;
  }, [l]);
  useEffect(() => {
    document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
  }, [path]);
  async function run(
    change: (s: Session) => Session,
    sessionId = session?.id,
  ): Promise<boolean> {
    if (!sessionId) return false;
    try {
      await mutateSession(sessionId, change);
      setError("");
      return true;
    } catch {
      setError(
        say(
          l,
          "保存できませんでした。ブラウザの保存設定を確認して、もう一度お試しください。",
          "Could not save. Check your browser storage settings and try again.",
        ),
      );
      return false;
    }
  }
  function start(direct: boolean) {
    try {
      const next = createSession(language, direct);
      saveSession(next);
      go(`/session/${next.id}`);
    } catch {
      setError(
        say(
          l,
          "ブラウザへの保存ができません。保存を許可してからお試しください。",
          "Browser storage is unavailable. Enable storage and try again.",
        ),
      );
    }
  }
  function changeLanguage(next: Language) {
    setLanguage(next);
    if (session) void run((s) => ({ ...s, language: next }));
  }
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        {say(l, "本文へ移動", "Skip to content")}
      </a>
      <header className="site-header">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            go("/");
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            F<span>↗</span>
          </span>
          <span>
            FUTURE
            <br />
            COMPANY
          </span>
        </a>
        <nav aria-label={say(l, "メインナビゲーション", "Main navigation")}>
          <button
            className={`nav-link ${home ? "selected" : ""}`}
            onClick={() => go("/")}
          >
            {t.home}
          </button>
          <button
            className={`nav-link ${operator ? "selected" : ""}`}
            onClick={() => go("/operator")}
          >
            {t.operator}
          </button>
        </nav>
        <div className="language-switch" aria-label="Language">
          <button
            aria-pressed={l === "ja"}
            onClick={() => changeLanguage("ja")}
          >
            JP
          </button>
          <span>/</span>
          <button
            aria-pressed={l === "en"}
            onClick={() => changeLanguage("en")}
          >
            EN
          </button>
        </div>
      </header>
      <div className="demo-notice">
        <span className="status-square" />
        {say(l, "プロトタイプ", "PROTOTYPE")}
        <span>
          {say(
            l,
            "デモと実音声は別モードです。デモの会話・依頼はこのブラウザ内に保存します。",
            "Demo and live voice are separate modes. Demo conversations and requests stay in this browser.",
          )}
        </span>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {home ? (
        <main id="main" tabIndex={-1} className="home-page page-width">
          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">A NEW WAY TO WORK</p>
              <h1>
                {say(l, "次の仕事を、", "Your next role,")}
                <br />
                <span>{say(l, "会話から。", "one conversation away.")}</span>
              </h1>
              <p className="hero-description">
                {say(
                  l,
                  "気になる仕事も、ちょっとした疑問も。\nまずはAI受付に、話してみてください。",
                  "Explore a role. Ask a question.\nStart with a conversation with our AI receptionist.",
                )}
              </p>
              <button
                className="button primary hero-cta"
                onClick={() => start(false)}
              >
                <Icon name="mic" />
                {t.start}
                <Icon name="arrow" />
              </button>
              <p className="small">
                {say(
                  l,
                  "AIが対応します。文字入力でもご利用いただけます。",
                  "You will be speaking with AI. Typing is also available.",
                )}
              </p>
            </div>
            <aside className="intro-panel">
              <div className="section-label">
                HOW IT WORKS <span>01 — 03</span>
              </div>
              <h2>
                {say(
                  l,
                  "話す。わかる。\n次へ進む。",
                  "Talk. Understand.\nMove forward.",
                )}
              </h2>
              <ol className="intro-steps">
                {[
                  [
                    say(l, "まずは、気軽に話す", "Start a conversation"),
                    say(
                      l,
                      "履歴書の準備は不要です。",
                      "No résumé needed to get started.",
                    ),
                  ],
                  [
                    say(l, "知りたいことを聞く", "Ask what matters to you"),
                    say(
                      l,
                      "必要なことは、人にも確認。",
                      "The team can help when needed.",
                    ),
                  ],
                  [
                    say(l, "話した内容を持ち帰る", "Leave with clear notes"),
                    say(
                      l,
                      "回答と次の一歩をまとめます。",
                      "Review answers and your next steps.",
                    ),
                  ],
                ].map(([title, body], i) => (
                  <li key={title}>
                    <span>0{i + 1}</span>
                    <div>
                      <strong>{title}</strong>
                      <p>{body}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </aside>
          </section>
          <section className="open-roles">
            <div className="section-title">
              <div>
                <p className="eyebrow">OPEN ROLE</p>
                <h2>
                  {say(l, "一緒につくる仕事。", "A role to build together.")}
                </h2>
              </div>
              <span className="small">
                {say(l, "1件の募集サンプル", "1 sample opening")}
              </span>
            </div>
            <JobCard language={l} onStart={() => start(true)} />
          </section>
        </main>
      ) : operator ? (
        <OperatorPage sessions={sessions} language={l} run={run} />
      ) : session ? (
        /\/result\/?$/.test(path) ? (
          <ResultPage session={session} language={l} go={go} run={run} />
        ) : (
          <ConversationPage
            key={session.id}
            session={session}
            language={l}
            go={go}
            run={run}
          />
        )
      ) : (
        <main id="main" tabIndex={-1} className="page-width missing">
          <p className="eyebrow">NOT FOUND</p>
          <h1>{say(l, "会話が見つかりません", "Conversation not found")}</h1>
          <p>
            {say(
              l,
              "このブラウザに保存された会話からご利用ください。",
              "Open a conversation saved in this browser.",
            )}
          </p>
          <button className="button primary" onClick={() => go("/")}>
            {t.back}
            <Icon name="arrow" />
          </button>
        </main>
      )}
      <footer className="site-footer">
        <span>FUTURE COMPANY</span>
        <span>
          {say(
            l,
            "AIと人で、仕事を前へ。",
            "AI and people. Moving work forward.",
          )}
        </span>
        <span>DEVDAY 2026</span>
      </footer>
    </div>
  );
}
function ConversationPage({ session: s, language: l, go, run }: PageProps) {
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const t = copy[l];
  const [text, setText] = useState("");
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const voice = useVoice(l, setText);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [s.messages.length]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (text.trim() && (await run((next) => sendMessage(next, text))))
      setText("");
  }
  const modeSwitch = <div className="mode-switch" aria-label={say(l, "体験モード", "Experience mode")}><button aria-pressed={mode === "demo"} onClick={() => setMode("demo")}>{say(l, "デモを試す", "Try the demo")}</button><button aria-pressed={mode === "live"} onClick={() => { voice.stop(); setMode("live"); }}>{say(l, "AI音声に接続", "Connect to AI voice")}</button></div>;
  if (mode === "live") return <main id="main" tabIndex={-1} className="session-page page-width"><div className="page-heading"><div><p className="eyebrow">LIVE CONVERSATION</p><h1>{say(l, "AIと、声で話す。", "Talk to AI, by voice.")}</h1></div></div>{modeSwitch}<p className="live-intro">{say(l, "音声サーバーに接続します。デモの会話や依頼とは別に進行します。", "Connect to the voice server. This conversation runs separately from the demo.")}</p><LiveConnectionPanel caseId={s.id} language={l} /></main>;
  return (
    <main id="main" tabIndex={-1} className="session-page page-width">
      {modeSwitch}
      <div className="page-heading">
        <div>
          <p className="eyebrow">LET’S TALK</p>
          <h1>
            {say(l, "仕事のこと、話しましょう。", "Let’s talk about work.")}
          </h1>
        </div>
        <span className="session-id mono">SESSION / {s.id.slice(0, 8)}</span>
      </div>
      <div className="session-grid">
        <section className="conversation-panel" aria-label={t.conversation}>
          <div className="conversation-top">
            <div className="agent-icon">AI</div>
            <div>
              <strong>
                {s.agent === "reception" ? t.reception : t.recruiting}
              </strong>
              <p className="small">
                {say(l, "日本語", "English")} /{" "}
                {say(l, "デモ応答", "Demo responses")}
              </p>
            </div>
            <span className="connection">
              <span className="status-square" />
              {s.ended ? say(l, "終了", "Ended") : say(l, "会話中", "Active")}
            </span>
          </div>
          <div className="voice-stage">
            <div
              className={`waveform ${voice.listening ? "listening" : ""}`}
              aria-hidden="true"
            >
              {[12, 24, 38, 20, 52, 34, 64, 44, 26, 56, 38, 20, 42, 28, 12].map(
                (height, i) => (
                  <i
                    key={i}
                    style={{ height, animationDelay: `${i * 0.08}s` }}
                  />
                ),
              )}
            </div>
            <p>
              {voice.listening
                ? say(l, "聞き取り中です…", "Listening…")
                : say(
                    l,
                    "あなたのペースで、お話しください。",
                    "Take your time. We’re here to listen.",
                  )}
            </p>
            <span className="small">
              {say(l, "音声入力・文字入力に対応", "Voice input or typing")}
            </span>
          </div>
          <div
            ref={log}
            className="transcript"
            role="log"
            aria-label={say(l, "会話の文字起こし", "Conversation transcript")}
            aria-live="polite"
            aria-relevant="additions text"
          >
            {s.messages.map((m) => (
              <div key={m.id} className={`message message-${m.role}`}>
                {m.role !== "system" && (
                  <div className="message-label">
                    {m.role === "user" ? say(l, "あなた", "You") : "AI"}
                    <time>
                      {new Date(m.at).toLocaleTimeString(l, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  </div>
                )}
                <p>{m.text}</p>
              </div>
            ))}
          </div>
          {!s.ended && !s.messages.some((m) => m.role === "user") && (
            <div className="suggestions">
              {[
                say(
                  l,
                  "募集している仕事を知りたい",
                  "Tell me about the open role",
                ),
                say(
                  l,
                  "開発環境を教えてください",
                  "What is the development environment?",
                ),
              ].map((prompt) => (
                <button key={prompt} onClick={() => setText(prompt)}>
                  {prompt}
                  <Icon name="plus" size={14} />
                </button>
              ))}
            </div>
          )}
          <div className="conversation-controls">
            {voice.error && (
              <p className="inline-error" role="alert">
                {voice.error}
              </p>
            )}
            {s.ended ? (
              <div className="ended-controls">
                <p>
                  {say(
                    l,
                    "この会話は終了しました。メモを確認できます。",
                    "This conversation has ended. Your notes are ready.",
                  )}
                </p>
                <button
                  className="button primary"
                  onClick={() => go(`/session/${s.id}/result`)}
                >
                  {t.summary}
                  <Icon name="arrow" />
                </button>
              </div>
            ) : (
              <>
                <form onSubmit={(e) => void submit(e)} className="message-form">
                  <label className="sr-only" htmlFor="message">
                    {say(l, "メッセージ", "Message")}
                  </label>
                  <textarea
                    id="message"
                    rows={2}
                    maxLength={4000}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={say(l, "メッセージを入力…", "Type a message…")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        void submit(e);
                      }
                    }}
                  />
                  <button
                    className="button primary send-button"
                    disabled={!text.trim()}
                    type="submit"
                    aria-label={t.send}
                  >
                    <Icon name="send" />
                    <span>{t.send}</span>
                  </button>
                </form>
                <div className="row spread controls-row">
                  <button
                    className={`button compact ${voice.listening ? "primary" : "secondary"}`}
                    disabled={!voice.supported}
                    onClick={voice.toggle}
                    aria-pressed={voice.listening}
                  >
                    <Icon name={voice.listening ? "stop" : "mic"} />
                    {voice.listening
                      ? say(l, "音声入力を停止", "Stop listening")
                      : say(l, "音声で入力", "Use voice")}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => {
                      voice.stop();
                      setEnding(true);
                    }}
                  >
                    <Icon name="stop" size={15} />
                    {t.end}
                  </button>
                </div>
                <p className="small voice-note">
                  {voice.supported
                    ? say(
                        l,
                        "音声入力はブラウザの音声認識を使用します。内容を確認して送信してください。",
                        "Voice input uses browser speech recognition. Review the text before sending.",
                      )
                    : say(
                        l,
                        "このブラウザでは音声入力を利用できません。文字でお話しください。",
                        "Voice input is unavailable in this browser. Please type instead.",
                      )}
                </p>
              </>
            )}
          </div>
        </section>
        <aside className={`session-sidebar ${showInfo ? "mobile-open" : ""}`}>
          <button
            className="mobile-close button secondary"
            onClick={() => setShowInfo(false)}
          >
            {say(l, "会話に戻る", "Back to conversation")} ↓
          </button>
          <Panel
            title={say(l, "いま話している仕事", "The role you’re exploring")}
          >
            <JobCard language={l} />
          </Panel>
          <HumanTaskCard session={s} language={l} run={run} />
          {!s.ended && (
            <button
              className="button primary full ask-button"
              disabled={Boolean(activeTask(s))}
              onClick={() => {
                setQuestion(
                  s.messages.filter((m) => m.role === "user").at(-1)?.text ||
                    say(
                      l,
                      "現場の開発環境について教えてください。",
                      "Please tell me about the team’s development environment.",
                    ),
                );
                setAsking(true);
              }}
            >
              <Icon name="person" />
              {activeTask(s) ? t.pending : t.ask}
              <Icon name="arrow" />
            </button>
          )}
          <p className="small sidebar-note">
            {say(
              l,
              "募集情報はサンプルです。\n実際の応募・合否判定は行いません。",
              "Role information is sample content.\nThis demo does not submit applications or assess candidates.",
            )}
          </p>
        </aside>
      </div>
      <button
        className="mobile-info button primary"
        onClick={() => setShowInfo(true)}
      >
        {t.info}
        <Icon name="arrow" />
      </button>
      {asking && (
        <Modal title={t.ask} onClose={() => setAsking(false)}>
          <p>
            {say(
              l,
              "確認したいことを担当者へ送ります。会話を続けながら回答を待てます。",
              "Send a question to the team. You can keep talking while you wait.",
            )}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run((next) => requestHuman(next, question)).then((ok) => {
                if (ok) setAsking(false);
              });
            }}
          >
            <label htmlFor="question">
              {say(l, "確認したいこと", "Your question")}
            </label>
            <textarea
              id="question"
              autoFocus
              required
              maxLength={4000}
              rows={4}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button
              className="button primary full"
              disabled={!question.trim()}
              type="submit"
            >
              {say(l, "確認依頼を送る", "Send request")}
              <Icon name="arrow" />
            </button>
          </form>
        </Modal>
      )}
      {ending && (
        <Modal
          title={say(l, "会話を終了しますか？", "End this conversation?")}
          onClose={() => setEnding(false)}
        >
          <p>
            {say(
              l,
              "話した内容と確認結果をメモにまとめます。回答待ちの依頼は残り、あとから会話を再開できます。",
              "Your conversation and replies will be collected in notes. Pending requests remain available, and you can resume later.",
            )}
          </p>
          <button
            className="button primary full"
            onClick={() => {
              void run((next) => ({ ...next, ended: true })).then((ok) => {
                if (ok) go(`/session/${s.id}/result`);
              });
            }}
          >
            {say(l, "終了してメモを見る", "End & view notes")}
            <Icon name="arrow" />
          </button>
        </Modal>
      )}
    </main>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="row spread">
        <h2>{title}</h2>
        <button
          className="close-button"
          aria-label="Close / 閉じる"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ResultPage({ session: s, language: l, go, run }: PageProps) {
  const t = copy[l];
  const unresolved = s.tasks.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled",
  );
  function download() {
    const lines = [
      t.summary,
      t.role,
      ...s.messages.map((m) => `${m.role}: ${m.text}`),
      "",
      ...s.tasks.map(
        (task) => `${statusLabel(task, l)}: ${task.question}\n${task.answer}`,
      ),
    ];
    const url = URL.createObjectURL(
      new Blob([lines.join("\n\n")], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `conversation-${s.id.slice(0, 8)}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <main id="main" tabIndex={-1} className="result-page page-width">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR NEXT STEP</p>
          <h1>
            {say(
              l,
              "今日の会話を、次の一歩に。",
              "Turn today’s conversation into a next step.",
            )}
          </h1>
          <p>
            {say(
              l,
              "話したこと、わかったこと、これから確認すること。",
              "What you shared, what you learned, and what comes next.",
            )}
          </p>
        </div>
        <span className="session-id mono">SESSION / {s.id.slice(0, 8)}</span>
      </div>
      <div className="result-layout">
        <div>
          <Panel title={t.summary}>
            <div className="result-content">
              <p className="section-label">
                {s.agent === "recruiting" ? t.recruiting : t.reception}
              </p>
              <h2>{t.role}</h2>
              <p>
                {say(
                  l,
                  "採用についての相談内容をまとめた記録です。ご本人の発言と担当者の回答をそのまま確認できます。",
                  "These notes collect your recruitment conversation. Review your own statements and the team’s replies below.",
                )}
              </p>
              <h3>
                {say(
                  l,
                  "本人が話した経験・希望",
                  "Experience & preferences you shared",
                )}
              </h3>
              {s.experience.length ? (
                <ul>
                  {s.experience.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
              ) : (
                <p className="small">
                  {say(
                    l,
                    "まだ記録されていません。会話を再開して追加できます。",
                    "No experience recorded yet. Resume the conversation to add it.",
                  )}
                </p>
              )}
            </div>
          </Panel>
          <Panel
            title={say(l, "人に確認したこと・回答", "Questions & team replies")}
          >
            <div className="result-content">
              {s.tasks.length ? (
                s.tasks.map((task) => (
                  <article className="result-task" key={task.id}>
                    <span className="tag">{statusLabel(task, l)}</span>
                    <h3>{task.question}</h3>
                    <p>
                      {task.answer ||
                        say(l, "回答はまだありません。", "No reply yet.")}
                    </p>
                  </article>
                ))
              ) : (
                <p>{t.empty}</p>
              )}
            </div>
          </Panel>
          <details className="transcript-details">
            <summary>
              {say(l, "会話の全文を見る", "View full conversation")}
            </summary>
            {s.messages.map((m) => (
              <div className="message" key={m.id}>
                <strong>
                  {m.role === "user"
                    ? say(l, "あなた", "You")
                    : m.role === "assistant"
                      ? "AI"
                      : say(l, "お知らせ", "Notice")}
                </strong>
                <p>{m.text}</p>
              </div>
            ))}
          </details>
        </div>
        <aside>
          <div className="next-step">
            <span className="section-label">NEXT ACTION</span>
            <h2>
              {unresolved.length
                ? say(l, "担当者からの回答を待つ", "Await the team’s reply")
                : say(
                    l,
                    "疑問があれば、また話す",
                    "Keep the conversation going",
                  )}
            </h2>
            <p>
              {unresolved.length
                ? say(
                    l,
                    `${unresolved.length}件の未解決の確認があります。回答はこのメモにも反映されます。`,
                    `${unresolved.length} question(s) remain unresolved. Replies will also appear in these notes.`,
                  )
                : say(
                    l,
                    "会話はいつでも再開できます。気になることを追加で聞いてみましょう。",
                    "You can resume at any time to ask more questions.",
                  )}
            </p>
            <button
              className="button primary full"
              onClick={() =>
                void run((next) => ({ ...next, ended: false })).then((ok) => {
                  if (ok) go(`/session/${s.id}`);
                })
              }
            >
              {t.resume}
              <Icon name="arrow" />
            </button>
            <button className="button secondary full" onClick={download}>
              {say(l, "メモをダウンロード", "Download notes")} ↓
            </button>
            <button className="text-button" onClick={() => go("/")}>
              {t.back}
            </button>
          </div>
          <p className="small sidebar-note">
            {say(
              l,
              "このメモはこのブラウザ内に保存されています。",
              "These notes are stored in this browser.",
            )}
          </p>
        </aside>
      </div>
    </main>
  );
}
function OperatorPage({
  sessions,
  language: l,
  run,
}: {
  sessions: Session[];
  language: Language;
  run: (change: (s: Session) => Session, id?: string) => Promise<boolean>;
}) {
  const [filter, setFilter] = useState("open");
  const [selected, setSelected] = useState("");
  const [answer, setAnswer] = useState("");
  const tasks = sessions.flatMap((session) =>
    session.tasks.map((task) => ({ session, task })),
  );
  const filtered = tasks.filter(
    ({ task }) =>
      filter === "all" ||
      (filter === "done"
        ? task.status === "completed"
        : !["completed", "cancelled", "unanswered"].includes(task.status)),
  );
  const current =
    filtered.find(({ task }) => task.id === selected) || filtered[0];
  const task = current?.task;
  const s = current?.session;
  useEffect(() => {
    setAnswer("");
  }, [task?.id]);
  const update = (status: TaskStatus) => {
    if (task && s)
      void run(
        (next) =>
          updateTask(
            next,
            task.id,
            status,
            status === "completed" ? answer : "",
          ),
        s.id,
      ).then((ok) => {
        if (ok && status === "completed") {
          setFilter("done");
          setSelected(task.id);
        }
      });
  };
  return (
    <main id="main" tabIndex={-1} className="operator-page page-width">
      <div className="page-heading">
        <div>
          <p className="eyebrow">HUMAN WORKSPACE</p>
          <h1>
            {say(
              l,
              "あなたの知識が、次につなぐ。",
              "Your knowledge moves things forward.",
            )}
          </h1>
          <p>
            {say(
              l,
              "AIから届いた確認依頼に、回答してください。",
              "Help answer questions sent by the AI.",
            )}
          </p>
        </div>
        <span className="tag">
          {say(l, "ローカルデモ・認証なし", "Local demo · No authentication")}
        </span>
      </div>
      <div className="operator-grid">
        <section
          className="request-list"
          aria-label={say(l, "依頼一覧", "Requests")}
        >
          <div className="filter-tabs">
            {[
              ["open", say(l, "未対応・対応中", "Open")],
              ["done", say(l, "完了", "Done")],
              ["all", say(l, "すべて", "All")],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                  setSelected("");
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="list-heading small">
            {filtered.length} {say(l, "件の依頼", "requests")}
          </div>
          {filtered.length ? (
            filtered.map(({ task: item }) => (
              <button
                key={item.id}
                className={`request-item ${task?.id === item.id ? "selected" : ""}`}
                onClick={() => setSelected(item.id)}
              >
                <div className="row spread">
                  <span className="tag">{statusLabel(item, l)}</span>
                  <span className="mono">#{item.id.slice(0, 6)}</span>
                </div>
                <h3>{item.question}</h3>
                <p className="small">
                  {say(l, "採用相談", "Recruiting")} /{" "}
                  {new Date(item.createdAt).toLocaleTimeString(l, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </button>
            ))
          ) : (
            <div className="empty-state">
              <Icon name="check" size={32} />
              <h2>{say(l, "依頼はありません", "No requests here")}</h2>
              <p>
                {say(
                  l,
                  "会話画面の「人に確認を依頼」から依頼を作成できます。",
                  "Create a request with “Ask a person” in a conversation.",
                )}
              </p>
            </div>
          )}
        </section>
        <section
          className="operator-detail"
          aria-label={say(l, "依頼詳細", "Request details")}
        >
          {task && s ? (
            <>
              <div className="detail-heading">
                <div className="row spread">
                  <span className="section-label">
                    {say(
                      l,
                      "採用担当AIからの依頼",
                      "REQUEST FROM RECRUITING AI",
                    )}
                  </span>
                  <span className="tag">{statusLabel(task, l)}</span>
                </div>
                <h2>{task.question}</h2>
                <p className="small mono">
                  REQUEST / {task.id.slice(0, 8)} · SESSION / {s.id.slice(0, 8)}
                </p>
              </div>
              <div className="detail-body">
                <dl className="facts">
                  <dt>{say(l, "希望職種", "Role")}</dt>
                  <dd>{copy[l].role}</dd>
                  <dt>{say(l, "会話の言語", "Language")}</dt>
                  <dd>{s.language === "ja" ? "日本語" : "English"}</dd>
                  <dt>{say(l, "必要な回答", "Needed")}</dt>
                  <dd>
                    {say(
                      l,
                      "質問への回答、または確認できなかった理由。",
                      "An answer, or why it could not be confirmed.",
                    )}
                  </dd>
                </dl>
                <details open>
                  <summary>
                    {say(l, "これまでの会話", "Conversation context")}
                  </summary>
                  <div className="operator-context">
                    {s.messages
                      .filter((m) => m.role === "user")
                      .map((m) => (
                        <p key={m.id}>{m.text}</p>
                      ))}
                  </div>
                </details>
                <div className="operator-actions">
                  {(task.status === "created" || task.status === "ringing") && (
                    <>
                      <button
                        className="button primary"
                        onClick={() => update("accepted")}
                      >
                        {say(l, "引き受ける", "Accept request")}
                        <Icon name="arrow" />
                      </button>
                      {task.status === "created" && (
                        <button
                          className="button secondary"
                          onClick={() => update("ringing")}
                        >
                          {say(l, "呼出し状態を試す", "Simulate ringing")}
                        </button>
                      )}
                    </>
                  )}
                  {task.status === "accepted" && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        update("completed");
                      }}
                    >
                      <label htmlFor="answer">
                        {say(l, "回答・実施内容", "Answer / work completed")}
                      </label>
                      <textarea
                        id="answer"
                        rows={5}
                        required
                        maxLength={4000}
                        placeholder={say(
                          l,
                          "応募者への回答を入力してください。",
                          "Enter your answer for the applicant.",
                        )}
                        value={answer}
                        onChange={(e) => setAnswer(e.target.value)}
                      />
                      <button
                        type="submit"
                        className="button primary full"
                        disabled={!answer.trim()}
                      >
                        {say(l, "結果を報告", "Send result")}
                        <Icon name="send" />
                      </button>
                    </form>
                  )}
                  {!["completed", "cancelled", "unanswered"].includes(
                    task.status,
                  ) && (
                    <button
                      className="text-button"
                      onClick={() => update("unanswered")}
                    >
                      {say(l, "対応できない・応答なし", "Unable to respond")}
                    </button>
                  )}
                  {task.status === "completed" && (
                    <div className="answer">
                      <strong>
                        {say(
                          l,
                          "会話画面へ反映済み",
                          "Delivered to the conversation",
                        )}
                      </strong>
                      <p>{task.answer}</p>
                    </div>
                  )}
                  {["unanswered", "cancelled"].includes(task.status) && (
                    <p>
                      {say(
                        l,
                        "この依頼は終了しました。",
                        "This request is closed.",
                      )}
                    </p>
                  )}
                </div>
                <p className="small">
                  {say(
                    l,
                    "同じブラウザの別タブへ反映します。黒電話の実機・音声通話は未接続です。",
                    "Updates are shared across tabs in this browser. Phone hardware and voice calls are not connected.",
                  )}
                </p>
              </div>
            </>
          ) : (
            <div className="empty-state detail-empty">
              <Icon name="person" size={40} />
              <h2>
                {say(
                  l,
                  "必要なときに、人の力を。",
                  "A person, when it matters.",
                )}
              </h2>
              <p>
                {say(
                  l,
                  "届いた依頼を選ぶと、会話の背景と回答欄を確認できます。",
                  "Select a request to see its context and send an answer.",
                )}
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
