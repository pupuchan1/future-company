const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'stream-dot', 'stream-label', 'live-config', 'backend-state', 'mcp-config', 'page-notice',
  'call-state', 'call-help', 'conversation-heading', 'language', 'case-id', 'start-call', 'mute-call', 'end-call',
  'route-assignee', 'route-language', 'route-source',
  'audio-panel', 'remote-audio', 'play-audio', 'audio-notice', 'transcript', 'transcript-empty',
  'devices', 'requests', 'handoff-reason', 'handoff-summary', 'test-handoff', 'handoff-help',
  'clear-events', 'events',
].map((id) => [id, $(id)]));

const state = {
  config: null, active: null, handoffBusy: false, refreshBusy: false,
  requests: new Map(), transcripts: new Map(), eventIds: new Set(),
  recentTranscript: null, nextTranscript: 0,
};
const statusLabels = {
  requested: '呼び出しを要求', ringing: 'リングの応答を確認',
  accepted: '受話器の応答を確認', completed: '対応終了',
  unavailable: '呼び出し不可', cancelled: '取り消し済み',
};
const reasonLabels = {
  device_offline: 'デバイスが接続されていません', device_busy: 'デバイスが別の呼び出しに対応中です',
  ring_ack_timeout: 'リング開始の応答がありません', no_answer: '受話器の応答がありません',
  device_disconnected: 'デバイスが切断されました', device_fault: 'デバイスから異常が報告されました',
  capability_missing: '呼び出し機能がありません', command_delivery_failed: 'デバイスへ命令を送れませんでした',
  handling_timeout: '対応の完了を確認できませんでした', gateway_shutdown: '接続サーバーが終了しました',
};

