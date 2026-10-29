import { selectExperience } from './model.js';
import { answerDraftFields,questionAnswerDraft } from './question-tracker.js';
const clone=value=>JSON.parse(JSON.stringify(value));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Recovery copies are company-only input, never public projections or publications.
export function retainPreviewInputs(local,incoming){
 const localJob=local.companyJob,remoteJob=incoming.companyJob;
 if(localJob.jobId===remoteJob.jobId){
  if(localJob.recoveredDraft&&!remoteJob.recoveredDraft)remoteJob.recoveredDraft=clone(localJob.recoveredDraft);
  if(localJob.editor&&!same(localJob.editor.content,localJob.published.at(-1).content)&&!same(localJob.editor,remoteJob.editor))remoteJob.recoveredDraft=clone(localJob.editor);
 }
 const localExperiences=[local,...local.otherExperiences],remoteExperiences=[incoming,...incoming.otherExperiences];
 for(const old of localExperiences){const target=remoteExperiences.find(e=>e.experienceId===old.experienceId);if(!target)continue;target.questionAnswerRecoveries??={};
  for(const q of target.questions)if(q.visibility==='shared_with_company')questionAnswerDraft(target,q.questionId);
  for(const [id,draft] of Object.entries(old.questionAnswerRecoveries??{}))if(target.questions.some(q=>q.questionId===id)&&!target.questionAnswerRecoveries[id])target.questionAnswerRecoveries[id]=clone(draft);
  for(const [id,draft] of Object.entries(old.questionAnswerDrafts)){if(target.questions.some(q=>q.questionId===id)&&[draft.text,draft.reason].some(v=>v?.trim())&&!same(answerDraftFields(draft),answerDraftFields(target.questionAnswerDrafts[id])))target.questionAnswerRecoveries[id]=answerDraftFields(draft);}
 }
 if(remoteExperiences.some(e=>e.experienceId===local.experienceId))selectExperience(incoming,local.experienceId);
 return incoming;
}
