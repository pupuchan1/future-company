import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, SAMPLE, STORAGE_KEY, submit, startCorrection, createAgenda, propose } from '../dist/experience/model.js';
const documentEvents = {}, windowEvents = {}, elements = new Map();
function element(selector) { if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', open: false, disabled: false, classList: { add(){}, remove(){}, toggle(){} }, focus(){}, addEventListener(name, fn){ this[name] = fn; }, showModal(){ this.open = true; }, close(){ this.open = false; } }); return elements.get(selector); }
globalThis.document = { querySelector: element, querySelectorAll: () => [], addEventListener: (name, fn) => documentEvents[name] = fn };
globalThis.window = { addEventListener: (name, fn) => windowEvents[name] = fn, scrollTo(){} };
globalThis.location = { hash: '#candidate/welcome' };
let saved = null;
globalThis.localStorage = { getItem: () => saved, setItem: (key, value) => { saved = value; } };
await import('../dist/experience/app.js');
function load(state, hash) { saved = JSON.stringify(state); location.hash = hash; windowEvents.storage({ key: STORAGE_KEY, newValue: saved }); return element('#app').innerHTML; }
function click(action, extra = {}) { documentEvents.click({ target: { closest: () => ({ dataset: { action, ...extra }, disabled: false }) } }); }
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
  assert.match(html, /data-action="request-proposal" disabled/); assert.match(html, /提出版が更新/); assert.match(html, /NEW-QUESTION/);
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
