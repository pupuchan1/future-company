import { DurableObject } from 'cloudflare:workers'
import { ApiError, applyCommand, snapshotFor } from './contracts'
import type { Actor, CaseKind, CaseSnapshot, Command, IntegrationOperation, IntegrationView, Locale, StoredCase } from './contracts'

export type RoomResult = { ok: true; snapshot: CaseSnapshot } | { ok: false; status: number; code: string; detail: string }
export type BackendEnv = { CASES: DurableObjectNamespace<CaseRoom>; DB: D1Database }
export type IntegrationResult = { ok: true; snapshot: CaseSnapshot; integration: IntegrationView } | Exclude<RoomResult, { ok: true }>
export type ReservationResult = { ok: true; snapshot: CaseSnapshot; operation: Omit<IntegrationOperation, 'fingerprint' | 'reservedRevision' | 'status'> & { status: 'reserved' | 'pending' | 'completed' | 'failed' } } | Exclude<RoomResult, { ok: true }>

export class CaseRoom extends DurableObject<BackendEnv> {
  constructor(ctx: DurableObjectState, env: BackendEnv) {
    super(ctx, env)
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS case_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)')
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL)')
  }

  private read(): StoredCase {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM case_state WHERE id=1').toArray()[0]
    if (!row) throw new ApiError(404, 'case_not_found', 'Case not found.')
    // Only this class writes this JSON; parsing it again would duplicate the command input boundary.
    return JSON.parse(row.data) as StoredCase
  }

  private guard(run: () => CaseSnapshot): RoomResult {
    try { return { ok: true, snapshot: run() } } catch (error) {
      if (error instanceof ApiError) return { ok: false, status: error.status, code: error.code, detail: error.message }
      throw error
    }
  }

  initialize(input: { id: string; ownerHash: string; kind: CaseKind; locale: Locale; now: string }): RoomResult {
    return this.guard(() => {
      const existing = this.ctx.storage.sql.exec('SELECT id FROM case_state WHERE id=1').toArray()
      if (existing.length) return snapshotFor(this.read(), { role: 'visitor', ownerHash: input.ownerHash })
      const state: StoredCase = { id: input.id, ownerHash: input.ownerHash, kind: input.kind, locale: input.locale, status: 'active', revision: 0, createdAt: input.now, updatedAt: input.now, messages: [], facts: [], requests: [], ai: { status: 'unavailable', reason: 'The GPT-Live and Agents adapters are not connected.' } }
      this.ctx.storage.sql.exec('INSERT INTO case_state (id,data) VALUES(1,?)', JSON.stringify(state))
      return snapshotFor(state, { role: 'visitor', ownerHash: input.ownerHash })
    })
  }

  snapshot(actor: Actor): RoomResult { return this.guard(() => snapshotFor(this.read(), actor)) }

  getIntegration(actor: Actor): IntegrationResult {
    const result = this.snapshot(actor)
    if (!result.ok) return result
    const { liveSessionId, agentSessionId, agentStatus, lastEventId } = this.read().integration ?? {}
    return { ...result, integration: { liveSessionId, agentSessionId, agentStatus, lastEventId } }
  }

  reserveIntegration(actor: Actor, commandId: string, expectedRevision: number, kind: 'live' | 'agent', fingerprint: string): ReservationResult {
    let operation: ReservationResult & { ok: true }
    const result = this.guard(() => this.ctx.storage.transactionSync(() => {
      const state = this.read()
      snapshotFor(state, actor)
      if (actor.role !== 'visitor') throw new ApiError(403, 'visitor_required', 'This integration belongs to the visitor.')
      state.integration ??= { operations: {}, eventIds: [] }
      const key = `${actor.ownerHash}:${commandId}`
      const old = state.integration.operations[key]
      if (old) {
        if (old.fingerprint !== fingerprint || old.kind !== kind) throw new ApiError(409, 'idempotency_conflict', 'This integration command was used for different input.')
        operation = { ok: true, snapshot: snapshotFor(state, actor), operation: { kind: old.kind, status: old.status, sessionId: old.sessionId, sdp: old.sdp, reason: old.reason } }
        return operation.snapshot
      }
      if (state.status === 'resolved') throw new ApiError(409, 'case_resolved', 'This case is already resolved.')
      if (state.revision !== expectedRevision) throw new ApiError(409, 'revision_conflict', 'Read the current case before starting this integration.')
      if (Object.values(state.integration.operations).some((item) => item.kind === kind && item.status === 'pending')) throw new ApiError(409, 'integration_in_progress', 'A session of this kind is already being created.')
      if (kind === 'live' ? state.integration.liveSessionId : state.integration.agentSessionId) throw new ApiError(409, 'integration_exists', 'This case already has a session of this kind.')
      state.revision += 1
      state.updatedAt = new Date().toISOString()
      state.integration.operations[key] = { kind, fingerprint, status: 'pending', reservedRevision: state.revision }
      this.ctx.storage.sql.exec('UPDATE case_state SET data=? WHERE id=1', JSON.stringify(state))
      operation = { ok: true, snapshot: snapshotFor(state, actor), operation: { kind, status: 'reserved' } }
      return operation.snapshot
    }))
    if (!result.ok) return result
    this.broadcast()
    return operation!
  }

  completeIntegration(actor: Actor, commandId: string, value: { sessionId: string; sdp?: string; agentStatus?: string }): RoomResult {
    const result = this.guard(() => this.ctx.storage.transactionSync(() => {
      const state = this.read()
      snapshotFor(state, actor)
      if (actor.role !== 'visitor') throw new ApiError(403, 'visitor_required', 'This integration belongs to the visitor.')
      const operation = state.integration?.operations[`${actor.ownerHash}:${commandId}`]
      if (!operation || !state.integration) throw new ApiError(409, 'integration_not_reserved', 'Reserve this integration before completing it.')
      if (operation.status === 'completed') {
        if (operation.sessionId !== value.sessionId || operation.sdp !== value.sdp) throw new ApiError(409, 'idempotency_conflict', 'This integration already completed with another session or response.')
        return snapshotFor(state, actor)
      }
      if (operation.status === 'failed') throw new ApiError(409, 'integration_failed', operation.reason ?? 'This integration failed.')
      const currentSession = operation.kind === 'live' ? state.integration.liveSessionId : state.integration.agentSessionId
      if (currentSession && currentSession !== value.sessionId) throw new ApiError(409, 'integration_exists', 'The existing provider session cannot be overwritten.')
      // A concurrent visitor message changes business revision, but must not orphan a provider session already created.
      operation.status = 'completed'
      operation.sessionId = value.sessionId
      if (value.sdp !== undefined) operation.sdp = value.sdp
      if (operation.kind === 'live') state.integration.liveSessionId = value.sessionId
      else { state.integration.agentSessionId = value.sessionId; state.integration.agentStatus = value.agentStatus ?? 'starting' }
      state.revision += 1
      state.updatedAt = new Date().toISOString()
      this.ctx.storage.sql.exec('UPDATE case_state SET data=? WHERE id=1', JSON.stringify(state))
      return snapshotFor(state, actor)
    }))
    if (result.ok) this.broadcast()
    return result
  }

  failIntegration(actor: Actor, commandId: string, reason: string): RoomResult {
    const result = this.guard(() => this.ctx.storage.transactionSync(() => {
      const state = this.read()
      snapshotFor(state, actor)
      if (actor.role !== 'visitor') throw new ApiError(403, 'visitor_required', 'This integration belongs to the visitor.')
      const operation = state.integration?.operations[`${actor.ownerHash}:${commandId}`]
      if (!operation) throw new ApiError(409, 'integration_not_reserved', 'Reserve this integration before recording failure.')
      if (operation.status !== 'pending') return snapshotFor(state, actor)
      operation.status = 'failed'
      operation.reason = reason
      state.revision += 1
      state.updatedAt = new Date().toISOString()
      this.ctx.storage.sql.exec('UPDATE case_state SET data=? WHERE id=1', JSON.stringify(state))
      return snapshotFor(state, actor)
    }))
    if (result.ok) this.broadcast()
    return result
  }

  recordAgentEvent(sessionId: string, eventId: string, value: { status: string; turnOutcome?: string }): RoomResult {
    const result = this.guard(() => this.ctx.storage.transactionSync(() => {
      const state = this.read()
      if (!state.integration || state.integration.agentSessionId !== sessionId) throw new ApiError(409, 'stale_agent_session', 'This event does not belong to the current agent session.')
      const actor: Actor = { role: 'staff', id: 'agent-event' }
      if (state.integration.eventIds.includes(eventId)) return snapshotFor(state, actor)
      state.integration.eventIds.push(eventId)
      state.integration.lastEventId = eventId
      state.integration.agentStatus = value.status
      state.revision += 1
      state.updatedAt = new Date().toISOString()
      // Provider turn events do not confirm that this case's staff answer was consumed.
      this.ctx.storage.sql.exec('UPDATE case_state SET data=? WHERE id=1', JSON.stringify(state))
      return snapshotFor(state, actor)
    }))
    if (result.ok) this.broadcast()
    return result
  }

  commandOutcome(actor: Actor, commandId: string): RoomResult | null {
    const current = this.snapshot(actor)
    if (!current.ok) return current
    const key = `${actor.role}:${actor.role === 'visitor' ? actor.ownerHash : actor.id}:${commandId}`
    const old = this.ctx.storage.sql.exec<{ result: string }>('SELECT result FROM commands WHERE id=?', key).toArray()[0]
    return old ? { ok: true, snapshot: JSON.parse(old.result) as CaseSnapshot } : null
  }

  command(actor: Actor, commandId: string, expectedRevision: number, command: Command, now: string): RoomResult {
    const result = this.guard(() => this.ctx.storage.transactionSync(() => {
      const state = this.read()
      snapshotFor(state, actor)
      const key = `${actor.role}:${actor.role === 'visitor' ? actor.ownerHash : actor.id}:${commandId}`
      const fingerprint = JSON.stringify(command)
      const old = this.ctx.storage.sql.exec<{ fingerprint: string; result: string }>('SELECT fingerprint,result FROM commands WHERE id=?', key).toArray()[0]
      if (old) {
        if (old.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'This command ID was used for different input.')
        return JSON.parse(old.result) as CaseSnapshot
      }
      if (state.revision !== expectedRevision) throw new ApiError(409, 'revision_conflict', 'Read the current case before sending this command.')
      const next = applyCommand(state, actor, command, now)
      const snapshot = snapshotFor(next, actor)
      this.ctx.storage.sql.exec('UPDATE case_state SET data=? WHERE id=1', JSON.stringify(next))
      this.ctx.storage.sql.exec('INSERT INTO commands(id,fingerprint,result) VALUES(?,?,?)', key, fingerprint, JSON.stringify(snapshot))
      return snapshot
    }))
    if (result.ok) this.broadcast()
    return result
  }

  private broadcast(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const actor: Actor = ws.deserializeAttachment()
      try { ws.send(JSON.stringify({ type: 'case.snapshot', snapshot: snapshotFor(this.read(), actor) })) } catch { ws.close(1011, 'Cannot synchronize case.') }
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required.', { status: 426 })
    const staffId = request.headers.get('x-internal-staff-id')
    const ownerHash = request.headers.get('x-internal-owner-hash')
    if (!staffId && !ownerHash) return new Response('Unauthorized.', { status: 401 })
    const actor: Actor = staffId ? { role: 'staff', id: staffId } : { role: 'visitor', ownerHash: ownerHash! }
    const result = this.snapshot(actor)
    if (!result.ok) return Response.json(result, { status: result.status })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment(actor)
    pair[1].send(JSON.stringify({ type: 'case.snapshot', snapshot: result.snapshot }))
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message !== 'sync') { ws.send(JSON.stringify({ type: 'error', code: 'use_http_commands' })); return }
    const actor: Actor = ws.deserializeAttachment()
    const result = this.snapshot(actor)
    if (result.ok) ws.send(JSON.stringify({ type: 'case.snapshot', snapshot: result.snapshot }))
    else ws.close(1008, 'Unauthorized.')
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void { ws.close(code, reason) }
  webSocketError(ws: WebSocket): void { ws.close(1011, 'WebSocket failed.') }
}