ui['case-id'].value = `check-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;

function tag(element, text, tone = 'muted') {
  element.textContent = text;
  element.className = `tag ${tone}`;
}

function notice(text = '', error = false) {
  ui['page-notice'].textContent = text;
  ui['page-notice'].className = `notice${error ? ' error' : ''}`;
  ui['page-notice'].hidden = !text;
}

function log(type, message = '', error = false) {
  ui.events.querySelector('.empty-state')?.remove();
  const row = document.createElement('li');
  row.className = `event${error ? ' error' : ''}`;
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString('ja-JP', { hour12: false });
  const name = document.createElement('code');
  name.textContent = type;
  const detail = document.createElement('span');
  detail.textContent = String(message).slice(0, 500);
  row.append(time, name, detail);
  ui.events.prepend(row);
  while (ui.events.children.length > 120) ui.events.lastElementChild.remove();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message;
    throw new Error(detail ? `${detail} (HTTP ${response.status})` : `接続に失敗しました (HTTP ${response.status})`);
  }
  return body;
}

function updateControls() {
  const supported = window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection;
  ui['start-call'].disabled = !state.config?.live_configured || !!state.active || !supported;
  ui['end-call'].disabled = !state.active;
  ui['mute-call'].disabled = !state.active?.stream;
  ui.language.disabled = !!state.active;
  ui['case-id'].disabled = !!state.active;
  ui['test-handoff'].disabled = !state.config?.mcp_configured || state.handoffBusy || !ui['handoff-summary'].value.trim();
  if (!state.active) {
    ui['call-help'].textContent = !supported
      ? '音声接続にはHTTPSまたはlocalhostと、マイク・WebRTC対応のブラウザが必要です。'
      : state.config?.live_configured
        ? 'GPT Liveの総合受付へ接続します。採用の相談は採用担当へ、それ以外の判断・仕事の依頼はHaaS担当へ引き継ぎます。'
        : 'GPT Liveは未設定です。サーバー側のAPI設定が完了するまで会話を開始できません。';
  }
  if (!state.handoffBusy) {
    ui['handoff-help'].textContent = state.config?.mcp_configured
      ? 'このボタンは手動の配線確認です。実機が接続されている場合は電話が鳴ります。'
      : 'MCPは未設定です。サーバー側の接続設定を確認してください。';
  }
}

function renderDevices(devices) {
  ui.devices.replaceChildren();
  if (!devices.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '接続中の黒電話はありません。デバイスブリッジの接続を待っています。';
    ui.devices.append(empty);
    return;
  }
  for (const device of devices) {
    const row = document.createElement('div');
    row.className = `device${device.simulated ? ' simulated' : ''}`;
    const info = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = device.device_id ?? device.id ?? '黒電話';
    const description = document.createElement('small');
    description.textContent = device.simulated ? 'シミュレーター · 実機の確認ではありません' : '実機として接続 · リングと受話器は応答イベントで確認';
    info.append(title, description);
    const badge = document.createElement('span');
    tag(badge, device.simulated ? '模擬デバイス' : device.online === false ? '切断' : '実機ブリッジ', device.simulated ? 'amber' : device.online === false ? 'muted' : 'green');
    row.append(info, badge);
    ui.devices.append(row);
  }
}

function putRequest(record) {
  if (!record || typeof record !== 'object' || !record.handoff_id) return;
  const old = state.requests.get(record.handoff_id);
  if (old?.revision && record.revision && old.revision > record.revision) return;
  state.requests.set(record.handoff_id, { ...old, ...record });
  renderRequests();
}

function renderRequests() {
  ui.requests.replaceChildren();
  const records = [...state.requests.values()].sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))).slice(0, 20);
  if (!records.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '呼び出しはまだありません。';
    ui.requests.append(empty);
    return;
  }
  for (const record of records) {
    const row = document.createElement('article');
    row.className = 'request';
    const heading = document.createElement('div');
    heading.className = 'request-head';
    const id = document.createElement('span');
    id.className = 'request-id';
    id.textContent = record.case_id ?? record.handoff_id;
    const badge = document.createElement('span');
    tag(badge, statusLabels[record.status] ?? record.status ?? '状態不明', record.status === 'unavailable' ? 'red' : ['accepted', 'ringing'].includes(record.status) ? 'green' : 'muted');
    heading.append(id, badge);
    const summary = document.createElement('p');
    summary.textContent = record.summary ?? '';
    row.append(heading, summary);
    if (record.target_role || record.task || record.expected_result) {
      const task = document.createElement('p');
      task.textContent = [record.target_role && `担当: ${record.target_role}`, record.task && `依頼: ${record.task}`, record.expected_result && `返してほしい内容: ${record.expected_result}`].filter(Boolean).join(' / ');
      row.append(task);
    }
    if (record.status === 'completed') {
      const result = document.createElement('p');
      result.textContent = record.result?.text
        ? `${record.simulated ? '架空の模擬回答' : '届いた回答'} (${record.result.language}): ${record.result.text}`
        : '対応終了。回答本文は届いていません。';
      row.append(result);
    }
    if (record.simulated) {
      const simulated = document.createElement('p');
      simulated.className = 'simulated-note';
      simulated.textContent = '模擬デバイスの応答 · 実機リング／人間通話の証拠ではありません';
      row.append(simulated);
    }
    if (record.status === 'accepted') {
      const audio = document.createElement('p');
      audio.textContent = 'accepted · 受話器を取った応答です。人間との音声経路は未確認です。';
      row.append(audio);
    }
    if (record.unavailable_reason) {
      const detail = document.createElement('p');
      detail.textContent = reasonLabels[record.unavailable_reason] ?? record.unavailable_reason;
      row.append(detail);
    }
    ui.requests.append(row);
  }
}

async function refreshStatus() {
  if (state.refreshBusy) return;
  state.refreshBusy = true;
  try {
    const config = await api('/api/status');
    state.config = config;
    tag(ui['live-config'], config.live_configured ? '設定あり' : '未設定', config.live_configured ? 'green' : 'amber');
    tag(ui['mcp-config'], config.mcp_configured ? '設定あり' : '未設定', config.mcp_configured ? 'green' : 'amber');
    renderDevices(Array.isArray(config.devices) ? config.devices : []);
    for (const record of config.requests ?? []) putRequest(record);
    updateControls();
  } catch (error) {
    state.config = null;
    tag(ui['live-config'], '状態取得不可', 'red');
    tag(ui['mcp-config'], '状態取得不可', 'red');
    updateControls();
    notice('統合サーバーの状態を取得できません。サーバーの起動と接続先を確認してください。', true);
    log('status.error', error.message, true);
  } finally {
    state.refreshBusy = false;
  }
}

function transcript(event) {
  const body = event.data && typeof event.data === 'object' ? { ...event, ...event.data } : event;
  const type = event.type ?? event.name ?? '';
  const delta = typeof body.delta === 'string' ? body.delta : body.delta?.text ?? body.delta?.transcript;
  const full = typeof body.transcript === 'string' ? body.transcript : body.text ?? body.transcript?.text;
  const text = delta ?? full;
  if (typeof text !== 'string' || !text) return;
  const speaker = body.role ?? body.speaker ?? body.transcript?.role ?? (type.includes('input') ? 'user' : 'assistant');
  const role = speaker === 'user' || speaker === 'human' ? 'user' : speaker === 'system' ? 'system' : 'assistant';
  const explicitId = body.item_id ?? body.utterance_id ?? body.transcript_id ?? body.segment_id ?? body.transcript?.id;
  const now = Date.now();
  let key = explicitId ? `${role}:${explicitId}` : null;
  if (!key && state.recentTranscript?.role === role && now - state.recentTranscript.at < 8000 && !state.recentTranscript.done) key = state.recentTranscript.key;
  if (!key) key = `${role}:local-${++state.nextTranscript}`;
  const wasNearBottom = ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 80;
  let entry = state.transcripts.get(key);
  if (!entry) {
    ui['transcript-empty']?.remove();
    const row = document.createElement('article');
    row.className = `utterance ${role}`;
    const label = document.createElement('div');
    label.className = 'speaker';
    label.textContent = role === 'user' ? 'あなた' : role === 'system' ? 'システム' : 'AI';
    const message = document.createElement('p');
    row.append(label, message);
    ui.transcript.append(row);
    entry = { row, message, text: '' };
    state.transcripts.set(key, entry);
    while (state.transcripts.size > 100) {
      const first = state.transcripts.keys().next().value;
      state.transcripts.get(first).row.remove();
      state.transcripts.delete(first);
    }
  }
  entry.text = delta !== undefined ? entry.text + text : text;
  entry.message.textContent = entry.text;
  state.recentTranscript = { key, role, at: now, done: /completed|done|final/.test(type) || body.is_final === true };
  if (wasNearBottom) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  log(type, `${role === 'user' ? 'あなた' : 'AI'}: ${text}`);
}

function handleEvent(event, source = 'server', connection = null) {
  if (!event || typeof event !== 'object') return;
  if (connection && state.active !== connection) return;
  const type = event.type ?? event.name ?? 'event';
  const body = event.data && typeof event.data === 'object' ? event.data : event;
  const eventId = event.event_id ?? event.eventId;
  if (eventId && state.eventIds.has(eventId)) return;
  if (eventId) {
    state.eventIds.add(eventId);
    if (state.eventIds.size > 500) state.eventIds.delete(state.eventIds.values().next().value);
  }
  if (type === 'session.started') {
    const current = connection ?? state.active;
    const id = body.session?.id ?? body.session_id;
    if (current && (!id || !current.sessionId || id === current.sessionId)) {
      current.started = true;
      clearTimeout(current.startTimer);
      tag(ui['call-state'], '会話中', 'green');
      ui['call-help'].textContent = '音声セッションが開始しました。マイクで話しかけてください。';
      log(type, 'GPT Liveの開始イベントを確認しました。');
    }
    return;
  }
  if (type.includes('transcript')) {
    if (body.case_id && body.case_id !== ui['case-id'].value) return;
    transcript(event);
    return;
  }
  if (type === 'routing.updated') {
    if (body.case_id && body.case_id !== ui['case-id'].value) return;
    const role = body.route === 'recruiting' ? '採用担当' : body.route === 'haas' ? 'HaaS担当' : '総合受付';
    const language = body.language === 'en' ? 'English' : '日本語';
    const sourceLabel = body.source === 'decisions' ? 'Decisionsによる判定' : body.source === 'backend' ? '業務処理から切替' : '担当を更新';
    ui['route-assignee'].textContent = role;
    ui['route-language'].textContent = language;
    ui['route-source'].textContent = sourceLabel;
    ui['conversation-heading'].textContent = `${role}と話す`;
    log(type, `${role} · ${language} · ${sourceLabel}`);
    return;
  }
  if (type.startsWith('human.')) {
    const record = body.request ?? body.handoff ?? body;
    putRequest(record);
    const status = record.status ?? type.slice('human.'.length);
    log(type, `${record.simulated ? '模擬 · ' : ''}${statusLabels[status] ?? status}${status === 'accepted' ? '（音声通話は未確認）' : ''}`);
    void refreshStatus();
    return;
  }
  if (type === 'backend.started') {
    if (body.case_id && body.case_id !== ui['case-id'].value) return;
    tag(ui['backend-state'], '処理中', 'dark');
    log(type, `${body.route === 'haas' ? 'HaaS担当' : body.route === 'recruiting' ? '採用担当' : '受付担当'}の業務処理へ委譲しました。`);
    return;
  }
  if (type === 'backend.result') {
    if (body.case_id && body.case_id !== ui['case-id'].value) return;
    tag(ui['backend-state'], '結果受信', 'green');
    const summary = body.content ?? (typeof body.result === 'string' ? body.result : body.summary ?? body.result?.summary);
    log(type, typeof summary === 'string' ? summary : '担当の業務処理の結果を受信しました。');
    return;
  }
  if (type === 'backend.error') {
    if (body.case_id && body.case_id !== ui['case-id'].value) return;
    tag(ui['backend-state'], 'エラー', 'red');
    log(type, body.error?.message ?? body.message ?? '業務処理に失敗しました。', true);
    return;
  }
  if (type === 'error' || type.endsWith('.error')) {
    const message = body.error?.message ?? body.message ?? '接続先からエラーを受信しました。';
    log(type, message, true);
    notice(message, true);
    if (source === 'datachannel' && connection) void stopCall('音声接続にエラーが発生しました。');
    return;
  }
  if (type === 'session.ended' || type === 'session.closed') {
    log(type, '音声セッションが終了しました。');
    if (source === 'datachannel' && connection) void stopCall();
    return;
  }
  if (type.startsWith('device.')) void refreshStatus();
  log(type, source === 'datachannel' ? '音声イベントを受信' : 'サーバーイベントを受信');
}

async function deleteSession(id, keepalive = false) {
  if (!id) return;
  try {
    const result = await api(`/api/live/session/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive });
    log('session.deleted', result.live_finalized === true
      ? '音声セッションの終了応答を確認しました。'
      : '終了を要求しました。音声セッションの最終応答は未確認です。');
    if (result.cleanup_pending?.length) notice('バックエンドの後片付けが一部残っています。サーバー側の記録を確認してください。', true);
  } catch (error) {
    log('session.delete.error', error.message, true);
    notice('マイクとブラウザの接続は停止しました。サーバー側のセッション終了は確認できませんでした。', true);
  }
}

