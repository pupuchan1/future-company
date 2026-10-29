export const QUESTION_ANSWER_STATUSES = { unanswered: '未回答', answered: '回答あり', checking: '確認中', discuss_in_meeting: '面談で話したい' };
const clone = value => JSON.parse(JSON.stringify(value));
const latest = state => state.submissions.at(-1) ?? null;
const clean = value => typeof value === 'string' ? value.trim() : '';
export function emptyQuestionTracker() { return { questionTrackerVersion: 1, questions: [], submissionQuestionId: null, nextQuestionId: 1, questionComposer: '', questionInternals: {}, questionInternalDrafts: {}, questionAnswerDrafts: {}, questionPublications: [] }; }
function findQuestion(state,id) { return state.questions.find(q=>q.questionId===id && q.experienceId===state.experienceId); }
function makeQuestion(state,text,visibility,kind='additional',sourceVersion=latest(state)?.version) {
  const q={questionId:`${state.experienceId}-question-${state.nextQuestionId++}`,experienceId:state.experienceId,text:clean(text),visibility,kind,sourceVersion,revision:1,history:[]};
  q.history.push({sourceVersion,revision:1,text:q.text}); state.questions.push(q); return q;
}
export function syncSubmissionQuestion(state,entry) {
  let q=findQuestion(state,state.submissionQuestionId);
  if(!q){q=makeQuestion(state,entry.content.question,'shared_with_company','submission',entry.version);state.submissionQuestionId=q.questionId;}
  else { if(q.text!==entry.content.question){q.text=entry.content.question;q.revision++;} q.sourceVersion=entry.version;q.history.push({sourceVersion:entry.version,revision:q.revision,text:q.text}); }
  for(const other of state.questions) if(other.visibility==='shared_with_company' && other.questionId!==q.questionId){other.sourceVersion=entry.version;other.history.push({sourceVersion:entry.version,revision:other.revision,text:other.text});}
}
export function createQuestionDraft(state,text) {
  text=clean(text); if(!latest(state)||!text||text.length>4000||state.questions.some(q=>q.text===text)) return {ok:false,reason:'提出済みの経験に、重複しない質問を入力してください。'};
  const q=makeQuestion(state,text,'draft');state.questionComposer='';return {ok:true,question:clone(q)};
}
export function shareQuestion(state,id) { const q=findQuestion(state,id);if(!q||q.visibility!=='draft'||!latest(state))return false;q.visibility='shared_with_company';q.sourceVersion=latest(state).version;q.history=[{sourceVersion:q.sourceVersion,revision:q.revision,text:q.text}];return true; }
export function cancelQuestionDraft(state,id) { const q=findQuestion(state,id);if(!q||q.visibility!=='draft')return false;state.questions=state.questions.filter(item=>item!==q);return true; }
export function questionSummary(state) { const shared=state.questions.filter(q=>q.visibility==='shared_with_company');return shared.length===1?shared[0].text:shared.map((q,i)=>`質問${i+1}：${q.text}`).join('\n\n'); }
export function currentQuestionAnswer(state,q) { return state.questionPublications.filter(a=>a.questionId===q.questionId && a.experienceId===state.experienceId && a.sourceVersion===q.sourceVersion && a.questionRevision===q.revision).at(-1)??null; }
function publicAnswer(a) { return a ? clone({publicationId:a.publicationId,questionId:a.questionId,experienceId:a.experienceId,sourceVersion:a.sourceVersion,questionRevision:a.questionRevision,questionText:a.questionText,status:a.status,text:a.text,reason:a.reason,eta:a.eta,publishedAt:a.publishedAt}) : null; }
export function candidateQuestionProjection(state) {
  return state.questions.filter(q=>q.experienceId===state.experienceId).map(q=>{
    const answer=currentQuestionAnswer(state,q);
    const previous=state.questionPublications.filter(a=>a.questionId===q.questionId && a.experienceId===state.experienceId && (a.sourceVersion!==q.sourceVersion||a.questionRevision!==q.revision)).at(-1)??null;
    return {questionId:q.questionId,experienceId:q.experienceId,text:q.text,visibility:q.visibility,sourceVersion:q.sourceVersion,revision:q.revision,kind:q.kind,answer:publicAnswer(answer),previousAnswer:publicAnswer(previous)};
  });
}
export function companyQuestionProjection(state) { return candidateQuestionProjection(state).filter(q=>q.visibility==='shared_with_company'); }
export function questionAnswerToken(state) { return JSON.stringify(companyQuestionProjection(state).map(q=>[q.questionId,q.sourceVersion,q.revision,q.answer?.publicationId??null])); }
export function questionAnswerDraft(state,id) {
  const q=findQuestion(state,id);if(!q||q.visibility!=='shared_with_company')return null;
  let draft=state.questionAnswerDrafts[id];
  if(!draft||draft.sourceVersion!==q.sourceVersion||draft.questionRevision!==q.revision){const pub=currentQuestionAnswer(state,q);draft={sourceVersion:q.sourceVersion,questionRevision:q.revision,status:pub?.status??'unanswered',text:pub?.text??'',reason:pub?.reason??'',eta:pub?.eta??''};state.questionAnswerDrafts[id]=draft;}
  return draft;
}
export function setQuestionAnswerDraft(state,id,patch) { const draft=questionAnswerDraft(state,id);if(!draft)return false;for(const key of ['status','text','reason','eta'])if(typeof patch[key]==='string')draft[key]=patch[key];return true; }
export function questionInternalDraft(state,id) {
  if(!findQuestion(state,id))return null;
  state.questionInternalDrafts[id]??={checkWith:state.questionInternals[id]?.checkWith??'',internalNote:state.questionInternals[id]?.internalNote??''};return state.questionInternalDrafts[id];
}
export function setQuestionInternalDraft(state,id,patch) { const draft=questionInternalDraft(state,id);if(!draft)return false;for(const key of ['checkWith','internalNote'])if(typeof patch[key]==='string')draft[key]=patch[key];return true; }
export function saveQuestionInternal(state,id,now=new Date().toISOString()) {
  const q=findQuestion(state,id),draft=questionInternalDraft(state,id);if(!q||q.visibility!=='shared_with_company'||!draft||draft.checkWith.length>120||draft.internalNote.length>4000)return false;
  state.questionInternals[id]={checkWith:clean(draft.checkWith),internalNote:clean(draft.internalNote),sourceVersion:q.sourceVersion,savedAt:now};return true;
}
export function previewQuestionAnswer(state,id) {
  const q=findQuestion(state,id),draft=questionAnswerDraft(state,id);
  if(!q||!draft||q.visibility!=='shared_with_company'||!Object.hasOwn(QUESTION_ANSWER_STATUSES,draft.status))return {ok:false,reason:'共有された質問と回答の状態を確認してください。'};
  if([draft.text,draft.reason].some(v=>typeof v!=='string'||v.length>4000)||(!clean(draft.text)&&draft.status==='answered')||(!clean(draft.reason)&&draft.status!=='answered')||(draft.eta && !/^\d{4}-\d{2}-\d{2}$/.test(draft.eta)))return {ok:false,reason:'回答ありの場合は回答本文、それ以外は状況・理由を入力してください。目安は未定のままで構いません。'};
  return {ok:true,preview:{questionId:q.questionId,experienceId:q.experienceId,sourceVersion:q.sourceVersion,questionRevision:q.revision,questionText:q.text,status:draft.status,text:clean(draft.text),reason:clean(draft.reason),eta:draft.status==='checking'?draft.eta:''}};
}
export function publishQuestionAnswer(state,preview,now=new Date().toISOString()) {
  const current=previewQuestionAnswer(state,preview?.questionId);
  if(!current.ok||JSON.stringify(current.preview)!==JSON.stringify(preview))return {ok:false,reason:'プレビュー後に質問・提出版・回答が変わりました。もう一度プレビューしてください。'};
  const q=findQuestion(state,preview.questionId),old=currentQuestionAnswer(state,q);
  if(old&&['status','text','reason','eta'].every(k=>old[k]===preview[k]))return {ok:false,reason:'同じ回答はすでに公開済みです。'};
  const publication={...clone(current.preview),publicationId:`${q.questionId}-answer-${state.questionPublications.filter(a=>a.questionId===q.questionId).length+1}`,publishedAt:now};
  state.questionPublications.push(publication);return {ok:true,publication:publicAnswer(publication)};
}
export function mirrorLegacyAnswer(state,answer) {
  const q=findQuestion(state,state.submissionQuestionId);if(!q)return;
  const history=q.history.find(h=>h.sourceVersion===answer.sourceVersion);if(!history)return;
  const publicationId=`${q.questionId}-legacy-answer-${answer.id}`;
  if(state.questionPublications.some(a=>a.publicationId===publicationId))return;
  state.questionPublications.push({publicationId,questionId:q.questionId,experienceId:q.experienceId,sourceVersion:answer.sourceVersion,questionRevision:history.revision,questionText:history.text,status:answer.status,text:answer.text,reason:answer.reason,eta:answer.eta??'',publishedAt:answer.publishedAt??''});
}
export function migrateQuestionTracker(state) {
  if(state.questionTrackerVersion===1)return;
  Object.assign(state,emptyQuestionTracker());
  for(const entry of state.submissions)syncSubmissionQuestion(state,entry);
  for(const answer of state.answers??[])mirrorLegacyAnswer(state,answer);
  const q=findQuestion(state,state.submissionQuestionId);
  if(q&&state.answerDraft?.sourceVersion===q.sourceVersion)setQuestionAnswerDraft(state,q.questionId,state.answerDraft);
  if(state.decision)state.decision.questionAnswerToken=questionAnswerToken(state);
}
export function validQuestionTracker(state) {
  if(state.questionTrackerVersion!==1||!Array.isArray(state.questions)||!Array.isArray(state.questionPublications)||!Number.isInteger(state.nextQuestionId)||typeof state.questionComposer!=='string')return false;
  if(!['questionInternals','questionInternalDrafts','questionAnswerDrafts'].every(k=>state[k]&&typeof state[k]==='object'&&!Array.isArray(state[k])))return false;
  const ids=new Set();
  for(const q of state.questions){if(!q||typeof q.questionId!=='string'||!/^experience-\d+-question-\d+$/.test(q.questionId)||ids.has(q.questionId)||q.experienceId!==state.experienceId||typeof q.text!=='string'||!q.text.trim()||q.text.length>4000||!['draft','shared_with_company'].includes(q.visibility)||!Number.isInteger(q.sourceVersion)||!Number.isInteger(q.revision)||!Array.isArray(q.history)||!q.history.every(h=>Number.isInteger(h.sourceVersion)&&Number.isInteger(h.revision)&&typeof h.text==='string'&&h.text.length<=4000))return false;ids.add(q.questionId);}
  if(state.questionComposer.length>4000)return false;
  for(const key of ['questionInternals','questionInternalDrafts'])for(const [id,draft] of Object.entries(state[key]))if(!ids.has(id)||!draft||typeof draft.checkWith!=='string'||draft.checkWith.length>120||typeof draft.internalNote!=='string'||draft.internalNote.length>4000||(key==='questionInternals'&&(!Number.isInteger(draft.sourceVersion)||typeof draft.savedAt!=='string')))return false;
  for(const [id,draft] of Object.entries(state.questionAnswerDrafts))if(!ids.has(id)||!draft||!Number.isInteger(draft.sourceVersion)||!Number.isInteger(draft.questionRevision)||!Object.hasOwn(QUESTION_ANSWER_STATUSES,draft.status)||!['text','reason','eta'].every(k=>typeof draft[k]==='string'&&draft[k].length<=4000))return false;
  if(!state.questionPublications.every(a=>ids.has(a.questionId)&&a.experienceId===state.experienceId&&Number.isInteger(a.sourceVersion)&&Number.isInteger(a.questionRevision)&&Object.hasOwn(QUESTION_ANSWER_STATUSES,a.status)&&['publicationId','questionText','text','reason','eta','publishedAt'].every(k=>typeof a[k]==='string')))return false;
  return true;
}
