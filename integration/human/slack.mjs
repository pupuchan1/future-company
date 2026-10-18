const knownErrors = new Set(['missing_scope', 'invalid_auth', 'not_authed', 'not_in_channel', 'channel_not_found', 'ratelimited', 'token_revoked', 'not_allowed_token_type', 'thread_not_found', 'account_inactive']);
const safeError = value => knownErrors.has(value) ? `slack_${value}` : 'slack_api_error';
const escapeText = value => String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');


function workPayload(record) {
  const sections = [`依頼内容（お客様のお話）\n${record.summary || record.task}`,
    `必要な担当・スキル\n${record.target_role || 'ご依頼の内容に対応できる方'}`,
    `お願い\n${record.expected_result}`];
  const footer = '対応可能な方は、このスレッドに「対応します」などと返信してください。AIがお客様へお伝えします。';
  return { text: ['仕事の依頼が届きました', ...sections, footer].map(escapeText).join('\n'),
    blocks: [{ type: 'header', text: { type: 'plain_text', text: '仕事の依頼が届きました', emoji: false } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '<!here> 作業担当の方、ご確認と返信をお願いします。' }] },
      ...sections.map(text => ({ type: 'section', text: { type: 'plain_text', text: text.slice(0, 2900), emoji: false } })),
      { type: 'context', elements: [{ type: 'plain_text', text: `${footer}\n案件: ${record.case_id} / 相談: ${record.handoff_id}`, emoji: false }] }] };
}

