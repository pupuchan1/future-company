import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, SAMPLE, submit, startCorrection, cancelCorrection, createAgenda, propose, respond, isStale, restore, latest, answerDraft, publishAnswer, latestAnswer, decide } from '../dist/experience/model.js';
const ready = () => { const state = createState(); state.draft.content = { ...SAMPLE }; return state; };
test('draft stays private; explicit submission freezes a copy and rejects repeat clicks', () => {
  const state = ready(); assert.equal(state.submissions.length, 0); assert.equal(createAgenda(state), false);
  const oldDraft = state.draft; assert.equal(submit(state).ok, true); oldDraft.content.action = 'changed';
  assert.equal(latest(state).content.action, SAMPLE.action); assert.equal(submit(state).ok, false); assert.equal(state.submissions.length, 1);
});
test('incomplete submission fails; malformed storage recovers safely', () => {
  assert.equal(submit(createState()).ok, false); assert.deepEqual(restore('{bad'), createState());
  const state = ready(); state.draft.content.question = ''; assert.equal(submit(state).ok, false);
});
test('correction is private and cancellation retains v1 and recruiter notes', () => {
  const state = ready(); submit(state); createAgenda(state); state.agenda.notes = '聞きたい観点';
  startCorrection(state); state.draft.content.action = 'private correction';
  assert.equal(latest(state).content.action, SAMPLE.action); assert.equal(isStale(state), false);
  cancelCorrection(state); assert.equal(state.submissions.length, 1); assert.equal(state.agenda.notes, '聞きたい観点');
});
test('v2 freezes v1, stales old agenda; update requires review and preserves notes; no auto resend', () => {
  const state = ready(); submit(state); createAgenda(state); state.agenda.notes = '人事が書いたメモ'; propose(state);
  const oldProposal = structuredClone(state.proposals[0]); startCorrection(state); state.draft.content.question = '訂正した質問'; submit(state);
  assert.equal(state.submissions[0].content.question, SAMPLE.question); assert.equal(isStale(state), true);
  assert.equal(propose(state).ok, false); assert.equal(createAgenda(state), false); assert.equal(state.proposals.length, 1);
  assert.equal(respond(state, 1, 'accepted'), false); assert.equal(createAgenda(state, true), true);
  assert.equal(state.agenda.notes, '人事が書いたメモ'); assert.equal(state.agenda.candidateQuestion, '訂正した質問');
  assert.deepEqual(state.proposals[0], oldProposal); assert.equal(state.proposals.length, 1); assert.equal(propose(state).ok, true);
  assert.equal(propose(state).ok, false); assert.equal(respond(state, 2, 'accepted'), true); assert.equal(respond(state, 2, 'accepted'), false);
});
test('draft survives reload; unchanged corrections do not create empty versions', () => {
  const state = ready(); state.screen = 'interview'; state.interviewIndex = 2;
  const restored = restore(JSON.stringify(state)); assert.deepEqual(restored, state);
  submit(restored); startCorrection(restored); assert.equal(submit(restored).ok, false);
  restored.draft.content.action += '追加'; submit(restored); assert.equal(latest(restored).version, 2);
});
test('private recruiter notes are never included in a proposal', () => {
  const state = ready(); submit(state); createAgenda(state); state.agenda.notes = 'PRIVATE'; propose(state);
  assert.equal(JSON.stringify(state.proposals).includes('PRIVATE'), false);
});
test('answers have explicit publication, status/reason, and version scope; waiting does not decline', () => {
  const state = ready(); submit(state); createAgenda(state); propose(state);
  const draft = answerDraft(state); draft.status = 'checking';
  assert.equal(latestAnswer(state), null); assert.equal(publishAnswer(state), false);
  draft.reason = 'チームの研修担当に相談しています'; draft.eta = '2026-10-30'; assert.equal(publishAnswer(state), true);
  assert.equal(publishAnswer(state), false); assert.equal(latestAnswer(state).status, 'checking');
  decide(state, 'wait'); assert.equal(state.decision.choice, 'wait'); assert.equal(state.proposals[0].response, 'pending');
  draft.status = 'answered'; draft.text = '初月は毎日先輩と問い合わせを振り返ります'; assert.equal(publishAnswer(state), true);
  assert.notEqual(state.decision.answerId, latestAnswer(state).id); decide(state, 'proceed'); assert.equal(state.decision.answerId, latestAnswer(state).id);
  startCorrection(state); state.draft.content.question = '別の質問'; submit(state); assert.equal(latestAnswer(state), null);
  assert.equal(answerDraft(state).status, 'unanswered'); assert.equal(state.answers.length, 2);
});
