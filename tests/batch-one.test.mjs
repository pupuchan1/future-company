import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState,SAMPLE,submit,startCorrection,createAgenda,propose,beginAgendaRevision,commitAgendaRevision,isStale,restore,addExperience,selectExperience,draftMatchesLatest,submissionDifferences,publishAnswer,answerDraft } from '../dist/experience/model.js';
import { WORK_SCENES } from '../dist/experience/work-scenes.js';
import { candidateQuestionProjection,companyQuestionProjection,createQuestionDraft,shareQuestion,questionAnswerDraft,setQuestionAnswerDraft,setQuestionInternalDraft,saveQuestionInternal,previewQuestionAnswer,publishQuestionAnswer,questionSummary,questionAnswerToken } from '../dist/experience/question-tracker.js';
import { candidateQuestionsView,answerPreviewView } from '../dist/experience/question-views.js';
const ready=()=>{const s=createState();s.draft.content={...SAMPLE};return s;};
const shared=()=>{const s=ready();submit(s);return s;};
function publish(s,id,patch={status:'answered',text:'公開する架空の回答',reason:'',eta:''}){setQuestionAnswerDraft(s,id,patch);const p=previewQuestionAnswer(s,id);assert.equal(p.ok,true);return publishQuestionAnswer(s,p.preview);}
test('three company scene descriptions and an explicit no-scene choice preserve immutable submission history',()=>{
 const s=ready();s.draft.sceneId=WORK_SCENES[2].id;s.draft.content.result='数字は非公開です。相手へ確認状況を伝えました。';submit(s);createAgenda(s);
 const original=structuredClone(s.submissions[0]);assert.equal(original.companyScene.title,'自分では答えられない時');
 startCorrection(s);s.draft.sceneId=null;assert.equal(draftMatchesLatest(s),false);assert.equal(submit(s).ok,true);
 assert.deepEqual(s.submissions[0],original);assert.equal(s.submissions[1].sceneId,null);assert.match(s.submissions[1].scenario,/結び付けは選んでいません/);assert.equal(isStale(s),true);
 assert.equal(submissionDifferences(original,s.submissions[1]).some(d=>d.key==='scene'),true);
});
test('additional question drafts stay out of company projection until explicit sharing, with experience-scoped IDs',()=>{
 const s=shared(),draft=createQuestionDraft(s,'PRIVATE-QUESTION-DRAFT');assert.equal(draft.ok,true);
 assert.equal(companyQuestionProjection(s).length,1);assert.equal(JSON.stringify(companyQuestionProjection(s)).includes('PRIVATE-QUESTION-DRAFT'),false);
 assert.equal(shareQuestion(s,draft.question.questionId),true);assert.equal(shareQuestion(s,draft.question.questionId),false);
 assert.equal(companyQuestionProjection(s).length,2);assert.equal(draft.question.experienceId,s.experienceId);assert.match(draft.question.questionId,/^experience-1-question-/);
});
test('internal checker, saved notes and drafts never enter candidate projection, preview or publication',()=>{
 const s=shared(),id=s.submissionQuestionId;
 setQuestionInternalDraft(s,id,{checkWith:'SECRET-CHECKER',internalNote:'SECRET-INTERNAL-NOTE'});assert.equal(saveQuestionInternal(s,id),true);
 setQuestionAnswerDraft(s,id,{status:'answered',text:'候補者へ公開する回答',reason:'',eta:'',internalNote:'SECRET-INJECTED'});
 s.questionAnswerDrafts[id].internalNote='SECRET-INJECTED';
 const preview=previewQuestionAnswer(s,id);assert.equal(preview.ok,true);assert.equal(JSON.stringify(preview).includes('SECRET'),false);assert.equal(answerPreviewView(preview.preview).includes('SECRET'),false);
 const result=publishQuestionAnswer(s,preview.preview);assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes('SECRET'),false);
 assert.equal(JSON.stringify(candidateQuestionProjection(s)).includes('SECRET'),false);assert.equal(candidateQuestionsView(s).includes('SECRET'),false);
 assert.equal(Object.hasOwn(result.publication,'internalNote'),false);assert.equal(s.questionInternals[id].internalNote,'SECRET-INTERNAL-NOTE');
});
test('public answer requires a current preview; edits, version changes and duplicate confirmations are rejected',()=>{
 const s=shared(),id=s.submissionQuestionId;setQuestionAnswerDraft(s,id,{status:'answered',text:'回答A'});const old=previewQuestionAnswer(s,id).preview;
 setQuestionAnswerDraft(s,id,{text:'回答B'});assert.equal(publishQuestionAnswer(s,old).ok,false);
 const current=previewQuestionAnswer(s,id).preview;setQuestionInternalDraft(s,id,{internalNote:'PRIVATE AFTER PREVIEW'});saveQuestionInternal(s,id);
 assert.equal(publishQuestionAnswer(s,current).ok,true);assert.equal(publishQuestionAnswer(s,current).ok,false);assert.equal(s.questionPublications.length,1);
 const snapshot=structuredClone(s.questionPublications);startCorrection(s);s.draft.content.question='変更した質問';submit(s);
 assert.equal(publishQuestionAnswer(s,current).ok,false);assert.deepEqual(s.questionPublications,snapshot);
 const q=candidateQuestionProjection(s)[0];assert.equal(q.answer,null);assert.equal(q.previousAnswer.text,'回答B');assert.equal(q.previousAnswer.sourceVersion,1);
});
test('checking permits an unknown deadline and keeps independent answers for multiple questions',()=>{
 const s=shared(),first=s.submissionQuestionId;const second=createQuestionDraft(s,'勤務の相談方法は？').question.questionId;shareQuestion(s,second);
 assert.equal(publish(s,first,{status:'checking',text:'',reason:'架空の研修担当へ確認しています',eta:''}).ok,true);
 assert.equal(publish(s,second).ok,true);const q=candidateQuestionProjection(s);
 assert.equal(q[0].answer.status,'checking');assert.equal(q[0].answer.eta,'');assert.equal(q[1].answer.status,'answered');assert.match(candidateQuestionsView(s),/確認の目安：未定/);
});
test('sharing another question stales the agenda at the same submission version and cannot silently reuse a prior review',()=>{
 const s=shared();createAgenda(s);propose(s);const original=structuredClone(s.proposals);
 const id=createQuestionDraft(s,'追加した質問').question.questionId;shareQuestion(s,id);assert.equal(s.submissions.length,1);assert.equal(isStale(s),true);assert.equal(propose(s).ok,false);
 beginAgendaRevision(s);s.agendaDraft.consistencyNote='追加した質問も同じ議題で聞くと人事が確認';s.agendaDraft.reuseConfirmed=true;
 const third=createQuestionDraft(s,'さらに確認したい質問').question.questionId;shareQuestion(s,third);assert.equal(commitAgendaRevision(s,true),false);
 beginAgendaRevision(s);s.agendaDraft.focus='共有された3つの質問と具体例を一緒に確認する';assert.equal(commitAgendaRevision(s,true),true);
 assert.equal(s.agenda.candidateQuestion,questionSummary(s));assert.match(s.agenda.candidateQuestion,/追加した質問/);assert.equal(propose(s).ok,true);assert.deepEqual(s.proposals[0],original[0]);
});
test('v8 migration retains old submissions, answers, proposals and private agenda notes',()=>{
 const s=ready();submit(s);createAgenda(s);s.agenda.notes='PRIVATE-LEGACY-AGENDA';Object.assign(answerDraft(s),{status:'answered',text:'v8の公開回答'});publishAnswer(s);propose(s);
 const raw=structuredClone(s);for(const key of ['questionTrackerVersion','questions','submissionQuestionId','nextQuestionId','questionComposer','questionInternals','questionInternalDrafts','questionAnswerDrafts','questionPublications'])delete raw[key];
 const old={submissions:structuredClone(raw.submissions),answers:structuredClone(raw.answers),proposals:structuredClone(raw.proposals)};const restored=restore(JSON.stringify(raw));
 assert.deepEqual(restored.submissions,old.submissions);assert.deepEqual(restored.answers,old.answers);assert.deepEqual(restored.proposals,old.proposals);assert.equal(restored.agenda.notes,'PRIVATE-LEGACY-AGENDA');
 assert.equal(candidateQuestionProjection(restored)[0].answer.text,'v8の公開回答');assert.equal(candidateQuestionsView(restored).includes('PRIVATE-LEGACY-AGENDA'),false);
 assert.deepEqual(restore(JSON.stringify(restored)),restored);
});
test('question IDs, internal notes and public answers remain separated across experience switching and reload',()=>{
 const s=shared(),firstId=s.submissionQuestionId;setQuestionInternalDraft(s,firstId,{internalNote:'経験1の内部メモ'});saveQuestionInternal(s,firstId);publish(s,firstId,{status:'answered',text:'経験1への回答',reason:'',eta:''});const token=questionAnswerToken(s);
 const secondExperience=addExperience(s,'別の架空の経験');s.draft.content={...SAMPLE,title:'別の架空の経験'};submit(s);const secondId=s.submissionQuestionId;assert.notEqual(firstId,secondId);
 assert.equal(setQuestionAnswerDraft(s,firstId,{text:'WRONG EXPERIENCE'}),false);assert.equal(candidateQuestionProjection(s).length,1);assert.equal(candidateQuestionProjection(s)[0].answer,null);
 const restored=restore(JSON.stringify(s));selectExperience(restored,'experience-1');assert.equal(restored.questionInternals[firstId].internalNote,'経験1の内部メモ');assert.equal(questionAnswerToken(restored),token);
 selectExperience(restored,secondExperience);assert.equal(JSON.stringify(candidateQuestionProjection(restored)).includes('経験1への回答'),false);
});