/** Fixed-channel, server-only transport. A notification is never human acceptance. */
export function createSlackHumanTransport({ botToken = '', userToken = '', channelId = '', fetcher = fetch,
  pollIntervalMs = 5000, timeoutMs = 10000 } = {}) {
  const configured = Boolean((botToken || userToken) && /^[CG][A-Z0-9]+$/.test(channelId));
  const pending = new Map();
  const threads = new Map();
  const caseQueues = new Map();
  const notifications = new Map();
  const interviewReports = new Map();
  const introControllers = new Map();
  const replyToken = userToken || botToken;
  let closed = false;
  let polling = false;
  let nextPoll = 0;
  async function api(method, input, token, signal) {
    const url = new URL(`https://slack.com/api/${method}`);
    const reading = method === 'conversations.replies';
    if (reading) for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetcher(url, { method: reading ? 'GET' : 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${token}`, ...(reading ? {} : { 'Content-Type': 'application/json' }) },
        ...(reading ? {} : { body: JSON.stringify(input) }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
      if (response.status === 429) {
        nextPoll = Date.now() + Math.max(60000, (Number(response.headers.get('retry-after')) || 60) * 1000);
        throw Object.assign(new Error(), { safeCode: 'slack_ratelimited' });
      }
      const value = await response.json();
      if (!response.ok || value.ok !== true) throw Object.assign(new Error(), { safeCode: safeError(value.error) });
      return value;
    } catch (error) {
      throw Object.assign(new Error('Slack operation failed.'), { safeCode: error.safeCode || (reading ? 'slack_read_failed' : 'slack_delivery_unknown') });
    }
  }
  function alive(entry) { return !closed && !entry.controller.signal.aborted && entry.hooks.isActive(); }
  function remove(entry) { pending.delete(entry.record.handoff_id); entry.controller.abort(); }
  async function postCase(caseId, payload, signal, independent = false) {
    const task = (caseQueues.get(caseId) || Promise.resolve()).catch(() => {}).then(async () => {
      if (closed || signal.aborted) throw Object.assign(new Error(), { safeCode: 'slack_cancelled' });
      const prior = independent ? null : threads.get(caseId);
      const posted = await api('chat.postMessage', { channel: channelId, ...payload,
        ...(prior ? { thread_ts: prior } : {}), mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false }, botToken || userToken, signal);
      if (closed || signal.aborted) throw Object.assign(new Error(), { safeCode: 'slack_cancelled' });
      if (posted.channel !== channelId || !/^\d+\.\d+$/.test(posted.ts || '')) throw Object.assign(new Error(), { safeCode: 'slack_delivery_unknown' });
      const root = prior || posted.ts;
      if (!independent) threads.set(caseId, root);
      return { posted, root };
    });
    caseQueues.set(caseId, task);
    return task;
  }
  async function updateWork(record) {
    const entry = pending.get(record.handoff_id);
    if (!entry || !alive(entry) || entry.record.request_kind !== 'work') return;
    entry.record = record;
    if (!entry.ts || entry.updating) return;
    entry.updating = true;
    try {
      do {
        const current = entry.record;
        await api('chat.update', { channel: channelId, ts: entry.sinceTs, ...workPayload(current),
          mrkdwn: false, parse: 'none' }, botToken || userToken, entry.controller.signal);
        if (!alive(entry) || current === entry.record) break;
      } while (alive(entry));
    } catch (error) { if (alive(entry)) entry.hooks.update({ detail_update_error: error.safeCode }); }
    finally { entry.updating = false; }
  }
  async function pollOnce() {
    if (closed || polling || Date.now() < nextPoll || !replyToken) return;
    const entry = [...pending.values()].find(item => item.ts && alive(item));
    if (!entry) return;
    pending.delete(entry.record.handoff_id); pending.set(entry.record.handoff_id, entry);
    polling = true;
    nextPoll = Date.now() + Math.max(5000, pollIntervalMs);
    try {
      const page = await api('conversations.replies', { channel: channelId, ts: entry.ts, limit: 15,
        ...(entry.cursor ? { cursor: entry.cursor } : {}) }, replyToken, entry.controller.signal);
      if (!alive(entry)) return;
      for (const message of Array.isArray(page.messages) ? page.messages : []) {
        if (message.bot_id || message.app_id || message.subtype || !/^[UW][A-Z0-9]+$/.test(message.user || '')
          || message.thread_ts !== entry.ts || !(Number(message.ts) > Number(entry.sinceTs))) continue;
        const answer = /^(回答|answer)\s*[:：]\s*([\s\S]+)$/i.exec(String(message.text || '').trim());
        const reply = answer?.[2]?.trim() || (entry.record.request_kind === 'work' ? String(message.text || '').trim() : '');
        if (!reply || reply.length > 4000) continue;
        entry.hooks.complete({ text: reply, language: answer ? (answer[1] === '回答' ? 'ja' : 'en') : entry.record.language },
          { result_source: 'slack_thread', slack_reply_ts: message.ts, slack_user_id: message.user });
        remove(entry);
        return;
      }
      entry.cursor = page.response_metadata?.next_cursor || '';
    } catch (error) {
      if (!alive(entry)) return;
      entry.hooks.update({ reply_status: 'unavailable', reply_error: error.safeCode });
      if (!['slack_ratelimited', 'slack_read_failed'].includes(error.safeCode)) {
        entry.hooks.fail(error.safeCode);
        remove(entry);
      }
    } finally { polling = false; }
  }
  const timer = setInterval(() => { void pollOnce(); }, Math.max(5000, pollIntervalMs));
  timer.unref?.();
  return {
    configured, repliesConfigured: configured && Boolean(replyToken), pollOnce, updateWork,
    completeInterview(input, { isActive = () => true } = {}) {
      if (interviewReports.has(input.case_id)) return interviewReports.get(input.case_id);
      if (interviewReports.size >= 1000) return Promise.resolve({ notification_status: 'unavailable', error: 'capacity_reached' });
      const controller = new AbortController();
      introControllers.set(`report:${input.case_id}`, controller);
      const result = (async () => {
        const base = { case_id: input.case_id, transport: 'slack', kind: 'interview_completed', simulated: false };
        if (!configured || closed || !isActive()) return { ...base, notification_status: 'unavailable', error: 'slack_unconfigured_or_inactive' };
        const sections = [
          `相談者について（本人のお話）\n${input.applicant_summary || '氏名・経歴はまだ伺っていません。'}`,
          `面接の要点\n${input.interview_summary}`,
          `次に対応してほしいこと\n${input.next_actions.length ? input.next_actions.map(item => `・${item}`).join('\n') : '面接内容をご確認ください。'}`,
        ];
        try {
          const { root } = await postCase(input.case_id, {
            text: ['面接が終了しました', ...sections].map(escapeText).join('\n'),
            blocks: [{ type: 'header', text: { type: 'plain_text', text: '面接が終了しました', emoji: false } },
              { type: 'context', elements: [{ type: 'mrkdwn', text: '<!here> 採用担当の方、面接内容の確認をお願いします。' }] },
              ...sections.map(text => ({ type: 'section', text: { type: 'plain_text', text: text.slice(0, 2900), emoji: false } })),
              { type: 'context', elements: [{ type: 'plain_text', text: `本人の終了希望により共有しました。\n案件: ${input.case_id}`, emoji: false }] }],
          }, controller.signal, true);
          return { ...base, notification_status: isActive() ? 'sent' : 'cancelled', slack_thread_ts: root };
        } catch (error) { return { ...base, notification_status: 'unavailable', error: error.safeCode || 'slack_delivery_unknown' }; }
        finally { introControllers.delete(`report:${input.case_id}`); }
      })();
      interviewReports.set(input.case_id, result);
      return result;
    },
    notifyRecruiter(input, { isActive = () => true } = {}) {
      if (notifications.has(input.case_id)) return notifications.get(input.case_id);
      if (notifications.size >= 1000) return Promise.resolve({ transport: 'slack', notification_status: 'unavailable', error: 'capacity_reached' });
      const controller = new AbortController(); introControllers.set(input.case_id, controller);
      const result = (async () => {
        const base = { case_id: input.case_id, transport: 'slack', kind: 'recruiting_arrival', simulated: false };
        if (!configured || closed || !isActive()) return { ...base, notification_status: 'unavailable', error: 'slack_unconfigured_or_inactive' };
        if (threads.has(input.case_id)) return { ...base, notification_status: 'sent', slack_thread_ts: threads.get(input.case_id) };
        const facts = !input.applicant_summary || /^No applicant facts stated\.?$/i.test(input.applicant_summary.trim())
          ? '氏名・経歴はまだ伺っていません。' : input.applicant_summary;
        try {
          const { root } = await postCase(input.case_id, {
            text: escapeText(`採用のご相談が届きました。\n相談者から伺ったこと: ${facts}\nAIが一次対応中です。確認が必要になったら、このスレッドでお知らせします。`),
            blocks: [{ type: 'header', text: { type: 'plain_text', text: '採用のご相談が届きました', emoji: false } },
              { type: 'context', elements: [{ type: 'mrkdwn', text: '<!here> 採用受付への新しい相談です。' }] },
              { type: 'section', text: { type: 'plain_text', text: `相談者から伺ったこと\n${facts}`, emoji: false } },
              { type: 'context', elements: [{ type: 'plain_text', text: `AIが一次対応中です。確認が必要になったら、このスレッドでお知らせします。\n案件: ${input.case_id}`, emoji: false }] }],
          }, controller.signal);
          return isActive() ? { ...base, notification_status: 'sent', slack_thread_ts: root }
            : { ...base, notification_status: 'cancelled' };
        } catch (error) { return { ...base, notification_status: 'unavailable', error: error.safeCode || 'slack_delivery_unknown' }; }
        finally { introControllers.delete(input.case_id); }
      })();
      notifications.set(input.case_id, result);
      return result;
    },
    start(record, hooks) {
      const entry = { record, hooks, controller: new AbortController(), ts: null, cursor: '' };
      if (!configured || closed) { hooks.fail('slack_unconfigured'); return () => {}; }
      pending.set(record.handoff_id, entry);
      void (async () => {
        try {
          const work = record.request_kind === 'work';
          const title = work ? '仕事の依頼が届きました' : '採用担当への確認';
          const sections = work ? [`依頼内容（お客様のお話）\n${record.summary || record.task}`,
            `必要な担当・スキル\n${record.target_role || 'ご依頼の内容に対応できる方'}`,
            `お願い\n${record.expected_result}`] : [`確認してほしいこと\n${record.task || record.summary}`,
            `相談者について（本人のお話）\n${record.applicant_summary || '氏名・経歴はまだ伺っていません。'}`,
            ...(record.summary && record.summary !== record.task ? [`補足\n${record.summary}`] : []),
            `回答してほしい内容\n${record.expected_result || '質問への回答をお願いします。未確認であれば、その旨をお知らせください。'}`];
          const footer = work ? '対応可能な方は、このスレッドに「対応します」などと返信してください。AIがお客様へお伝えします。' : 'このスレッドに「回答: 内容」で返信してください。AIが相談者へお伝えし、会話を続けます。英語は「answer: text」でも返信できます。';
          const blocks = [{ type: 'header', text: { type: 'plain_text', text: title, emoji: false } },
            work ? { type: 'context', elements: [{ type: 'mrkdwn', text: '<!here> 作業担当の方、ご確認と返信をお願いします。' }] }
              : { type: 'context', elements: [{ type: 'plain_text', text: '採用担当の方、ご確認と返信をお願いします。', emoji: false }] },
            ...sections.map(text => ({ type: 'section', text: { type: 'plain_text', text: text.slice(0, 2900), emoji: false } })),
            { type: 'context', elements: [{ type: 'plain_text', text: `${footer}\n案件: ${record.case_id} / 相談: ${record.handoff_id}`, emoji: false }] }];
          const text = [title, ...sections, footer].map(escapeText).join('\n').slice(0, 9000);
          const { posted, root } = await postCase(record.case_id, { ...(work ? workPayload(record) : { text, blocks }), client_msg_id: record.handoff_id }, entry.controller.signal, work);
          if (!alive(entry)) return;
          if (posted.channel !== channelId || !/^\d+\.\d+$/.test(posted.ts || '')) throw Object.assign(new Error(), { safeCode: 'slack_delivery_unknown' });
          entry.ts = root;
          entry.sinceTs = posted.ts;
          threads.set(record.case_id, entry.ts);
          if (entry.record !== record) void updateWork(entry.record);
          hooks.update({ notification_status: 'sent', slack_thread_ts: entry.ts,
            reply_status: replyToken ? 'polling' : 'unconfigured' });
        } catch (error) {
          if (alive(entry)) { hooks.update({ notification_status: error.safeCode === 'slack_delivery_unknown' ? 'unknown' : 'failed' }); hooks.fail(error.safeCode || 'slack_delivery_unknown'); }
          remove(entry);
        }
      })();
      return () => remove(entry);
    },
    closeCase(caseId) {
      introControllers.get(caseId)?.abort();
      introControllers.get(`report:${caseId}`)?.abort();
      for (const entry of pending.values()) if (entry.record.case_id === caseId) remove(entry);
    },
    close() { closed = true; clearInterval(timer); for (const controller of introControllers.values()) controller.abort(); for (const entry of pending.values()) entry.controller.abort(); pending.clear(); },
  };
}
