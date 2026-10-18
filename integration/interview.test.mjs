import assert from 'node:assert/strict';
import test from 'node:test';
import { requestedInterviewEnd } from './interview.mjs';
import { recordSpokenTurn, stableSpokenLanguage } from './case-state.mjs';

test('only an explicit interview end triggers the report', () => {
  for (const text of ['面接終了してください', '面談を終えてください。', 'Please end the interview.']) assert.equal(requestedInterviewEnd(text), true, text);
  for (const text of ['面接終了とはどういう意味ですか', '面接を終了しないでください', '「面接終了してください」という文言', "Don't end the interview", '今日はReactの開発について話します', '面接を終了してから何が起きますか？', 'Please explain how to end the interview.', '面接終了してください。でもまだ送らないでください。']) assert.equal(requestedInterviewEnd(text), false, text);
  for (const text of ["I don't want to end the interview.", 'The recruiter told me to end the interview.', '面接終了してくださいと言われました。']) assert.equal(requestedInterviewEnd(text), false, text);
  assert.equal(requestedInterviewEnd('面接を終了してください。今日お話しした内容を採用担当に共有してください。'), true);
});

test('language changes after three caller turns, not three streamed fragments', () => {
  const state = {};
  recordSpokenTurn(state, 'turn-1');
  assert.equal(stableSpokenLanguage(state, 'en', 'turn-1', 'ja'), 'ja');
  assert.equal(stableSpokenLanguage(state, 'en', 'turn-1', 'ja'), 'ja');
  assert.equal(stableSpokenLanguage(state, 'en', 'turn-1', 'ja'), 'ja');
  recordSpokenTurn(state, 'turn-2');
  assert.equal(stableSpokenLanguage(state, 'en', 'turn-2', 'ja'), 'ja');
  recordSpokenTurn(state, 'turn-3');
  assert.equal(stableSpokenLanguage(state, 'en', 'turn-3', 'ja'), 'en');
  recordSpokenTurn(state, 'turn-4');
  assert.equal(stableSpokenLanguage(state, 'ja', 'turn-4', 'en'), 'en');
  recordSpokenTurn(state, 'turn-5');
  assert.equal(stableSpokenLanguage(state, 'en', 'turn-5', 'en'), 'en');
  recordSpokenTurn(state, 'turn-6');
  assert.equal(stableSpokenLanguage(state, 'ja', 'turn-6', 'en'), 'en');
});

test('unclassified speech breaks the streak and a manual reset rejects late votes', () => {
  const state = {};
  recordSpokenTurn(state, 'en-1');
  stableSpokenLanguage(state, 'en', 'en-1', 'ja');
  recordSpokenTurn(state, 'unclassified-ja');
  recordSpokenTurn(state, 'en-2');
  stableSpokenLanguage(state, 'en', 'en-2', 'ja');
  recordSpokenTurn(state, 'en-3');
  assert.equal(stableSpokenLanguage(state, 'en', 'en-3', 'ja'), 'ja');
  state.languageVotes = [];
  assert.equal(stableSpokenLanguage(state, 'en', 'en-3', 'ja'), 'ja');
  assert.deepEqual(state.languageVotes, []);
});