function release(connection) {
  clearTimeout(connection.startTimer);
  clearTimeout(connection.disconnectTimer);
  connection.stream?.getTracks().forEach((track) => track.stop());
  if (connection.channel) {
    connection.channel.onmessage = null;
    connection.channel.onclose = null;
    connection.channel.close();
  }
  if (connection.pc) {
    connection.pc.ontrack = null;
    connection.pc.onconnectionstatechange = null;
    connection.pc.close();
  }
}

async function stopCall(message = '', keepalive = false) {
  const connection = state.active;
  if (!connection) return;
  state.active = null;
  connection.stopped = true;
  // Stop capture immediately, but keep the transport alive for session.closed.
  connection.stream?.getTracks().forEach((track) => track.stop());
  ui['remote-audio'].pause();
  ui['remote-audio'].srcObject = null;
  ui['audio-panel'].hidden = true;
  ui['play-audio'].hidden = true;
  ui['audio-notice'].hidden = true;
  ui['mute-call'].textContent = 'マイクをミュート';
  ui['mute-call'].setAttribute('aria-pressed', 'false');
  tag(ui['call-state'], message ? '接続終了' : '待機中', message ? 'amber' : 'muted');
  updateControls();
  if (message) notice(message, true);
  log('local.stopped', 'マイクを停止し、セッションを終了しています。');
  if (connection.sessionId) await deleteSession(connection.sessionId, keepalive);
  release(connection);
}

