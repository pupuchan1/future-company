export const STORAGE_KEY = 'haas-experience-v1';
export const FIELDS = ['title', 'situation', 'action', 'result', 'confirmNext', 'question'];
export const LABELS = { title: '選んだ経験', situation: 'どんな場面だったか', action: '自分がしたこと', result: 'その後どうなったか', confirmNext: '次の会話で確認したいこと', question: '候補者から企業への質問' };
export const SCENARIO = 'ジュニア CS：困っているお客さまの話を整理し、解決に必要な人へ引き継ぐ場面';
export const SAMPLE = Object.freeze({ title: 'カフェで、注文と違うドリンクをお渡ししたとき', situation: '土曜の昼、混雑したカフェで、注文と違うドリンクを受け取ったお客さまから声をかけられました。私はアルバイトを始めて3か月でした。', action: 'まず注文内容と急いでいるかを確認しました。レシートを見て店長に状況を伝え、作り直しの時間を確かめてお客さまに説明しました。', result: 'お客さまは5分なら待てると言い、作り直したドリンクを受け取られました。店長と、受け渡し時に注文名を読み上げることを決めました。待ち時間は記憶に基づく目安です。', confirmNext: 'カフェでの対応を CS の問い合わせ対応にどう生かせるか。判断に迷う場合、どこまで自分で決めてよいか。', question: '入社後、判断に迷った問い合わせは、どのように先輩に相談できますか？' });
const copy = value => JSON.parse(JSON.stringify(value));
export const emptyContent = () => Object.fromEntries(FIELDS.map(key => [key, '']));
export function createState() { return { schema: 1, experienceId: 'experience-1', nextExperienceId: 2, otherExperiences: [], screen: 'welcome', interviewIndex: 0, draft: { content: emptyContent(), baseVersion: 0 }, submissions: [], agenda: null, agendaDraft: null, agendaReview: null, proposals: [], nextId: 1, answers: [], answerDraft: null, decision: null }; }
function experienceSnapshot(state) { const { otherExperiences, nextExperienceId, ...experience } = state; return copy(experience); }
export function experienceList(state, submittedOnly = false) {
  return [state, ...(state.otherExperiences ?? [])].filter(e => !submittedOnly || latest(e)).map(e => ({ id: e.experienceId, title: (submittedOnly ? latest(e)?.content.title : e.draft?.content.title || latest(e)?.content.title) || 'まだ選んでいない経験', version: latest(e)?.version ?? 0, isActive: e.experienceId === state.experienceId }));
}
export function addExperience(state, title = '') {
  const id = state.nextExperienceId ?? 2;
  const others = [...(state.otherExperiences ?? []), experienceSnapshot(state)];
  Object.assign(state, createState(), { experienceId: `experience-${id}`, nextExperienceId: id + 1, otherExperiences: others });
  state.draft.content.title = title;
  state.screen = title ? 'interview' : 'welcome';
  return state.experienceId;
}
export function selectExperience(state, id) {
  if (id === state.experienceId) return true;
  const selected = (state.otherExperiences ?? []).find(e => e.experienceId === id);
  if (!selected) return false;
  const others = state.otherExperiences.filter(e => e.experienceId !== id);
  others.push(experienceSnapshot(state));
  const nextExperienceId = state.nextExperienceId;
  Object.assign(state, createState(), copy(selected), { otherExperiences: others, nextExperienceId });
  return true;
}
export function latest(state) { return state.submissions.at(-1) ?? null; }
export function validContent(content) { return FIELDS.every(key => typeof content?.[key] === 'string' && content[key].trim().length > 0 && content[key].length <= 4000); }
export function sameContent(a, b) { return FIELDS.every(key => a?.[key]?.trim() === b?.[key]?.trim()); }
export function isStale(state) {
  const version=latest(state)?.version;
  const legacyReuse=state.agenda && state.agenda.reusePolicy!==2 && state.proposals.some(p=>p.agenda.sourceVersion<version && normalizedAgendaText(p.agenda.focus)===normalizedAgendaText(state.agenda.focus));
  return !!state.agenda && (state.agenda.sourceVersion !== version || (version > 1 && state.agenda.reviewedVersion !== version) || legacyReuse);
}
export function differences(a, b) { return FIELDS.filter(key => a?.[key] !== b?.[key]).map(key => ({ key, label: LABELS[key], before: a?.[key] ?? '', after: b?.[key] ?? '' })); }
export function submit(state, now = new Date().toISOString()) {
  if (!state.draft || !validContent(state.draft.content)) return { ok: false, reason: '送付物のすべての項目を確認してください。' };
  const previous = latest(state);
  if (previous && state.draft.baseVersion !== previous.version) return { ok: false, reason: '提出版が変わりました。最新の版から訂正してください。' };
  if (previous && sameContent(previous.content, state.draft.content)) return { ok: false, reason: '前回から変更がありません。' };
  const content = Object.fromEntries(FIELDS.map(key => [key, state.draft.content[key].trim()]));
  const entry = { version: (previous?.version ?? 0) + 1, submittedAt: now, candidateConfirmed: true, scenario: SCENARIO, content: copy(content) };
  state.submissions.push(entry);
  state.draft = null;
  state.screen = 'submitted';
  return { ok: true, entry: copy(entry) };
}
export function startCorrection(state) {
  const entry = latest(state);
  if (!entry) return false;
  if (!state.draft) state.draft = { content: copy(entry.content), baseVersion: entry.version };
  state.screen = 'review';
  return true;
}
export function cancelCorrection(state) {
  if (!state.draft?.baseVersion) return false;
  state.draft = null;
  state.screen = 'submitted';
  return true;
}
export function createAgenda(state, confirmedChanges = false) {
  const entry = latest(state);
  if (!entry || isStale(state)) return false;
  state.agenda = { sourceVersion: entry.version, reviewedVersion: entry.version, reusePolicy: 2, focus: `「${entry.content.title}」について、話を整理した手順と引き継ぎの判断を一緒に振り返る`, candidateQuestion: entry.content.question, confirmNext: entry.content.confirmNext, notes: state.agenda?.notes ?? '' };
  return true;
}
export function beginAgendaRevision(state) {
  if (!isStale(state)) return false;
  const entry = latest(state);
  if (state.agendaDraft?.sourceVersion !== entry.version) state.agendaDraft = { sourceVersion: entry.version, focus: state.agenda.focus, consistencyNote: '', reuseConfirmed: false };
  state.agendaDraft.consistencyNote ??= ''; state.agendaDraft.reuseConfirmed ??= false;
  return true;
}
const normalizedAgendaText = text => String(text ?? '').normalize('NFKC').replace(/\s+/gu,' ').trim();
export function agendaReuseMatches(state) {
  const focus=normalizedAgendaText(state.agendaDraft?.focus);
  if (!focus) return [];
  const matches=[];
  if (focus===normalizedAgendaText(state.agenda?.focus)) matches.push(`更新前の議題（v${state.agenda.sourceVersion}）`);
  state.proposals.forEach((p,index)=>{ if (focus===normalizedAgendaText(p.agenda.focus)) matches.push(`提案 ${p.sequence ?? index+1}（v${p.agenda.sourceVersion}）`); });
  return matches;
}
export function canCommitAgendaRevision(state, reviewed = false) {
  const draft=state.agendaDraft;
  const reusable=agendaReuseMatches(state).length===0 || (draft?.reuseConfirmed===true && typeof draft.consistencyNote==='string' && draft.consistencyNote.trim().length>0 && draft.consistencyNote.length<=2000);
  return !!(reviewed && isStale(state) && draft?.sourceVersion === latest(state)?.version && draft.focus.trim() && draft.focus.length <= 4000 && reusable);
}
export function commitAgendaRevision(state, reviewed = false) {
  if (!canCommitAgendaRevision(state, reviewed)) return false;
  const previous = copy(state.agenda), entry = latest(state);
  state.agenda = { sourceVersion: entry.version, reviewedVersion: entry.version, reusePolicy: 2, focus: state.agendaDraft.focus.trim(), candidateQuestion: entry.content.question, confirmNext: entry.content.confirmNext, notes: previous.notes };
  const reuseMatches=agendaReuseMatches({ ...state, agenda: previous });
  state.agendaReview = { fromVersion: previous.sourceVersion, toVersion: entry.version, before: previous.focus, after: state.agenda.focus, reuseMatches, reuseRationale: reuseMatches.length ? state.agendaDraft.consistencyNote.trim() : '' };
  state.agendaDraft = null;
  return true;
}
export function propose(state, now = new Date().toISOString()) {
  if (!state.agenda || isStale(state) || !state.agenda.focus.trim()) return { ok: false, reason: '最新の提出版を確認して議題を更新してください。' };
  const agenda = publicAgenda(state.agenda);
  const same = state.proposals.some(p => JSON.stringify(p.agenda) === JSON.stringify(agenda));
  if (same) return { ok: false, reason: '同じ議題はすでに提案済みです。' };
  const proposal = { id: Math.max(0, ...state.proposals.map(p => p.id)) + 1, sequence: state.proposals.length + 1, createdAt: now, agenda, response: 'pending' };
  state.proposals.push(proposal);
  return { ok: true, proposal: copy(proposal) };
}
export function publicAgenda(agenda) { return copy({ sourceVersion: agenda.sourceVersion, focus: agenda.focus, candidateQuestion: agenda.candidateQuestion, confirmNext: agenda.confirmNext }); }
export function alreadyProposed(state) { return !!state.agenda && state.proposals.some(p => JSON.stringify(p.agenda) === JSON.stringify(publicAgenda(state.agenda))); }
export const ANSWER_STATUSES = { unanswered: '未回答', answered: '回答あり', checking: '確認中', discuss_in_meeting: '面談で話したい' };
export function latestAnswer(state) { return (state.answers ?? []).filter(a => a.sourceVersion === latest(state)?.version).at(-1) ?? null; }
export function answerDraft(state) {
  const version = latest(state)?.version;
  if (!version) return null;
  if (state.answerDraft?.sourceVersion !== version) state.answerDraft = { sourceVersion: version, status: 'unanswered', text: '', reason: '', eta: '', ...(latestAnswer(state) ?? {}) };
  return state.answerDraft;
}
export function publishAnswer(state) {
  const draft = answerDraft(state);
  if (!draft || !Object.keys(ANSWER_STATUSES).includes(draft.status)) return false;
  if (draft.status === 'answered' && !draft.text.trim()) return false;
  if (draft.status !== 'answered' && !draft.reason.trim()) return false;
  const previous = latestAnswer(state);
  if (previous && ['status', 'text', 'reason', 'eta'].every(k => previous[k] === draft[k])) return false;
  state.answers.push({ sourceVersion: draft.sourceVersion, status: draft.status, text: draft.text.trim(), reason: draft.reason.trim(), eta: draft.eta, id: state.nextId++ });
  return true;
}
export function decide(state, choice) {
  if (!latest(state) || !['wait', 'proceed', 'pause'].includes(choice)) return false;
  state.decision = { sourceVersion: latest(state).version, answerId: latestAnswer(state)?.id ?? null, choice };
  return true;
}
export function respond(state, id, response) {
  const proposal = state.proposals.find(p => p.id === id);
  if (!proposal || proposal.response !== 'pending' || !['accepted', 'declined'].includes(response) || proposal.agenda.sourceVersion !== latest(state)?.version) return false;
  proposal.response = response;
  return true;
}
export function restore(raw) {
  try {
    const data = JSON.parse(raw);
    if (data?.schema !== 1 || !Array.isArray(data.submissions) || !Array.isArray(data.proposals) || !['welcome', 'interview', 'review', 'submitted'].includes(data.screen)) return createState();
    if (!data.submissions.every((entry, index) => entry.version === index + 1 && validContent(entry.content))) return createState();
    if (data.draft && (!FIELDS.every(key => typeof data.draft.content?.[key] === 'string' && data.draft.content[key].length <= 4000) || !Number.isInteger(data.draft.baseVersion))) return createState();
    if (data.agenda && (!Number.isInteger(data.agenda.sourceVersion) || !['focus', 'candidateQuestion', 'confirmNext', 'notes'].every(key => typeof data.agenda[key] === 'string'))) return createState();
    if (!Number.isInteger(data.interviewIndex) || data.interviewIndex < 0 || data.interviewIndex > 4 || !Number.isInteger(data.nextId)) return createState();
    if (!data.proposals.every(p => Number.isInteger(p.id) && p.agenda && Number.isInteger(p.agenda.sourceVersion) && ['focus','candidateQuestion','confirmNext'].every(key => typeof p.agenda[key] === 'string') && ['pending','accepted','declined'].includes(p.response))) return createState();
    data.answers ??= []; data.answerDraft ??= null; data.decision ??= null;
    if (!Array.isArray(data.answers) || !data.answers.every(a => Number.isInteger(a.sourceVersion) && Number.isInteger(a.id) && Object.keys(ANSWER_STATUSES).includes(a.status) && ['text','reason','eta'].every(k => typeof a[k] === 'string'))) return createState();
    if (data.answerDraft && (!Number.isInteger(data.answerDraft.sourceVersion) || !Object.keys(ANSWER_STATUSES).includes(data.answerDraft.status) || !['text','reason','eta'].every(k => typeof data.answerDraft[k] === 'string'))) return createState();
    if (data.decision && (!Number.isInteger(data.decision.sourceVersion) || !['wait','proceed','pause'].includes(data.decision.choice))) return createState();
    if (!data.draft && !data.submissions.length) return createState();
    data.experienceId ??= 'experience-1'; data.nextExperienceId ??= 2; data.otherExperiences ??= []; data.agendaDraft ??= null; data.agendaReview ??= null;
    if (typeof data.experienceId !== 'string' || !Number.isInteger(data.nextExperienceId) || !Array.isArray(data.otherExperiences) || data.otherExperiences.length > 100) return createState();
    if (data.agendaDraft && (!Number.isInteger(data.agendaDraft.sourceVersion) || typeof data.agendaDraft.focus !== 'string' || data.agendaDraft.focus.length > 4000 || (data.agendaDraft.consistencyNote !== undefined && (typeof data.agendaDraft.consistencyNote !== 'string' || data.agendaDraft.consistencyNote.length>2000)) || (data.agendaDraft.reuseConfirmed !== undefined && typeof data.agendaDraft.reuseConfirmed !== 'boolean'))) return createState();
    if (data.agendaReview && (!Number.isInteger(data.agendaReview.fromVersion) || !Number.isInteger(data.agendaReview.toVersion) || typeof data.agendaReview.before !== 'string' || typeof data.agendaReview.after !== 'string')) return createState();
    const ids = new Set([data.experienceId]);
    data.otherExperiences = data.otherExperiences.map(item => {
      if (!item || typeof item.experienceId !== 'string' || ids.has(item.experienceId)) throw new Error('Invalid experience');
      ids.add(item.experienceId);
      const experience = restore(JSON.stringify({ ...item, otherExperiences: [], nextExperienceId: data.nextExperienceId }));
      if (experience.experienceId !== item.experienceId || experience.submissions.length !== item.submissions?.length) throw new Error('Invalid experience');
      return experienceSnapshot(experience);
    });
    data.proposals.forEach((p, index) => { p.sequence = index + 1; });
    return data;
  } catch { return createState(); }
}
