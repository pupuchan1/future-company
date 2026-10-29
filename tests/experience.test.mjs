import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, SAMPLE, submit, startCorrection, cancelCorrection, createAgenda, propose, respond, isStale, restore, latest, answerDraft, publishAnswer, latestAnswer, decide, beginAgendaRevision, canCommitAgendaRevision, commitAgendaRevision, addExperience, selectExperience, experienceList, agendaReuseMatches } from '../dist/experience/model.js';
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
  assert.equal(respond(state, 1, 'accepted'), false); assert.equal(createAgenda(state, true), false);
  beginAgendaRevision(state); state.agendaDraft.focus = '訂正した質問を踏まえて、相談窓口と対応範囲を確認する'; assert.equal(commitAgendaRevision(state,true), true);
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
test('a changed version cannot be relabeled without a recorded consistency review', () => {
  const state = ready(); submit(state); createAgenda(state); const focus = state.agenda.focus;
  startCorrection(state); state.draft.content.action = '店長ではなく勤務リーダーと代替品を相談した'; submit(state);
  beginAgendaRevision(state); assert.equal(state.agenda.sourceVersion, 1); assert.equal(propose(state).ok,false);
  assert.equal(canCommitAgendaRevision(state,true),false); assert.equal(commitAgendaRevision(state,true),false);
  state.agendaDraft.focus = '勤務リーダーに相談した理由と、代替品を選んだ過程を聞く';
  assert.equal(commitAgendaRevision(state,false),false); assert.equal(commitAgendaRevision(state,true),true);
  assert.equal(state.agenda.sourceVersion,2); assert.notEqual(state.agenda.focus,focus);
  assert.equal(state.agendaReview.before,focus); assert.equal(state.agendaReview.after,state.agenda.focus);
  assert.equal(state.proposals.length,0);
});
test('answer publication and agenda editing do not consume proposal sequence numbers', () => {
  const state = ready(); submit(state); createAgenda(state); assert.equal(propose(state).proposal.sequence,1);
  Object.assign(answerDraft(state),{status:'checking',reason:'担当者に確認中'}); publishAnswer(state);
  Object.assign(answerDraft(state),{status:'answered',text:'先輩に相談できます'}); publishAnswer(state);
  startCorrection(state); state.draft.content.question = '夜間の相談先は？'; submit(state); beginAgendaRevision(state);
  state.agendaDraft.focus = '夜間の相談先を確認する'; commitAgendaRevision(state,true);
  const result = propose(state); assert.equal(result.proposal.sequence,2); assert.equal(result.proposal.id,2);
  assert.equal(propose(state).ok,false); assert.equal(state.proposals.length,2);
});
test('multiple experiences retain independent drafts, versions, agendas, answers and proposal histories', () => {
  const state = ready(); submit(state); createAgenda(state); propose(state);
  Object.assign(answerDraft(state),{status:'answered',text:'経験1への回答'}); publishAnswer(state);
  startCorrection(state); state.draft.content.result = '経験1の非公開訂正';
  const first = structuredClone(state); const secondId=addExperience(state,'サークルの案内対応（架空）');
  assert.equal(state.submissions.length,0); assert.equal(state.agenda,null); assert.equal(state.answers.length,0);
  state.draft.content={...SAMPLE,title:'サークルの案内対応（架空）',question:'経験2の質問'}; submit(state); createAgenda(state); propose(state);
  assert.equal(latest(state).version,1); assert.equal(state.proposals[0].sequence,1);
  assert.equal(selectExperience(state,first.experienceId),true); assert.equal(state.draft.content.result,'経験1の非公開訂正');
  assert.deepEqual(state.submissions,first.submissions); assert.deepEqual(state.proposals,first.proposals); assert.deepEqual(state.answers,first.answers);
  const restored=restore(JSON.stringify(state)); selectExperience(restored,secondId);
  assert.equal(latest(restored).content.question,'経験2の質問'); assert.equal(restored.proposals.length,1);
  assert.equal(experienceList(restored,true).length,2);
});
test('recruiter experience choices exclude private drafts and use submitted titles only', () => {
  const state=ready(); submit(state); startCorrection(state); state.draft.content.title='PRIVATE CORRECTION TITLE';
  addExperience(state,'PRIVATE SECOND DRAFT');
  const choices=experienceList(state,true); assert.equal(choices.length,1); assert.equal(choices[0].title,SAMPLE.title);
  assert.equal(JSON.stringify(choices).includes('PRIVATE'),false);
});
test('legacy skipped proposal IDs keep their identity but migrate to sequential display numbers', () => {
  const state=ready(); submit(state); createAgenda(state); propose(state); state.agenda.focus+='別の議題'; propose(state);
  state.proposals[1].id=4; delete state.proposals[0].sequence; delete state.proposals[1].sequence;
  const restored=restore(JSON.stringify(state)); assert.deepEqual(restored.proposals.map(p=>p.id),[1,4]);
  assert.deepEqual(restored.proposals.map(p=>p.sequence),[1,2]); assert.deepEqual(restored.submissions,state.submissions);
});
test('legacy agenda already relabeled to the latest version still requires a wording review', () => {
  const state=ready(); submit(state); createAgenda(state); startCorrection(state); state.draft.content.action='訂正した行動'; submit(state);
  state.agenda.sourceVersion=2; delete state.agenda.reviewedVersion;
  const restored=restore(JSON.stringify(state)); assert.equal(isStale(restored),true); assert.equal(propose(restored).ok,false);
  beginAgendaRevision(restored); assert.equal(commitAgendaRevision(restored,true),false);
  restored.agendaDraft.focus='訂正した行動について確認する議題'; assert.equal(commitAgendaRevision(restored,true),true); assert.equal(isStale(restored),false);
});
test('returning to an older proposal requires a recorded reuse rationale and explicit consistency checks', () => {
  const state=ready(); submit(state); createAgenda(state); const oldFocus=state.agenda.focus; propose(state);
  startCorrection(state); state.draft.content.action='訂正した行動'; submit(state); beginAgendaRevision(state);
  state.agendaDraft.focus='訂正した行動を前提に確認する'; commitAgendaRevision(state,true); propose(state);
  const immutable=structuredClone(state.proposals);
  startCorrection(state); state.draft.content.question='訂正した質問'; submit(state); beginAgendaRevision(state);
  state.agendaDraft.focus=oldFocus; assert.deepEqual(agendaReuseMatches(state),['提案 1（v1）']);
  assert.equal(commitAgendaRevision(state,true),false);
  state.agendaDraft.consistencyNote='訂正した行動と質問を照合し、対応判断を聞く議題として同じ本文を使う理由を人事が記録';
  assert.equal(commitAgendaRevision(state,true),false); state.agendaDraft.reuseConfirmed=true;
  assert.equal(commitAgendaRevision(state,false),false); assert.equal(commitAgendaRevision(state,true),true);
  assert.deepEqual(state.proposals,immutable); assert.equal(state.agendaReview.reuseMatches[0],'提案 1（v1）');
  assert.match(state.agendaReview.reuseRationale,/人事が記録/); assert.equal(propose(state).proposal.sequence,3);
  assert.equal(JSON.stringify(state.proposals.at(-1)).includes('人事が記録'),false);
});
test('unchanged text can be deliberately reused without arbitrary character changes after human review', () => {
  const state=ready(); submit(state); createAgenda(state); const focus=state.agenda.focus;
  startCorrection(state); state.draft.content.question='確認する質問だけを訂正'; submit(state); beginAgendaRevision(state);
  assert.equal(canCommitAgendaRevision(state,true),false);
  state.agendaDraft.consistencyNote='質問の訂正は反映され、議題の範囲には変更がないと確認したため同じ本文を使う';
  state.agendaDraft.reuseConfirmed=true; assert.equal(commitAgendaRevision(state,true),true);
  assert.equal(state.agenda.focus,focus); assert.equal(state.agenda.sourceVersion,2);
});
test('whitespace and width-only differences still match previously used agenda text', () => {
  const state=ready(); submit(state); createAgenda(state); propose(state);
  startCorrection(state); state.draft.content.action+='訂正'; submit(state); beginAgendaRevision(state);
  state.agendaDraft.focus=' \n'+state.agenda.focus+'　'; assert.equal(agendaReuseMatches(state).length,2);
  assert.equal(canCommitAgendaRevision(state,true),false);
});
test('reuse review cannot be committed against a newer submission than the reviewed draft', () => {
  const state=ready(); submit(state); createAgenda(state); startCorrection(state); state.draft.content.question='質問2'; submit(state); beginAgendaRevision(state);
  state.agendaDraft.consistencyNote='今回の訂正と整合する理由'; state.agendaDraft.reuseConfirmed=true;
  assert.equal(canCommitAgendaRevision(state,true),true);
  startCorrection(state); state.draft.content.question='質問3'; submit(state);
  assert.equal(commitAgendaRevision(state,true),false); beginAgendaRevision(state);
  assert.equal(state.agendaDraft.reuseConfirmed,false); assert.equal(state.agendaDraft.consistencyNote,'');
});
test('a legacy v7 agenda already saved using an older proposal requires the new reuse review', () => {
  const state=ready(); submit(state); createAgenda(state); propose(state);
  startCorrection(state); state.draft.content.question='訂正した質問'; submit(state);
  state.agenda.sourceVersion=2; state.agenda.reviewedVersion=2; delete state.agenda.reusePolicy;
  const restored=restore(JSON.stringify(state)); assert.equal(isStale(restored),true); assert.equal(propose(restored).ok,false);
  beginAgendaRevision(restored); restored.agendaDraft.consistencyNote='今回の訂正と同じ議題の整合を改めて確認した理由'; restored.agendaDraft.reuseConfirmed=true;
  assert.equal(commitAgendaRevision(restored,true),true); assert.equal(isStale(restored),false);
});