async function playAudio(connection = state.active) {
  if (!connection || state.active !== connection) return;
  try {
    await ui['remote-audio'].play();
    if (state.active !== connection) return;
    ui['play-audio'].hidden = true;
    ui['audio-notice'].hidden = true;
  } catch {
    if (state.active !== connection) return;
    ui['play-audio'].hidden = false;
    ui['audio-notice'].textContent = 'ブラウザが音声の自動再生を止めています。「音声の再生を許可」を押してください。';
    ui['audio-notice'].hidden = false;
    log('audio.playback_blocked', '音声の再生にはボタン操作が必要です。');
  }
}

function waitForIce(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', changed);
      resolve();
    };
    const changed = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, 2000);
    pc.addEventListener('icegatheringstatechange', changed);
  });
}

function microphoneError(error) {
  if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') return 'マイクが許可されていません。ブラウザのサイト設定でマイクを許可し、もう一度開始してください。';
  if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') return '使用できるマイクが見つかりません。接続を確認してください。';
  if (error.name === 'NotReadableError' || error.name === 'TrackStartError') return 'マイクを使用できません。ほかのアプリで占有されていないか確認してください。';
  return error.message || '音声接続を開始できませんでした。';
}

async function startCall() {
  if (state.active || !state.config?.live_configured) return;
  notice();
  const connection = { sessionId: null, stopped: false, started: false };
  state.active = connection;
  ui['conversation-heading'].textContent = '総合受付と話す';
  ui['route-assignee'].textContent = '総合受付';
  ui['route-language'].textContent = ui.language.value === 'en' ? 'English' : '日本語';
  ui['route-source'].textContent = '担当切替を待機';
  tag(ui['call-state'], '接続中', 'amber');
  ui['call-help'].textContent = 'マイクの許可と音声接続を確認しています。';
  updateControls();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    if (state.active !== connection) { stream.getTracks().forEach((track) => track.stop()); return; }
    connection.stream = stream;
    updateControls();
    const pc = new RTCPeerConnection();
    connection.pc = pc;
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    pc.ontrack = (event) => {
      if (state.active !== connection) return;
      ui['remote-audio'].srcObject = event.streams[0] ?? new MediaStream([event.track]);
      ui['audio-panel'].hidden = false;
      void playAudio(connection);
    };
    pc.onconnectionstatechange = () => {
      if (state.active !== connection) return;
      log('webrtc.state', pc.connectionState);
      clearTimeout(connection.disconnectTimer);
      if (pc.connectionState === 'failed') void stopCall('音声通信に失敗しました。ネットワークを確認して再接続してください。');
      if (pc.connectionState === 'disconnected') {
        tag(ui['call-state'], '再接続待ち', 'amber');
        connection.disconnectTimer = setTimeout(() => void stopCall('音声接続が切断されました。もう一度開始してください。'), 10000);
      }
      if (pc.connectionState === 'connected' && connection.started) tag(ui['call-state'], '会話中', 'green');
    };
    const channel = pc.createDataChannel('oai-events');
    connection.channel = channel;
    channel.onmessage = (event) => {
      try { handleEvent(JSON.parse(event.data), 'datachannel', connection); }
      catch { log('event.parse_error', '読み取れない音声イベントを受信しました。', true); }
    };
    channel.onclose = () => { if (state.active === connection) void stopCall('音声イベントの接続が終了しました。'); };
    const offer = await pc.createOffer();
    if (state.active !== connection) return;
    await pc.setLocalDescription(offer);
    await waitForIce(pc);
    if (state.active !== connection) return;
    const caseId = ui['case-id'].value.trim() || `check-${Date.now()}`;
    ui['case-id'].value = caseId;
    const created = await api('/api/live/session', {
      method: 'POST',
      body: JSON.stringify({ sdp: pc.localDescription.sdp, language: ui.language.value, case_id: caseId }),
    });
    connection.sessionId = created.session?.id ?? created.session_id;
    if (state.active !== connection) { await deleteSession(connection.sessionId); return; }
    if (created.case_id) ui['case-id'].value = created.case_id;
    const answer = created.transport?.sdp;
    if (typeof answer !== 'string' || !connection.sessionId) throw new Error('音声セッションの応答にSDPまたはセッションIDがありません。');
    log('session.created', 'WebRTCのセッションを作成しました。開始イベントを待っています。');
    ui['call-help'].textContent = 'GPT Liveの開始イベントを待っています。';
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    if (state.active !== connection) return;
    // The HTTP create operation starts the session; do not send session.start.
    // No data-channel command is sent before session.started.
    if (!connection.started) connection.startTimer = setTimeout(() => void stopCall('音声セッションの開始を確認できませんでした。接続を終了しました。'), 20000);
  } catch (error) {
    if (state.active !== connection) return;
    log('call.error', microphoneError(error), true);
    await stopCall(microphoneError(error));
  }
}

