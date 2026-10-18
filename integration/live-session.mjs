import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { readRouting, routingQuestions } from './backend.mjs';

export function liveConfig({ model = 'gpt-live-1', voice = 'shida', language = 'ja', decisions = true } = {}) {
  return {
    model, store: false, audio: { output: { voice } }, delegation: { type: 'client' },
    client: { data_channel: { allowed_client_events: [], allowed_server_events: [
      'session.started', 'session.closed', 'session.input_transcript.delta', 'session.output_transcript.delta', 'error',
    ] } },
    instructions: `You are the friendly voice receptionist for a fictional recruitment demo. Start in ${language === 'en' ? 'English' : 'Japanese'}.
Ask what the caller needs. When they ask about a job or interview, explain you will connect them to the recruitment assistant and delegate.
Delegate interview questions, answers, job facts, requests for humans, cancellation and work requiring judgment to the backend. Do not invent business facts or make hiring decisions. Keep chatting briefly while work is pending without announcing success.
The backend provides the exact next question or verified action result. Ask only one question at a time. Speak the user's preferred language. Do not infer nationality. When backend changes department, announce that once, then follow its interviewing context; your voice remains the same.
Only say the phone rang or someone answered when backend confirms. Handset pickup does not mean human audio is connected. Say clearly when a device is simulated or unavailable. Never claim the user is hired or rejected.
Greet briefly and ask whether they are here for an interview.`,
    ...(decisions ? { triggers: [{ type: 'decisions', event_type: 'session.input_transcript.delta', decisions: { questions: routingQuestions } }] } : {}),
  };
}

export class LiveConversation {
  constructor({ id, caseId, language, apiKey, backend, emit, handoffs, onClose, remember }) {
    Object.assign(this, { id, caseId, backend, emit, handoffs, onClose, remember });
    this.routing = { route: 'reception', language };
    this.history = [];
    this.seen = new Set();
    this.queue = Promise.resolve();
    this.closed = false;
    this.lastInputId = null;
    this.ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(id)}/attach`, {
      headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 15000,
    });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', () => reject(new Error('Live sideband connection failed.')));
    });
    this.ws.on('message', (bytes) => {
      try { this.handle(JSON.parse(bytes.toString())); }
      catch { this.emit({ type: 'backend.error', case_id: this.caseId, message: 'Live event processing failed.' }); }
    });
    this.ws.on('error', () => this.emit({ type: 'backend.error', case_id: this.caseId, message: 'Live sideband disconnected.' }));
    this.ws.on('close', () => { if (!this.closed) void this.close(); });
    this.expiry = setTimeout(() => void this.close(), 15 * 60 * 1000);
    this.expiry.unref?.();
  }

  send(type, values) {
    if (!this.closed && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, event_id: randomUUID(), ...values }));
  }

  transcript() {
    return this.history.map((event) => `${event.type.includes('input_') ? 'user' : 'assistant'}: ${event.delta}`).join('\n').slice(-14000);
  }

  updateRouting(next, source) {
    if (next.route === this.routing.route && next.language === this.routing.language) return;
    this.routing = next;
    this.emit({ type: 'routing.updated', case_id: this.caseId, ...next, source });
    this.send('session.instructions.append', { delegation_id: null,
      content: `The app has routed this conversation to ${next.route === 'recruiting' ? 'the recruitment interview specialist' : 'general reception'}. Speak ${next.language === 'en' ? 'English' : 'Japanese'}. Announce a department change once when relevant. This is a specialist backend context change; do not say the voice or person changed.` });
  }

  handle(event) {
    if (this.closed) return;
    if (event.type === 'session.closed') { this.emit({ type: 'live.closed', case_id: this.caseId }); void this.close(); return; }
    if (event.type === 'error') { this.emit({ type: 'backend.error', case_id: this.caseId, message: `Live error: ${event.error?.code || 'unknown'}` }); return; }
    if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      if (this.seen.has(event.event_id)) return;
      this.seen.add(event.event_id);
      this.history.push(event);
      if (this.history.length > 1000) this.history.shift();
      if (event.type === 'session.input_transcript.delta') this.lastInputId = event.event_id;
      this.emit({ ...event, case_id: this.caseId });
    }
    if (event.type === 'decision.event' && event.event?.type === 'decision.completed'
      && event.source_event_id === this.lastInputId && event.source_event_type === 'session.input_transcript.delta') {
      this.updateRouting(readRouting(event.event.decision.answers, this.routing), 'decisions');
    }
    if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
      const id = event.delegation.id;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      this.enqueue(id, 'delegation');
    }
  }

  enqueue(delegationId, source, extra = '') {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      let transcript = this.transcript();
      if (!transcript.trim()) {
        this.send('session.commentary.append', { delegation_id: delegationId, content: 'まだ会話の文字起こしが届いていません。ご用件をもう一度お願いします。' });
        return;
      }
      if (source === 'delegation') {
        const sourceId = this.lastInputId;
        const next = await this.backend.classify(transcript, this.routing);
        // Never let a delayed classifier override more recent speech.
        if (sourceId === this.lastInputId) this.updateRouting(next, 'decisions');
        transcript = this.transcript();
      }
      if (this.closed) return;
      const content = await this.backend.run({ caseId: this.caseId, ...this.routing,
        transcript: transcript + extra, handoffs: this.handoffs(), source });
      this.send('session.commentary.append', { delegation_id: delegationId, content: content.slice(0, 700) });
    }).catch((error) => {
      this.emit({ type: 'backend.error', case_id: this.caseId, message: error.status ? `Provider HTTP ${error.status}` : error.message.slice(0, 180) });
      this.send('session.commentary.append', { delegation_id: delegationId, content: this.routing.language === 'en'
        ? 'The backend could not complete this request. No successful human connection has been confirmed.'
        : '担当の処理を完了できませんでした。人間への接続が成功したとは確認できていません。' });
    });
    return this.queue;
  }

  humanEvent(event) {
    if (this.closed || event.data.case_id !== this.caseId) return;
    if (['human.accepted', 'human.completed', 'human.unavailable', 'human.cancelled'].includes(event.name)) {
      this.enqueue(null, 'human_event', `\nVerified device event: ${JSON.stringify(event.data)}. Report this status only; do not create another request.`);
    }
  }

  async close() {
    if (this.closed) return;
    this.send('session.close', {});
    this.closed = true;
    clearTimeout(this.expiry);
    // Closing the observer alone does not stop an Agents turn.
    const failures = await this.backend.closeCase(this.caseId);
    if (this.ws.readyState < WebSocket.CLOSING) this.ws.close();
    const kill = setTimeout(() => this.ws.terminate(), 3000);
    kill.unref?.();
    this.remember({ type: 'live', id: this.id, cleanup: 'close_requested' });
    this.onClose(this.id);
    return failures;
  }
}
