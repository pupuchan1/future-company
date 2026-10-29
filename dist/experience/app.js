import { STORAGE_KEY, FIELDS, LABELS, SAMPLE, SCENARIO, createState, latest, sameContent, submit, startCorrection, cancelCorrection, differences, createAgenda, isStale, propose, restore, alreadyProposed, ANSWER_STATUSES, latestAnswer, answerDraft, publishAnswer, decide, beginAgendaRevision, canCommitAgendaRevision, commitAgendaRevision, experienceList, addExperience, selectExperience } from './model.js';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let memoryOnly = false;
let state;
try { state = restore(localStorage.getItem(STORAGE_KEY)); } catch { state = createState(); memoryOnly = true; }
let changesReviewed = false;
let confirmAction = null;
const questions = [
  ['situation', 'そのとき、何が起きましたか？', 'いつ、どこで、誰が困っていたか。あなたの立場も教えてください。'],
  ['action', 'あなたは、具体的に何をしましたか？', '最初に聞いたこと、伝えたこと、誰に引き継いだか。自分の行動を一つずつ。'],
  ['result', 'その後、どうなりましたか？', '分かったことを、そのまま書いてください。結果が不明なら「まだ分からない」で大丈夫です。'],
  ['confirmNext', '次の会話では、何を確かめたいですか？', 'この経験と仕事がどうつながるか。まだ分からないことも、議題にできます。'],
  ['question', 'あなたから、企業に聞きたいことは？', '働き方、相談のしやすさ、入社後の支援など。あなたが判断するための質問です。']
];
function save() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { memoryOnly = true; } storageLabel(); }
function storageLabel() { $('#storage-status').textContent = memoryOnly ? '保存できないため、このタブを閉じると消えます' : '入力はこのブラウザ内に保存されます'; }
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 4200); }
function navigate(path) { if (location.hash === `#${path}`) render(); else location.hash = path; }
function candidatePath() { return state.screen === 'interview' ? `candidate/interview/${state.interviewIndex}` : `candidate/${state.screen}`; }
function field(key, value, rows = 4) { return `<label class="field" for="${key}"><span>${LABELS[key]}</span><textarea id="${key}" data-field="${key}" maxlength="4000" rows="${rows}">${esc(value)}</textarea></label>`; }
function documentView(entry, heading = '候補者が内容を確認') { return `<div class="document-meta"><span class="pill">提出 v${entry.version}</span><span>${heading} · 自己申告</span></div><div class="scenario"><span class="eyebrow">求人の場面</span><p>${esc(entry.scenario)}</p></div>${FIELDS.map(key => `<section class="document-section"><h3>${LABELS[key]}</h3><p>${esc(entry.content[key])}</p></section>`).join('')}`; }
function agendaView(agenda) { return `<div class="agenda-content"><span class="eyebrow">提出 v${agenda.sourceVersion} をもとにした議題</span><h3>${esc(agenda.focus)}</h3><div class="agenda-item"><span>一緒に確認すること</span><p>${esc(agenda.confirmNext)}</p></div><div class="agenda-item"><span>候補者から企業への質問</span><p>${esc(agenda.candidateQuestion)}</p></div></div>`; }
function proposalStatus(p) { if (p.agenda.sourceVersion !== latest(state)?.version) return '訂正前の議題'; return '議題を提案済み'; }
const CHOICES = { wait: '回答を待つ', proceed: 'この内容で話を進める', pause: '今は進めない' };
function candidateAnswer() {
  const answer = latestAnswer(state);
  const decision = state.decision?.sourceVersion === latest(state)?.version ? state.decision : null;
  const changed = decision && decision.answerId !== (answer?.id ?? null);
  return `<section class="card answer-card"><span class="eyebrow">あなたからの質問、その返事</span><h2>あなたも、選べます。</h2><blockquote>${esc(latest(state).content.question)}</blockquote><span class="pill ${!answer || answer.status !== 'answered' ? 'warning' : ''}">${ANSWER_STATUSES[answer?.status ?? 'unanswered']}</span>${answer ? `${answer.text.trim() ? `<p>${esc(answer.text)}</p>` : ''}${answer.reason.trim() ? `<p class="small">${answer.status === 'answered' ? '補足' : '理由・いまの状況'}：${esc(answer.reason)}</p>` : ''}${answer.status === 'checking' && answer.eta ? `<p class="small">確認の目安：${esc(answer.eta)}（確約ではありません）</p>` : ''}` : '<p>企業からの回答はまだありません。未回答のまま進めるか、待つかも自分で選べます。</p>'}<div class="decision-options">${Object.entries(CHOICES).map(([key,label]) => `<button class="button ${decision?.choice === key && !changed ? '' : 'secondary'} full" data-action="decide" data-choice="${key}" aria-pressed="${decision?.choice === key && !changed}">${label}</button>`).join('')}</div><p class="small">「回答を待つ」は辞退として扱いません。選択は後から変えられます。外部送信・日程予約はありません。</p>${decision ? `<div class="decision-status">${changed ? `回答が更新されました。前の選択「${CHOICES[decision.choice]}」を見直せます。` : `現在の選択：${CHOICES[decision.choice]}`}</div>` : ''}</section>`;
}
function recruiterAnswer() {
  const draft = answerDraft(state), answer = latestAnswer(state);
  const decision = state.decision?.sourceVersion === latest(state)?.version ? state.decision : null;
  return `<section class="card answer-editor"><span class="eyebrow">候補者から企業への質問</span><h2>企業も、問いに答える。</h2><blockquote>${esc(latest(state).content.question)}</blockquote><span class="pill quiet">現在の表示：${ANSWER_STATUSES[answer?.status ?? 'unanswered']}</span><label class="field" for="answer-status"><span>回答の状態</span><select id="answer-status" data-answer="status">${Object.entries(ANSWER_STATUSES).map(([key,label]) => `<option value="${key}" ${draft.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field" for="answer-text"><span>回答内容（回答ありの場合は必須）</span><textarea id="answer-text" data-answer="text" rows="4" maxlength="4000">${esc(draft.text)}</textarea></label><button class="text-link" data-action="answer-sample">架空の企業回答を入れる</button><label class="field" for="answer-reason"><span>答えられない理由・状況（回答あり以外は必須）</span><textarea id="answer-reason" data-answer="reason" rows="3" maxlength="4000">${esc(draft.reason)}</textarea></label><label class="field" for="answer-eta"><span>確認中の場合の目安期限（任意）</span><input id="answer-eta" data-answer="eta" type="date" value="${esc(draft.eta)}"></label><button class="button full" data-action="publish-answer">回答を候補者の画面へ表示 →</button><p class="small">保存中の回答下書きは候補者に表示されません。この操作でデモ内に表示します。</p>${decision ? `<div class="decision-status">候補者の選択：${CHOICES[decision.choice]}${decision.answerId !== (answer?.id ?? null) ? '（前の回答時点の選択）' : ''}</div><p class="small">${decision.choice === 'wait' ? '回答待ちです。辞退ではありません。' : 'デモ内の意思表示です。実際の送信や予約はありません。'}</p>` : '<p class="small">候補者の選択は、まだありません。</p>'}</section>`;
}
function welcomeLanding() { return `<div class="hero-grid"><section class="hero"><span class="eyebrow">HUMAN AS A SERVICE / 採用体験デモ</span><h1>経験のひとコマから、<br>次の会話をつくる。</h1><p class="lead">職歴の見栄えより、あなたがしたこと。<br>一つの具体例を一緒に整理して、<br>自分で確かめた内容だけを企業へ。</p><div class="hero-points"><span>01 経験を選ぶ</span><span>02 内容を確かめる</span><span>03 議題をそろえる</span></div><a class="text-link" href="#about">このデモについて ↗</a></section><section class="card start-card"><div class="card-top"><span class="dot"></span><span>まずは、経験を一つ</span><span class="pill quiet">架空の求人</span></div><h2>困っている人の話を<br>整理したことはありますか？</h2><p>カフェ、サークル、学校。仕事以外の経験でも構いません。今回は架空例で体験できます。</p><button class="experience-choice" data-action="choose" data-choice="cafe"><span class="choice-icon">☕</span><span><strong>カフェでのお客さま対応</strong><small>注文違いを確かめて、店長へ相談した経験</small></span><span>↗</span></button><button class="experience-choice" data-action="choose" data-choice="own"><span class="choice-icon">✎</span><span><strong>別の架空の経験を使う</strong><small>自分で考えたサンプルを入力する</small></span><span>↗</span></button><p class="small">履歴書・ログイン不要。実在する候補者や顧客の個人情報は入力しないでください。</p></section></div><section class="job-strip"><div><span class="eyebrow">今回つなぐ仕事の場面</span><h3>ジュニア・カスタマーサポート</h3><p>架空企業「灯りワークス」 · お客さまの話を聞き、必要な人につなぐ仕事</p></div><div class="scene-chip">傾聴 → 整理 → 引き継ぎ</div></section><div class="quiet-note">自動採点・性格推定はありません。候補者と企業の双方が、次に話すことを持ち寄るための体験です。</div>`; }

function hasExperience() { return !!(latest(state) || state.draft?.content.title || state.otherExperiences?.length); }
function experienceToolbar(role) {
  if (!hasExperience()) return '';
  const items = experienceList(state, role === 'recruiter');
  return '<section class="experience-switcher" aria-label="経験の選択"><label for="experience-select">' + (role === 'recruiter' ? '提出済みの経験' : '保存した経験') + '</label><select id="experience-select">' + (role === 'recruiter' && !latest(state) ? '<option value="" selected disabled>この経験は未提出です</option>' : '') + items.map(e => '<option value="' + esc(e.id) + '" ' + (e.isActive ? 'selected' : '') + '>' + esc(e.id.replace('experience-', '経験 ')) + '：' + esc(e.title) + (e.version ? ' / 提出 v' + e.version : ' / 下書き') + '</option>').join('') + '</select>' + (role === 'candidate' ? '<button class="button secondary" data-action="new-experience">別の経験を追加</button>' : '') + '</section>';
}
function experienceLibrary() {
  return '<section class="page-heading"><span class="eyebrow">YOUR EXPERIENCES / 経験ごとに続きを選ぶ</span><h1>これまでの経験と、次のひとコマ。</h1><p>経験ごとに下書き・提出版・企業回答・会話議題を分けて保存しています。別の経験を追加しても、今の内容は残ります。</p></section><div class="experience-library">' + experienceList(state).map(e => '<section class="card"><span class="pill quiet">' + esc(e.id.replace('experience-', '経験 ')) + (e.version ? ' / 提出 v' + e.version : ' / 下書き') + '</span><h2>' + esc(e.title) + '</h2><button class="button" data-action="select-experience" data-id="' + esc(e.id) + '">この経験を続ける →</button></section>').join('') + '<section class="card next-card"><h2>別の経験も、届ける。</h2><p>今の提出物や議題を残したまま、新しい経験を始められます。</p><button class="button" data-action="new-experience">新しい架空の経験を追加 →</button></section></div>';
}
function welcome() { return hasExperience() ? experienceLibrary() : welcomeLanding(); }

function interview(index) {
  const [key, title, help] = questions[index];
  return `<section class="page-heading"><span class="eyebrow">STEP 01 / 経験を具体的にする</span><h1>一つの場面を、あなたの言葉で。</h1><p>ルールに沿った文字ガイドです。AI は接続していません。途中で閉じても、下書きから続けられます。</p></section><div class="flow-grid"><aside class="context-card"><span class="pill quiet">人事にはまだ見えません</span><h3>今回選んだ経験</h3><p>${esc(state.draft.content.title)}</p><hr><span class="eyebrow">求人との接点</span><p>${esc(SCENARIO)}</p><ol class="question-steps">${questions.map(([f,,], i) => `<li class="${i === index ? 'current' : ''}"><span>${state.draft.content[f]?.trim() ? '✓' : i + 1}</span>${LABELS[f]}</li>`).join('')}</ol></aside><section class="card conversation-card"><div class="card-top"><span class="dot"></span> HaaS 文字ガイド <span class="counter">${index + 1} / 5</span></div><h2>${title}</h2><p>${help}</p>${field(key, state.draft.content[key], 7)}<div class="field-tools"><span class="small">分からないことは、分からないままで。</span><button class="text-link" data-action="sample" data-key="${key}">架空例を入れる</button></div><div class="actions"><button class="button secondary" data-action="interview-back">戻る</button><button class="button" data-action="interview-next">${index === 4 ? '送付物を確認する' : '次へ進む'} <span>→</span></button></div><p class="small voice-note">声で話す機能は未接続です。マイクは使いません。</p></section></div>`;
}
function review() {
  const correction = state.draft.baseVersion > 0;
  const unchanged = latest(state) && sameContent(latest(state).content, state.draft.content);
  return `<section class="page-heading"><span class="eyebrow">STEP 02 / ${correction ? `v${state.draft.baseVersion + 1} の訂正下書き` : '自分で内容を確かめる'}</span><h1>企業に見える内容、そのまま。</h1><p>これはまだ下書きです。${correction ? `提出 v${state.draft.baseVersion} はそのまま残り、訂正版の提出まで人事には表示されません。` : '自分の言葉に直して、納得してから提出できます。'}</p></section><div class="review-grid"><section class="card document-editor"><div class="document-meta"><span class="pill quiet">非公開の下書き</span><span>本人の具体例 · 自己申告</span></div><div class="scenario"><span class="eyebrow">求人の場面</span><p>${esc(SCENARIO)}</p></div>${FIELDS.map(key => field(key, state.draft.content[key], key === 'title' ? 2 : 4)).join('')}</section><aside class="submit-panel"><span class="eyebrow">自分の言葉で、送る</span><h2>伝えたいことが<br>そろっていますか？</h2><p>この画面の求人の場面・具体例・確認したい点・企業への質問が、人事画面に表示されます。</p><p>提出後も訂正できます。元の版と変更箇所は分けて残します。</p><button class="button full" data-action="request-submit">${correction ? '訂正版を確認して提出' : 'この内容を確認して提出'} →</button><p id="unchanged-hint" class="small">${unchanged ? '変更してから訂正版を提出できます。' : '最終確認を開きます。外部へは送信されません。'}</p><button class="button secondary full" data-action="review-back">${correction ? '提出済みの内容を見る' : '文字対話に戻る'}</button>${correction ? '<button class="text-link danger" data-action="cancel-correction">訂正下書きを取り消す</button>' : ''}</aside></div>`;
}
function submitted() {
  const entry = latest(state);
  if (!entry) return welcome();
  const proposals = state.proposals.slice().reverse();
  return `<section class="page-heading success-heading"><span class="eyebrow">STEP 03 / 次の会話へ</span><h1>経験を届けました。</h1><p>提出 v${entry.version} はこのブラウザの人事デモ画面で確認できます。外部の企業には送信されていません。</p></section><div class="submitted-grid"><section><div class="card document-card">${documentView(entry)}</div>${entry.version > 1 ? `<details class="card history"><summary>以前の提出版を見る（${entry.version - 1} 件）</summary>${state.submissions.slice(0,-1).reverse().map(e => `<div class="history-version">${documentView(e)}</div>`).join('')}</details>` : ''}</section><aside><section class="card next-card"><span class="eyebrow">次にできること</span><h2>同じ議題で、<br>会話をはじめる。</h2><p>人事画面で具体例を確認し、話したい議題を提案すると、ここに届きます。</p><button class="button full" data-action="to-recruiter">人事の視点で見る →</button><button class="button secondary full" data-action="correct">${state.draft ? '訂正下書きを続ける' : '内容を訂正・追記する'}</button></section>${candidateAnswer()}<section class="card proposal-card"><span class="eyebrow">企業からの会話提案</span>${proposals.length ? proposals.map(p => `<article class="proposal"><div class="document-meta"><span class="pill ${p.agenda.sourceVersion !== entry.version ? 'warning' : ''}">${proposalStatus(p)}</span><span>提案 ${p.sequence}</span></div>${agendaView(p.agenda)}${p.agenda.sourceVersion !== entry.version ? '<p class="warning-text">この提案は訂正前の内容をもとにしています。人事が最新の議題を提案し直すまで返答できません。</p>' : '<p class="small">この議題と企業の回答を見て、「あなたからの質問、その返事」のカードから次の進み方を選べます。</p>'}</article>`).join('') : '<p>まだ提案はありません。人事画面から、議題付きの会話を提案できます。</p>'}</section></aside></div>`;
}
function recruiterAgenda(entry, agendaDiff) {
  const agenda = state.agenda, stale = isStale(state), draft = state.agendaDraft;
  if (!agenda) return '<section class="card"><span class="eyebrow">会話の準備</span><h2>この具体例について、話す会を提案する。</h2><p>決まった形式の下書きから、人事が議題を編集します。AI による生成ではありません。</p><button class="button full" data-action="create-agenda">議題の下書きを作る →</button></section>';
  const diffs = agendaDiff.map(d => '<section class="diff"><h3>' + d.label + '</h3><div><span>議題の元の版</span><p>' + esc(d.before) + '</p></div><div class="after"><span>最新 v' + entry.version + '</span><p>' + esc(d.after) + '</p></div></section>').join('');
  let content = '<section class="card"><span class="eyebrow">会話の準備</span><h2>具体例を確かめて、議題にする。</h2>';
  if (stale) {
    content += '<div class="stale-banner"><strong>議題の文面を見直すまで提案できません</strong><p>' + (agenda.sourceVersion === entry.version ? '旧デモで保存された議題は、文面の見直しが未確認です。提出 v' + entry.version + ' に沿って、人事が文面を編集・確認してください。' : '現在の議題は v' + agenda.sourceVersion + ' のままです。最新 v' + entry.version + ' との差分を踏まえて議題文を編集し、確認して保存してください。') + '参照版だけの切り替えは行いません。</p></div><div class="stale-diff">' + (diffs || '<p class="small">表示中の最新の送付物と照合し、議題に古い前提が残っていないか確認してください。</p>') + '</div>';
    if (!draft || draft.sourceVersion !== entry.version) content += '<button class="button full" data-action="update-agenda">差分を見ながら議題文を編集 →</button>';
    else content += '<div class="agenda-revision"><span class="pill warning">未保存：v' + entry.version + ' 向けの見直し</span><p class="small">下の文面は従来の議題です。訂正内容に合うよう、人事が書き直してください。自動で見直し済みとは扱いません。</p><label class="field" for="agenda-revision-focus"><span>訂正内容を踏まえた新しい議題文</span><textarea id="agenda-revision-focus" data-agenda-draft="focus" rows="6" maxlength="4000">' + esc(draft.focus) + '</textarea></label><div class="agenda-item"><span>保存時に反映する最新の確認点</span><p>' + esc(entry.content.confirmNext) + '</p></div><div class="agenda-item"><span>保存時に反映する最新の候補者の質問</span><p>' + esc(entry.content.question) + '</p></div><label class="check"><input type="checkbox" id="changes-reviewed" ' + (changesReviewed ? 'checked' : '') + '>書き直した議題文と最新の質問を確認した</label><button class="button full" data-action="commit-agenda" ' + (canCommitAgendaRevision(state,changesReviewed) ? '' : 'disabled') + '>文面の変更を確認して議題を保存</button><p class="small">以前と同じ議題文のままでは保存できません。保存だけでは提案は送られません。</p></div>';
    content += '<details class="old-agenda"><summary>更新前の議題（v' + agenda.sourceVersion + '）を見る</summary>' + agendaView(agenda) + '</details>';
  } else {
    if (state.agendaReview?.toVersion === entry.version) content += '<details class="agenda-review-result" open><summary>人事が見直して更新した内容：v' + state.agendaReview.fromVersion + ' → v' + entry.version + '</summary><div class="diff"><div><span>以前の議題文</span><p>' + esc(state.agendaReview.before) + '</p></div><div class="after"><span>人事が保存した議題文</span><p>' + esc(state.agendaReview.after) + '</p></div></div><p class="small">下記の確認点と候補者の質問も最新の提出版へ反映しました。</p></details>';
    content += '<div class="agenda-editor"><span class="pill quiet">元の提出版：v' + agenda.sourceVersion + '</span><label class="field" for="agenda-focus"><span>一緒に話したい議題（人事が編集）</span><textarea id="agenda-focus" data-agenda="focus" rows="4" maxlength="4000">' + esc(agenda.focus) + '</textarea></label><div class="agenda-item"><span>候補者が確かめたいこと</span><p>' + esc(agenda.confirmNext) + '</p></div><div class="agenda-item"><span>候補者から企業への質問</span><p>' + esc(agenda.candidateQuestion) + '</p></div></div>';
  }
  content += '<label class="field private-note" for="agenda-notes"><span>人事の準備メモ（候補者には表示しません）</span><textarea id="agenda-notes" data-agenda="notes" rows="3" maxlength="4000">' + esc(agenda.notes) + '</textarea></label><p class="small">メモは議題の見直し後も保持します。提案には含めません。</p><button class="button full" data-action="request-proposal" ' + (stale || alreadyProposed(state) || !agenda.focus.trim() ? 'disabled' : '') + '>' + (!stale && alreadyProposed(state) ? 'この議題は提案済みです' : 'この議題で会話を提案する') + ' →</button><p class="small">' + (stale ? '議題文の見直しと保存が完了するまで提案できません。' : '外部送信・日程予約は行いません。候補者と同じ議題を確認して提案します。') + '</p></section>';
  return content;
}
function recruiter() {
  const entry = latest(state);
  if (!entry) return '<section class="page-heading"><span class="eyebrow">RECRUITER / 人事の視点</span><h1>この経験の提出を待っています。</h1><p>下書きは人事に表示されません。ほかに提出済みの経験があれば、上の選択欄から確認できます。</p></section><section class="card empty-state"><h2>この経験の送付物は、まだありません。</h2><button class="button" data-action="to-candidate">候補者の画面へ →</button></section>';
  const previous = state.submissions.at(-2);
  const from = isStale(state) ? state.submissions.find(e => e.version === state.agenda.sourceVersion) : previous;
  const agendaDiff = from ? differences(from.content, entry.content) : [];
  return '<section class="page-heading"><span class="eyebrow">RECRUITER / 具体例から会話を準備する</span><h1>次に話すことを、そろえる。</h1><p>架空の候補者「サンプル A」 · ' + esc(state.experienceId.replace('experience-','経験 ')) + ' · 最新の提出 v' + entry.version + ' を表示中</p></section><div class="recruiter-grid"><section><div class="card document-card">' + documentView(entry) + '</div>' + (previous ? '<details class="card history"><summary>以前の提出版を見る</summary>' + state.submissions.slice(0,-1).reverse().map(e => '<div class="history-version">' + documentView(e) + '</div>').join('') + '</details>' : '') + '</section><aside class="recruiter-panel">' + recruiterAgenda(entry,agendaDiff) + recruiterAnswer() + '<section class="card"><span class="eyebrow">この経験の提案履歴（送った順）</span>' + (state.proposals.length ? state.proposals.slice().reverse().map(p => '<details class="proposal-history"><summary>提案 ' + p.sequence + ' · v' + p.agenda.sourceVersion + ' · ' + proposalStatus(p) + '</summary>' + agendaView(p.agenda) + '</details>').join('') : '<p>まだ提案はありません。</p>') + '</section></aside></div>';
}
function about() { return `<section class="page-heading"><span class="eyebrow">ABOUT THIS DEMO</span><h1>「次に、何を話すか」まで。</h1><p>経験の一場面と、候補者が確かめた送付物、双方が持つ会話の議題をつなぎます。</p></section><section class="card about-card"><h2>このデモでできること</h2><p>候補者が架空の経験を具体化し、企業に見える内容を編集・確認して提出できます。人事は提出された具体例と候補者の質問から議題を作れます。訂正版が提出されると、古い議題は更新が必要になり、差分の確認後に改めて提案できます。</p><h2>保存と表示の範囲</h2><p>このブラウザの localStorage を使った、役割切り替え式の操作デモです。候補者・人事は同じブラウザ内のデータを見ています。別のブラウザや端末とは共有しません。下書きを人事 UI に表示しない設計ですが、本番用の認証・権限分離ではありません。同じ端末の利用者や開発者ツールからは保存データを閲覧できます。</p><h2>未接続のもの</h2><p>AI、音声、メール、カレンダー、企業システムは接続していません。文字対話は決まった質問を順に表示します。「提出」「提案」「話したい」はデモ内の状態変更です。実在する候補者・顧客の個人情報や機微情報を入力しないでください。</p><h2>確認の意味</h2><p>「候補者が内容を確認」は、送付内容を候補者自身が確認する操作を示します。身元認証や経験の事実確認を示すものではありません。自動採点・性格推定は行いません。</p><div class="actions"><button class="button" data-action="to-candidate">体験に戻る →</button><a class="button secondary" href="/reception/">以前の総合受付を見る</a></div></section>`; }
function render(persist = true) {
  const parts = location.hash.replace(/^#/, '').split('/');
  const role = parts[0] === 'recruiter' ? 'recruiter' : 'candidate';
  document.querySelectorAll('[data-role]').forEach(el => { const active = el.dataset.role === role; el.classList.toggle('active', active); el.setAttribute('aria-pressed', String(active)); });
  let content;
  if (parts[0] === 'about') content = about();
  else if (role === 'recruiter') content = recruiter();
  else {
    let screen = parts[1] || state.screen;
    if (['interview', 'review'].includes(screen) && !state.draft) screen = latest(state) ? 'submitted' : 'welcome';
    if (screen === 'submitted' && !latest(state)) screen = 'welcome';
    if (screen === 'interview') {
      const index = Math.max(0, Math.min(4, Number(parts[2]) || 0)); state.interviewIndex = index; state.screen = screen; content = interview(index);
    } else if (screen === 'review') { state.screen = screen; content = review(); }
    else if (screen === 'new') { content = welcomeLanding(); }
    else if (screen === 'experiences') { content = experienceLibrary(); }
    else if (screen === 'submitted') { state.screen = screen; content = submitted(); }
    else content = welcome();
  }
  $('#app').innerHTML = (parts[0] === 'about' ? '' : experienceToolbar(role)) + content;
  if (persist) save(); else storageLabel();
  $('#app').focus({ preventScroll: true });
}
function modal(title, body, label, action) {
  $('#modal-title').textContent = title; $('#modal-body').innerHTML = body; $('#modal-confirm').textContent = label;
  confirmAction = action; $('#confirmation').showModal();
}
function requestSubmit() {
  const missing = FIELDS.find(key => !state.draft.content[key].trim());
  if (missing) { toast(`${LABELS[missing]}を入力してください。`); $(`#${missing}`).focus(); return; }
  if (latest(state) && sameContent(latest(state).content, state.draft.content)) { toast('前回から変更がありません。'); return; }
  const entry = { version: (latest(state)?.version ?? 0) + 1, scenario: SCENARIO, content: state.draft.content };
  modal('この内容をデモ内で提出します', `<p>以下が人事画面に表示される内容です。候補者が内容を確認した送付物として保存します。</p><div class="modal-document">${documentView(entry, '提出前の最終確認')}</div><p class="small">外部への送信はありません。実在する人の個人情報が含まれていないことを確認してください。</p>`, '内容を確認して、デモとして提出', () => {
    const result = submit(state); if (!result.ok) { toast(result.reason); return; } changesReviewed = false; save(); navigate('candidate/submitted'); toast(`提出 v${result.entry.version} を保存しました`);
  });
}
document.addEventListener('input', event => {
  const el = event.target;
  if (el.dataset.field && state.draft) { state.draft.content[el.dataset.field] = el.value; save(); }
  if (el.dataset.agendaDraft && state.agendaDraft) { state.agendaDraft[el.dataset.agendaDraft] = el.value; const commit = $('[data-action="commit-agenda"]'); if (commit) commit.disabled = !canCommitAgendaRevision(state, changesReviewed); save(); }
  if (el.dataset.agenda && state.agenda) { state.agenda[el.dataset.agenda] = el.value; save(); }
  if (el.dataset.answer && latest(state)) { answerDraft(state)[el.dataset.answer] = el.value; save(); }
});
document.addEventListener('change', event => {
  if (event.target.id === 'changes-reviewed') { changesReviewed = event.target.checked; const button = $('[data-action="commit-agenda"]'); if (button) button.disabled = !canCommitAgendaRevision(state, changesReviewed); }
  if (event.target.id === 'experience-select') { selectExperience(state,event.target.value); changesReviewed = false; save(); navigate(location.hash.startsWith('#recruiter') ? 'recruiter' : candidatePath()); }
  if (event.target.dataset.agenda) render();
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  const action = button.dataset.action;
  if (action === 'decide') { decide(state, button.dataset.choice); save(); render(); toast(`「${CHOICES[button.dataset.choice]}」を記録しました`); }
  if (action === 'answer-sample') { Object.assign(answerDraft(state), { status: 'answered', text: '最初の1か月は、毎日先輩と問い合わせを振り返ります。迷う問い合わせは社内チャットで相談でき、緊急時には担当リーダーが引き継ぎます。（架空の企業回答）', reason: '', eta: '' }); save(); render(); }
  if (action === 'publish-answer') { if (publishAnswer(state)) { save(); render(); toast('企業の回答を候補者の画面へ表示しました'); } else toast('回答内容、または答えられない理由を入力してください。同じ内容は再表示できません。'); }
  if (action === 'new-experience') navigate('candidate/new');
  if (action === 'select-experience') { selectExperience(state,button.dataset.id); changesReviewed = false; save(); navigate(candidatePath()); }
  if (action === 'to-candidate') navigate(candidatePath());
  if (action === 'to-recruiter') navigate('recruiter');
  if (action === 'choose') {
    if (hasExperience()) addExperience(state);
    state.draft ||= createState().draft;
    if (!state.draft.content.title.trim()) state.draft.content.title = button.dataset.choice === 'cafe' ? SAMPLE.title : '困っている人の話を聞いて、誰かにつないだ経験（架空）';
    state.screen = 'interview'; state.interviewIndex = 0; save(); navigate('candidate/interview/0');
  }
  if (action === 'sample' && state.draft) { state.draft.content[button.dataset.key] = SAMPLE[button.dataset.key]; save(); render(); toast('架空のサンプルを入れました。自由に直せます。'); }
  if (action === 'interview-back') { if (state.interviewIndex > 0) navigate(`candidate/interview/${state.interviewIndex - 1}`); else { state.screen = 'welcome'; save(); navigate('candidate/welcome'); } }
  if (action === 'interview-next') {
    if (!state.draft.content[questions[state.interviewIndex][0]].trim()) { toast('この項目を入力してから進んでください。架空例も使えます。'); return; }
    if (state.interviewIndex === 4) navigate('candidate/review'); else navigate(`candidate/interview/${state.interviewIndex + 1}`);
  }
  if (action === 'review-back') navigate(state.draft.baseVersion ? 'candidate/submitted' : 'candidate/interview/4');
  if (action === 'request-submit') requestSubmit();
  if (action === 'correct') { startCorrection(state); save(); navigate('candidate/review'); }
  if (action === 'cancel-correction') modal('訂正下書きを取り消しますか？', '<p>まだ提出していない訂正だけを削除します。提出済みの送付物と会話提案は残ります。</p>', '訂正下書きを取り消す', () => { cancelCorrection(state); save(); navigate('candidate/submitted'); });
  if (action === 'create-agenda') { createAgenda(state); save(); render(); }
  if (action === 'update-agenda') { beginAgendaRevision(state); changesReviewed = false; save(); render(); $('#agenda-revision-focus')?.focus(); }
  if (action === 'commit-agenda') { if (commitAgendaRevision(state,changesReviewed)) { changesReviewed = false; save(); render(); toast('人事が見直した議題文を保存しました。まだ提案は送られていません。'); } }
  if (action === 'request-proposal') {
    if (isStale(state)) return;
    modal('この議題を候補者に提案します', `${agendaView(state.agenda)}<p class="small">準備メモは含みません。デモ内に表示するだけで、メール送信・日程予約は行いません。</p>`, 'デモとして会話を提案', () => { const result = propose(state); save(); render(); toast(result.ok ? '候補者の画面に会話提案を表示しました' : result.reason); });
  }
  if (action === 'reset') modal('このデモの保存データを削除しますか？', '<p>このブラウザ内の下書き・提出版・議題・会話提案をすべて削除します。この操作は戻せません。</p>', '保存データを削除', () => { state = createState(); changesReviewed = false; save(); navigate('candidate/welcome'); toast('デモを最初の状態に戻しました'); });
});
$('#modal-cancel').addEventListener('click', () => { confirmAction = null; $('#confirmation').close(); });
$('#modal-confirm').addEventListener('click', () => { const action = confirmAction; confirmAction = null; $('#confirmation').close(); action?.(); });
$('#confirmation').addEventListener('cancel', () => { confirmAction = null; });
window.addEventListener('hashchange', () => { if ($('#confirmation').open) { confirmAction = null; $('#confirmation').close(); } render(); window.scrollTo(0, 0); });
window.addEventListener('storage', event => { if (event.key === STORAGE_KEY) { state = restore(event.newValue); changesReviewed = false; if ($('#confirmation').open) { confirmAction = null; $('#confirmation').close(); } render(false); toast('別タブで更新された内容を読み込みました'); } });
render();