async function testHandoff() {
  if (state.handoffBusy || !state.config?.mcp_configured) return;
  const summary = ui['handoff-summary'].value.trim();
  if (!summary) return;
  state.handoffBusy = true;
  updateControls();
  ui['handoff-help'].textContent = '手動の配線確認としてMCPツールを呼び出しています。';
  try {
    const result = await api('/api/demo/handoff', {
      method: 'POST', body: JSON.stringify({
        case_id: ui['case-id'].value.trim() || `wiring-${Date.now()}`,
        reason: ui['handoff-reason'].value, summary, language: ui.language.value,
      }),
    });
    const record = result.request ?? result.handoff ?? result;
    putRequest(record);
    log('manual.mcp_handoff', `${record.simulated ? '模擬デバイス · ' : ''}配線確認: ${statusLabels[record.status] ?? record.status ?? '結果を受信'}`);
    notice(record.simulated
      ? '模擬デバイスへのMCP配線確認を実行しました。実機の呼び出し・AIによる判断は未確認です。'
      : 'MCPの配線確認を実行しました。呼び出し履歴でデバイスの応答を確認してください。');
    await refreshStatus();
  } catch (error) {
    log('manual.mcp_error', error.message, true);
    notice(`MCPの配線確認に失敗しました。${error.message}`, true);
  } finally {
    state.handoffBusy = false;
    updateControls();
  }
}

