import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeTask,
  createSession,
  requestHuman,
  sendMessage,
  updateTask,
} from "../src/lib/demo.ts";

test("reception hands off with transcript and detected language intact", () => {
  const first = createSession("ja", false);
  const next = sendMessage(first, "Tell me about the engineering role");
  assert.equal(next.agent, "recruiting");
  assert.equal(next.language, "en");
  assert.equal(next.messages[0].id, first.messages[0].id);
  assert.ok(
    next.messages.some((m) => m.role === "system" && m.text.includes("shared")),
  );
  assert.equal(first.messages.length, 1);
});
test("request → accept → answer returns the exact human result once", () => {
  let s = requestHuman(createSession("ja", true), "開発環境を教えてください");
  const id = s.tasks[0].id;
  s = updateTask(s, id, "accepted");
  s = updateTask(s, id, "completed", "ReactとTypeScriptです。");
  assert.equal(activeTask(s), undefined);
  assert.equal(s.tasks[0].answer, "ReactとTypeScriptです。");
  assert.deepEqual(s.tasks[0].history, ["created", "accepted", "completed"]);
  assert.ok(s.messages.at(-1)?.text.includes("ReactとTypeScriptです。"));
  assert.equal(updateTask(s, id, "completed", "二重回答"), s);
});
test("blank answers, premature completion and duplicate active requests are rejected", () => {
  const s = requestHuman(createSession("ja", true), "質問");
  assert.equal(requestHuman(s, "別の質問"), s);
  assert.equal(updateTask(s, s.tasks[0].id, "completed", "回答"), s);
  const accepted = updateTask(s, s.tasks[0].id, "accepted");
  assert.equal(
    updateTask(accepted, s.tasks[0].id, "completed", "  "),
    accepted,
  );
});
test("cancelled requests cannot be revived by a stale operator action", () => {
  const s = requestHuman(createSession("ja", true), "質問");
  const cancelled = updateTask(s, s.tasks[0].id, "cancelled");
  assert.equal(updateTask(cancelled, s.tasks[0].id, "accepted"), cancelled);
  assert.equal(activeTask(cancelled), undefined);
  assert.equal(requestHuman(cancelled, "再依頼").tasks.length, 2);
});
test("ending blocks new messages and requests while a pending result can still arrive", () => {
  let s = requestHuman(createSession("en", true), "Question");
  s = updateTask(s, s.tasks[0].id, "accepted");
  s = { ...s, ended: true };
  assert.equal(sendMessage(s, "Hello"), s);
  assert.equal(requestHuman(s, "More"), s);
  const result = updateTask(s, s.tasks[0].id, "completed", "Human answer");
  assert.equal(result.ended, true);
  assert.equal(result.tasks[0].status, "completed");
});
test("experience is self reported, and no response is preserved as unresolved", () => {
  let s = sendMessage(createSession("ja", true), "Reactで3年開発しています");
  assert.deepEqual(s.experience, ["Reactで3年開発しています"]);
  s = requestHuman(s, "チーム体制を教えてください");
  s = updateTask(s, s.tasks[0].id, "unanswered");
  assert.equal(s.tasks[0].status, "unanswered");
  assert.equal(s.tasks[0].answer, "");
  assert.ok(s.messages.at(-1)?.text.includes("応答できません"));
});
