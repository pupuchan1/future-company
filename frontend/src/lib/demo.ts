export type Language = "ja" | "en";
export type TaskStatus =
  | "created"
  | "ringing"
  | "accepted"
  | "completed"
  | "unanswered"
  | "cancelled";
export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  at: string;
};
export type HumanTask = {
  id: string;
  question: string;
  status: TaskStatus;
  answer: string;
  createdAt: string;
  history: TaskStatus[];
};
export type Session = {
  id: string;
  language: Language;
  agent: "reception" | "recruiting";
  messages: Message[];
  tasks: HumanTask[];
  experience: string[];
  ended: boolean;
  createdAt: string;
  revision: number;
};
const prefix = "future-company.demo.v1.";
export const say = (l: Language, ja: string, en: string) =>
  l === "ja" ? ja : en;
const message = (role: Message["role"], text: string): Message => ({
  id: crypto.randomUUID(),
  role,
  text,
  at: new Date().toISOString(),
});
export const activeTask = (s: Session) =>
  s.tasks.find((t) => ["created", "ringing", "accepted"].includes(t.status));
export function createSession(language: Language, direct: boolean): Session {
  return {
    id: crypto.randomUUID(),
    language,
    agent: direct ? "recruiting" : "reception",
    messages: [
      message(
        "assistant",
        direct
          ? say(
              language,
              "採用担当です。ソフトウェアエンジニアの仕事についてご案内します。知りたいことや、これまでのご経験を教えてください。",
              "Welcome to recruiting. What would you like to know about the software engineer role? You can also share your experience.",
            )
          : say(
              language,
              "こんにちは。Future CompanyのAI受付です。採用のご相談を承っています。今日はどのようなことをお話ししましょうか。",
              "Hello, welcome to Future Company. I can help with recruitment enquiries. What would you like to discuss?",
            ),
      ),
    ],
    tasks: [],
    experience: [],
    ended: false,
    createdAt: new Date().toISOString(),
    revision: 0,
  };
}
// Deterministic prototype responses. Replace this boundary with backend events.
export function sendMessage(s: Session, text: string): Session {
  text = text.trim();
  if (!text || s.ended) return s;
  const language: Language = /[ぁ-んァ-ヶ一-龠]/u.test(text)
    ? "ja"
    : /[a-z]{3}/i.test(text)
      ? "en"
      : s.language;
  const next = {
    ...s,
    language,
    messages: [...s.messages, message("user", text)],
  };
  if (s.agent === "reception") {
    next.agent = "recruiting";
    next.messages.push(
      message(
        "system",
        say(
          language,
          "採用担当へ引き継ぎました。これまでのお話も共有済みです。",
          "You are now with recruiting. Your conversation has been shared.",
        ),
      ),
    );
    next.messages.push(
      message(
        "assistant",
        say(
          language,
          "採用担当です。募集はソフトウェアエンジニアです。仕事内容のご質問や、ご経験についてお聞かせください。現場への質問は「人に確認を依頼」から送れます。",
          "I am your recruiting assistant. Tell me about your experience or questions. Use “Ask a person” for questions for the team.",
        ),
      ),
    );
  } else {
    const isQuestion =
      /[?？]|教えて|知りたい|ですか|ますか|環境|what|how|can |could /i.test(
        text,
      );
    if (!isQuestion) next.experience = [...s.experience, text];
    next.messages.push(
      message(
        "assistant",
        isQuestion
          ? say(
              language,
              "ご質問を記録しました。募集の概要は情報パネルで確認できます。現場の情報は「人に確認を依頼」から担当者に確認できます。",
              "I have noted your question. See the role overview in the information panel, or select “Ask a person” for details from the team.",
            )
          : say(
              language,
              "お話を記録しました。ほかに伝えたいご経験や、仕事について確認したいことはありますか。",
              "I have noted what you shared. Is there any other experience or question you would like to discuss?",
            ),
      ),
    );
  }
  return next;
}
export function requestHuman(s: Session, question: string): Session {
  if (s.ended || activeTask(s) || !question.trim()) return s;
  const task: HumanTask = {
    id: crypto.randomUUID(),
    question: question.trim(),
    status: "created",
    history: ["created"],
    answer: "",
    createdAt: new Date().toISOString(),
  };
  return {
    ...s,
    tasks: [...s.tasks, task],
    messages: [
      ...s.messages,
      message(
        "system",
        say(
          s.language,
          "担当者への確認依頼を作成しました。回答はこの画面に届きます。",
          "Your request has been created. The answer will appear here.",
        ),
      ),
    ],
  };
}
export function updateTask(
  s: Session,
  id: string,
  status: TaskStatus,
  answer = "",
): Session {
  const task = s.tasks.find((t) => t.id === id);
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    created: ["ringing", "accepted", "unanswered", "cancelled"],
    ringing: ["accepted", "unanswered", "cancelled"],
    accepted: ["completed", "unanswered", "cancelled"],
    completed: [],
    unanswered: [],
    cancelled: [],
  };
  if (
    !task ||
    !allowed[task.status].includes(status) ||
    (status === "completed" && !answer.trim())
  )
    return s;
  const messages = [...s.messages];
  if (status === "completed")
    messages.push(
      message(
        "assistant",
        say(
          s.language,
          `担当者から回答が届きました。\n${answer.trim()}`,
          `The team has replied (original wording):\n${answer.trim()}`,
        ),
      ),
    );
  if (status === "unanswered")
    messages.push(
      message(
        "system",
        say(
          s.language,
          "担当者が応答できませんでした。再度依頼するか、結果画面で未解決事項を確認できます。",
          "The team could not respond. Send another request or review the unresolved question in your notes.",
        ),
      ),
    );
  if (status === "cancelled")
    messages.push(
      message(
        "system",
        say(
          s.language,
          "確認依頼を取り消しました。",
          "The request was cancelled.",
        ),
      ),
    );
  return {
    ...s,
    tasks: s.tasks.map((t) =>
      t.id === id
        ? {
            ...t,
            status,
            history: [...(t.history || [t.status]), status],
            answer: answer.trim(),
          }
        : t,
    ),
    messages,
  };
}
export function readSessions(): Session[] {
  const sessions: Session[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const v = JSON.parse(
        localStorage.getItem(key) || "null",
      ) as Session | null;
      if (
        v &&
        typeof v.id === "string" &&
        Array.isArray(v.messages) &&
        Array.isArray(v.tasks) &&
        Array.isArray(v.experience) &&
        typeof v.revision === "number"
      )
        sessions.push(v);
    } catch {
      /* Ignore malformed demo records. */
    }
  }
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function saveSession(s: Session) {
  localStorage.setItem(prefix + s.id, JSON.stringify(s));
  window.dispatchEvent(new Event("demo-update"));
}
export async function mutateSession(
  id: string,
  change: (s: Session) => Session,
) {
  const update = () => {
    const s = readSessions().find((s) => s.id === id);
    if (!s) throw new Error("Session not found");
    const next = change(s);
    if (next !== s) saveSession({ ...next, revision: s.revision + 1 });
  };
  if (navigator.locks) await navigator.locks.request(prefix + id, update);
  else update();
}