ui['start-call'].addEventListener('click', startCall);
ui['end-call'].addEventListener('click', () => void stopCall());
ui['play-audio'].addEventListener('click', () => void playAudio());
ui['mute-call'].addEventListener('click', () => {
  const tracks = state.active?.stream?.getAudioTracks() ?? [];
  if (!tracks.length) return;
  const muted = tracks.some((track) => track.enabled);
  tracks.forEach((track) => { track.enabled = !muted; });
  ui['mute-call'].textContent = muted ? 'ミュートを解除' : 'マイクをミュート';
  ui['mute-call'].setAttribute('aria-pressed', String(muted));
});
ui['test-handoff'].addEventListener('click', testHandoff);
ui['handoff-summary'].addEventListener('input', updateControls);
ui['clear-events'].addEventListener('click', () => ui.events.replaceChildren());

const events = new EventSource('/api/events');
events.onopen = () => {
  ui['stream-dot'].className = 'dot online';
  ui['stream-label'].textContent = 'イベント接続中';
  log('events.connected', 'サーバーのイベントを受信しています。');
  void refreshStatus();
};
events.onmessage = (event) => {
  try { handleEvent(JSON.parse(event.data)); }
  catch { log('events.parse_error', '読み取れないサーバーイベントを受信しました。', true); }
};
events.onerror = () => {
  ui['stream-dot'].className = 'dot error';
  ui['stream-label'].textContent = 'イベント再接続待ち';
};
void refreshStatus();
const statusTimer = setInterval(() => void refreshStatus(), 10000);
window.addEventListener('pagehide', () => {
  events.close();
  clearInterval(statusTimer);
  void stopCall('', true);
});
