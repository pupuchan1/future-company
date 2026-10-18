import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { verifyBridgeProof } from '../src/backend/bridge-proof.ts';

export class WorkerBridge {
  constructor({ url, token, accessClientId, accessClientSecret, fetcher = fetch, socketFactory = (url, options) => new WebSocket(url, options), deliver, emit = () => {} }) {
    if (!url || !/^[A-Za-z0-9_-]{32,200}$/.test(token || '')) throw new Error('WORKER_API_URL and server-only STAFF_API_TOKEN are required.');
    this.url = new URL(url);
    if (this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/' || !['http:', 'https:'].includes(this.url.protocol)
      || (this.url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname))) throw new Error('Worker URL must be HTTPS or loopback HTTP.');
    this.headers = { Authorization: `Bearer ${token}`, ...(accessClientId && accessClientSecret ? { 'CF-Access-Client-Id': accessClientId, 'CF-Access-Client-Secret': accessClientSecret } : {}) };
    Object.assign(this, { token, fetcher, socketFactory, deliver, emit });
    this.cases = new Map();
  }

  async api(path, body, headers = this.headers) {
    const response = await this.fetcher(new URL(`/api/v1${path}`, this.url), {
      method: body ? 'POST' : 'GET', headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'manual', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      let code = 'worker_unavailable';
      if (response.headers.get('Content-Type')?.includes('application/problem+json')) {
        const title = (await response.json()).title;
        if (typeof title === 'string' && /^[a-z_]{1,80}$/.test(title)) code = title;
      }
      throw Object.assign(new Error(`Worker ${response.status}: ${code}`), { status: response.status, code });
    }
    return response.json();
  }

  async attachCase(caseId, proof) {
    if (!await verifyBridgeProof(proof, caseId, this.token)) throw Object.assign(new Error('A valid case-scoped bridgeToken is required.'), { status: 403 });
    const { case: snapshot } = await this.api(`/staff/cases/${caseId}`);
    if (snapshot.id !== caseId || snapshot.status === 'resolved') throw Object.assign(new Error('Worker case is unavailable.'), { status: 409 });
    if (this.cases.has(caseId)) throw Object.assign(new Error('Case bridge already exists.'), { status: 409 });
    const state = { id: caseId, closed: false, queue: Promise.resolve(), handoffs: new Map(), deliveries: new Map(), retryableDeliveries: new Set(), reservationIds: new Map() };
    this.cases.set(caseId, state);
    const url = new URL(`/api/v1/staff/cases/${caseId}/ws`, this.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    try { state.socket = this.socketFactory(url, { headers: this.headers, handshakeTimeout: 10000 }); }
    catch (error) { this.closeCase(caseId); throw error; }
    state.socket.on('message', bytes => {
      try { const message = JSON.parse(bytes.toString()); if (message.type === 'case.snapshot') this.observe(state, message.snapshot); }
      catch { this.emit({ type: 'worker.error', case_id: caseId, message: 'Invalid Worker synchronization event.' }); }
    });
    state.socket.on('error', () => this.emit({ type: 'worker.error', case_id: caseId, message: 'Worker synchronization unavailable; no polling or automatic reconnect.' }));
    state.socket.on('close', () => { if (!state.closed) this.emit({ type: 'worker.error', case_id: caseId, message: 'Worker synchronization closed; use explicit result synchronization.' }); });
  }

  enqueue(state, run) {
    const job = state.queue.then(() => { if (!state.closed) return run(); });
    state.queue = job.catch(() => {});
    return job;
  }

  async command(state, suffix, commandId, fields) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (state.closed) throw new Error('Case bridge is closed.');
      const { case: snapshot } = await this.api(`/staff/cases/${state.id}`);
      try { return (await this.api(suffix, { commandId, expectedRevision: snapshot.revision, ...fields })).case; }
      catch (error) { if (attempt || !['revision_conflict', 'projection_failed'].includes(error.code)) throw error; }
    }
  }

  async humanEvent(event, route) {
    const state = this.cases.get(event.data.case_id);
    if (!state || state.closed) return false;
    const id = event.data.handoff_id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('A valid handoff_id is required.');
    if (event.name === 'human.requested' && !state.handoffs.has(id)) state.handoffs.set(id, { route, cancelled: false });
    // Cancellation invalidates queued delivery immediately, before any HTTP await.
    if (['human.cancelled', 'human.unavailable'].includes(event.name)) {
      const handoff = state.handoffs.get(id);
      if (handoff) handoff.cancelled = true;
    }
    await this.enqueue(state, async () => {
      const base = `/staff/cases/${state.id}/handoffs`;
      if (event.name === 'human.requested') {
        await this.command(state, base, `bridge-register-${id}`, {
          nodeCaseId: event.data.case_id, handoffId: id, route: state.handoffs.get(id).route,
          summary: event.data.summary, task: event.data.task || event.data.summary,
          targetRole: event.data.target_role || 'human', expectedResult: event.data.expected_result || 'Answer or explanation of why the task could not be completed.',
        });
      } else if (['human.cancelled', 'human.unavailable'].includes(event.name) && state.handoffs.has(id)) {
        await this.command(state, `${base}/${id}/cancel`, `bridge-cancel-${id}`, {});
      } else if (event.name === 'human.completed' && event.data.result && state.handoffs.has(id) && !state.handoffs.get(id).cancelled) {
        let { case: snapshot } = await this.api(`/staff/cases/${state.id}`);
        let request = snapshot.requests.find(r => r.origin?.handoffId === id && r.origin.nodeCaseId === state.id);
        if (!request || request.status === 'cancelled') return;
        if (request.status === 'pending') {
          const requestId = request.id;
          snapshot = await this.command(state, `/staff/requests/${request.id}/claim`, `bridge-claim-${id}`, { caseId: state.id });
          request = snapshot.requests.find(r => r.id === requestId);
        }
        // An employee's existing answer remains authoritative; the phone cannot overwrite it.
        if (request.status === 'claimed' && request.assignedTo === 'demo-staff') {
          snapshot = await this.command(state, `/staff/requests/${request.id}/answer`, `bridge-answer-${id}`, { caseId: state.id, result: event.data.result, simulated: event.data.simulated });
        }
        this.observe(state, snapshot);
      }
    });
    return true;
  }

  observe(state, snapshot, { retry = false } = {}) {
    if (state.closed || snapshot.id !== state.id) return;
    for (const request of snapshot.requests || []) {
      const origin = request.origin;
      const known = origin && state.handoffs.get(origin.handoffId);
      if (!known || origin.nodeCaseId !== state.id || origin.route !== known.route) continue;
      // Worker-side cancellation must invalidate even a delivery already awaiting
      // its Agent, so Live can suppress the answer after that await completes.
      if (request.status === 'cancelled') known.cancelled = true;
      const id = origin.handoffId;
      const retryable = state.retryableDeliveries.has(id);
      if (known.cancelled || request.status !== 'answered' || !request.result || typeof request.simulated !== 'boolean'
        || state.deliveries.has(id) || (retryable && !retry)
        || (request.delivery?.status !== 'pending' && !(retry && retryable && request.delivery?.status === 'queued'))) continue;
      state.retryableDeliveries.delete(id);
      // One in-flight delivery per stable case/handoff, even across repeated snapshots.
      const attempt = { started: false };
      const job = this.forward(state, request, attempt).catch(() => {
        // A lost queued-write response is safe to recover using its stable command
        // ID, but once deliver() was invoked its outcome may be ambiguous.
        if (!attempt.started && !state.closed && !known.cancelled) {
          state.deliveries.delete(id);
          state.retryableDeliveries.add(id);
        }
        this.emit({ type: 'worker.error', case_id: state.id, handoff_id: id,
          message: attempt.started ? 'Worker delivery receipt could not be saved; no automatic redelivery.'
            : 'Worker answer synchronization failed before delivery; use explicit result synchronization.' });
      });
      state.deliveries.set(id, job);
    }
  }

  async forward(state, request, attempt) {
    const origin = request.origin;
    const valid = () => !state.closed && !state.handoffs.get(origin.handoffId)?.cancelled;
    const path = `/staff/cases/${state.id}/handoffs/${origin.handoffId}/delivery`;
    // A different Node needs a different reservation, while an HTTP retry by
    // this Node must recover the same durable write after a lost response.
    let reservationId = state.reservationIds.get(origin.handoffId);
    if (!reservationId) {
      reservationId = `bridge-queued-${randomUUID()}`;
      state.reservationIds.set(origin.handoffId, reservationId);
    }
    await this.enqueue(state, () => this.command(state, path, reservationId, { status: 'queued' }));
    if (!valid()) return;
    // Recheck durable cancellation after queue reservation and before the Agent receives data.
    const { case: latest } = await this.api(`/staff/cases/${state.id}`);
    if (latest.requests.find(r => r.id === request.id)?.status !== 'answered') return;
    const event = { name: 'human.completed', eventId: `worker-result-${state.id}-${origin.handoffId}`, isValid: valid,
      data: { case_id: origin.nodeCaseId, handoff_id: origin.handoffId, request_id: request.id, status: 'completed', result: request.result, simulated: request.simulated, source_route: origin.route } };
    let result;
    attempt.started = true;
    try { result = await this.deliver(event); }
    catch { result = { status: 'failed' }; }
    if (!valid()) return;
    const status = ['live_submitted', 'agent_completed'].includes(result?.status) ? result.status : 'failed';
    await this.enqueue(state, () => this.command(state, path, `bridge-delivery-${origin.handoffId}-${status}`, { status }));
    this.emit({ type: 'worker.delivery', case_id: state.id, handoff_id: origin.handoffId, request_id: request.id, status });
  }

  closeCase(caseId) {
    const state = this.cases.get(caseId);
    if (!state) return;
    state.closed = true;
    if (state.socket?.readyState === WebSocket.CONNECTING) state.socket.terminate();
    else state.socket?.close();
    this.cases.delete(caseId);
  }

  async syncCase(caseId, proof) {
    const state = this.cases.get(caseId);
    if (!state || state.closed || !await verifyBridgeProof(proof, caseId, this.token)) throw Object.assign(new Error('A valid active case proof is required.'), { status: 403 });
    const { case: snapshot } = await this.api(`/staff/cases/${caseId}`);
    this.observe(state, snapshot, { retry: true });
    return { case_id: caseId, status: 'accepted', delivery: snapshot.requests.filter(r => r.origin).map(r => ({ handoff_id: r.origin.handoffId, request_id: r.id, status: r.delivery?.status || r.status })) };
  }

  close() { for (const id of this.cases.keys()) this.closeCase(id); }
}
