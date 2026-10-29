import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, SAMPLE, STORAGE_KEY, submit, startCorrection, createAgenda, propose } from '../dist/experience/model.js';
import { setJobField,saveJobDraft,previewJob,publishJob,saveFieldProposal } from '../dist/experience/job-settings.js';
const documentEvents = {}, windowEvents = {}, elements = new Map();
function element(selector) { if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', open: false, disabled: false, classList: { add(){}, remove(){}, toggle(){} }, focus(){}, addEventListener(name, fn){ this[name] = fn; }, showModal(){ this.open = true; }, close(){ this.open = false; } }); return elements.get(selector); }
globalThis.document = { querySelector: element, querySelectorAll: () => [], addEventListener: (name, fn) => documentEvents[name] = fn };
globalThis.window = { addEventListener: (name, fn) => windowEvents[name] = fn, scrollTo(){} };
globalThis.location = { hash: '#candidate/welcome' };
let saved = null, writes = 0;
globalThis.localStorage = { getItem: () => saved, setItem: (key, value) => { saved = value; writes++; } };
await import('../dist/experience/app.js');
function load(state, hash) { saved = JSON.stringify(state); location.hash = hash; windowEvents.storage({ key: STORAGE_KEY, newValue: saved }); return element('#app').innerHTML; }
function click(action, extra = {}) { documentEvents.click({ target: { closest: () => ({ dataset: { action, ...extra }, disabled: false }) } }); }

test('company publication UI requires saved preview and explicit confirmation; cancel leaves candidate display unchanged',()=>{
 const s=createState();s.draft.content={...SAMPLE};submit(s);setJobField(s,'title','REVIEWED-NEW-JOB');setJobField(s,'changeReason','PUBLIC-REASON');
 load(s,'#company/recruiter');click('save-job-draft');let stored=JSON.parse(saved);assert.equal(stored.companyJob.published.length,1);
 const candidateBefore=load(stored,'#candidate/submitted');assert.equal(candidateBefore.includes('REVIEWED-NEW-JOB'),false);
 load(stored,'#company/recruiter');click('preview-job');assert.equal(element('#confirmation').open,true);assert.match(element('#modal-body').innerHTML,/REVIEWED-NEW-JOB/);assert.match(element('#modal-confirm').textContent,/候補者へ公開/);element('#modal-cancel').click();assert.equal(JSON.parse(saved).companyJob.published.length,1);
 click('preview-job');element('#modal-confirm').click();element('#modal-confirm').click();stored=JSON.parse(saved);assert.equal(stored.companyJob.published.length,2);const html=load(stored,'#candidate/submitted');assert.match(html,/REVIEWED-NEW-JOB/);assert.match(html,/提出時と現在の違い/);assert.match(html,/data-action="job-response" data-choice="question"/);assert.equal(stored.submissionJobSnapshots[1].version,1);
});
test('field-role internal proposal never appears in candidate render before B explicitly publishes',()=>{
 const s=createState();s.companyJob.fieldEditor={reason:'FIELD-PRIVATE-REASON',question:'FIELD-PRIVATE-QUESTION'};saveFieldProposal(s);
 assert.match(load(s,'#company/field'),/FIELD-PRIVATE-QUESTION/);assert.match(load(s,'#company/recruiter'),/FIELD-PRIVATE-QUESTION/);
 assert.equal(load(s,'#candidate/welcome').includes('FIELD-PRIVATE'),false);assert.equal(load(s,'#recruiter').includes('FIELD-PRIVATE'),false);
});
test('recruiter render never contains private candidate draft or private correction', () => {
  const state = createState(); state.draft.content = { ...SAMPLE, action: 'PRIVATE-DRAFT-UNSENT' };
  assert.equal(load(state, '#recruiter').includes('PRIVATE-DRAFT-UNSENT'), false);
  state.draft.content = { ...SAMPLE }; submit(state); startCorrection(state); state.draft.content.action = 'PRIVATE-CORRECTION-UNSENT';
  const html = load(state, '#recruiter'); assert.equal(html.includes('PRIVATE-CORRECTION-UNSENT'), false); assert.equal(html.includes(SAMPLE.action), true);
});
test('stale recruiter renders disabled send, source version and differences; candidate agenda excludes notes', () => {
  const state = createState(); state.draft.content = { ...SAMPLE }; submit(state); createAgenda(state); state.agenda.notes = 'RECRUITER-PRIVATE-NOTE'; propose(state);
  startCorrection(state); state.draft.content.question = 'NEW-QUESTION'; submit(state);
  const html = load(state, '#recruiter');
  assert.match(html, /data-action="request-proposal" disabled/); assert.match(html, /議題の文面を見直すまで提案できません/); assert.match(html, /NEW-QUESTION/);
  const candidate = load(state, '#candidate/submitted'); assert.equal(candidate.includes('RECRUITER-PRIVATE-NOTE'), false); assert.equal(candidate.includes('訂正前の議題'), true);
});
test('submission cancel keeps draft and single confirmation records one version despite double clicks', () => {
  const state = createState(); state.draft.content = { ...SAMPLE }; state.screen = 'review';
  load(state, '#candidate/review'); click('request-submit'); assert.equal(element('#confirmation').open, true);
  element('#modal-cancel').click(); assert.equal(JSON.parse(saved).submissions.length, 0); assert.deepEqual(JSON.parse(saved).draft.content, SAMPLE);
  click('request-submit'); element('#modal-confirm').click(); element('#modal-confirm').click();
  assert.equal(JSON.parse(saved).submissions.length, 1); assert.equal(JSON.parse(saved).draft, null);
});
test('back navigation preserves interview answers; entered HTML is rendered as text', () => {
  const state = createState(); state.draft.content = { ...SAMPLE, situation: '<script>bad()</script>' }; state.screen = 'interview'; state.interviewIndex = 2;
  load(state, '#candidate/interview/2'); location.hash = '#candidate/interview/0'; windowEvents.hashchange();
  assert.equal(JSON.parse(saved).draft.content.situation, '<script>bad()</script>'); assert.match(element('#app').innerHTML, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});
test('agenda revision UI retains old source until actual wording is edited and confirmed', () => {
  const state=createState(); state.draft.content={...SAMPLE}; submit(state); createAgenda(state); state.agenda.notes='NOTE TO KEEP';
  startCorrection(state); state.draft.content.action='訂正した行動'; submit(state); load(state,'#recruiter');
  click('update-agenda'); assert.equal(JSON.parse(saved).agenda.sourceVersion,1); assert.match(element('#app').innerHTML,/agenda-revision-focus/);
  documentEvents.change({target:{id:'changes-reviewed',checked:true,dataset:{}}}); click('commit-agenda');
  assert.equal(JSON.parse(saved).agenda.sourceVersion,1);
  documentEvents.input({target:{dataset:{agendaDraft:'focus'},value:'訂正後の行動について確認する新しい議題'}});
  documentEvents.change({target:{id:'changes-reviewed',checked:true,dataset:{}}});
  click('commit-agenda'); const updated=JSON.parse(saved);
  assert.equal(updated.agenda.sourceVersion,2); assert.equal(updated.agenda.focus,'訂正後の行動について確認する新しい議題');
  assert.equal(updated.agenda.notes,'NOTE TO KEEP'); assert.match(element('#app').innerHTML,/人事が照合して保存した内容/);
});
test('new experience URL and entry preserve the submitted experience rather than silently redirecting', () => {
  const state=createState(); state.draft.content={...SAMPLE}; submit(state); createAgenda(state); propose(state);
  load(state,'#candidate/new'); assert.match(element('#app').innerHTML,/data-choice="own"/);
  click('choose',{choice:'own'}); const added=JSON.parse(saved);
  assert.equal(added.experienceId,'experience-2'); assert.equal(added.submissions.length,0); assert.equal(added.otherExperiences[0].submissions.length,1);
  click('select-experience',{id:'experience-1'}); windowEvents.hashchange(); const selected=JSON.parse(saved);
  assert.equal(selected.experienceId,'experience-1'); assert.equal(selected.proposals.length,1); assert.equal(selected.otherExperiences[0].experienceId,'experience-2');
});
test('storage event rendering does not write back and create a cross-tab update loop', () => {
  const state=createState(); state.draft.content={...SAMPLE}; submit(state);
  writes=0; load(state,'#recruiter'); assert.equal(writes,0);
});
test('save guidance tracks readiness and never retains the obsolete unchanged-text prohibition', () => {
  const state=createState(); state.draft.content={...SAMPLE}; submit(state); createAgenda(state);
  startCorrection(state); state.draft.content.question='最新の質問'; submit(state); load(state,'#recruiter'); click('update-agenda');
  assert.equal(element('#app').innerHTML.includes('以前と同じ議題文のままでは保存できません'),false);
  documentEvents.input({target:{dataset:{agendaDraft:'focus'},value:'新しい訂正内容を確認する議題'}});
  assert.equal(element('[data-action="commit-agenda"]').disabled,true);
  documentEvents.change({target:{id:'changes-reviewed',checked:true,dataset:{}}});
  assert.equal(element('[data-action="commit-agenda"]').disabled,false); assert.match(element('#agenda-revision-status').textContent,/保存できます/);
  documentEvents.input({target:{dataset:{agendaDraft:'focus'},value:state.agenda.focus}});
  assert.equal(element('[data-action="commit-agenda"]').disabled,true); assert.match(element('#agenda-reuse-feedback').innerHTML,/過去に使った本文と一致/);
  assert.match(element('#agenda-revision-status').textContent,/理由の記入と再利用の確認/);
});
test('reuse confirmation UI requires rationale and both checks and resets them after text edits', () => {
  const state=createState(); state.draft.content={...SAMPLE}; submit(state); createAgenda(state); propose(state);
  startCorrection(state); state.draft.content.question='今回の訂正'; submit(state); load(state,'#recruiter'); click('update-agenda');
  documentEvents.input({target:{dataset:{agendaDraft:'consistencyNote'},value:'今回の訂正を照合し、議題の範囲は同じと確認した理由'}});
  documentEvents.change({target:{id:'reuse-confirmed',checked:true,dataset:{}}});
  assert.equal(element('[data-action="commit-agenda"]').disabled,true);
  documentEvents.change({target:{id:'changes-reviewed',checked:true,dataset:{}}});
  assert.equal(element('[data-action="commit-agenda"]').disabled,false);
  documentEvents.input({target:{dataset:{agendaDraft:'focus'},value:state.agenda.focus+' '}});
  assert.equal(element('[data-action="commit-agenda"]').disabled,true); assert.equal(element('#changes-reviewed').checked,false); assert.equal(element('#reuse-confirmed').checked,false);
  documentEvents.change({target:{id:'reuse-confirmed',checked:true,dataset:{}}}); documentEvents.change({target:{id:'changes-reviewed',checked:true,dataset:{}}}); click('commit-agenda');
  assert.match(element('#app').innerHTML,/同じ本文を使う整合確認の記録/);
  assert.match(element('#app').innerHTML,/今回の訂正を照合し、議題の範囲は同じと確認した理由/);
  const savedState=JSON.parse(saved); const candidate=load(savedState,'#candidate/submitted');
  assert.equal(candidate.includes('今回の訂正を照合し、議題の範囲は同じと確認した理由'),false);
});
