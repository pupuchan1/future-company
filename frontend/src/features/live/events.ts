import { object } from './types.ts'
import type { JsonObject, LiveHumanRequest, LiveSnapshot } from './types.ts'

export function readHumanRequest(value: unknown, caseId: string): LiveHumanRequest | null {
  const record = object(value)
  if (record.case_id !== caseId || typeof record.handoff_id !== 'string' || typeof record.status !== 'string') return null
  const result = object(record.result)
  return {
    handoffId: record.handoff_id, caseId, status: record.status,
    summary: typeof record.summary === 'string' ? record.summary : '',
    ...(typeof record.target_role === 'string' ? { targetRole: record.target_role } : {}),
    ...(typeof record.task === 'string' ? { task: record.task } : {}),
    ...(typeof record.expected_result === 'string' ? { expectedResult: record.expected_result } : {}),
    revision: typeof record.revision === 'number' ? record.revision : 0,
    ...(typeof record.simulated === 'boolean' ? { simulated: record.simulated } : {}),
    ...(typeof record.audio_connected === 'boolean' ? { audioConnected: record.audio_connected } : {}),
    ...(typeof record.unavailable_reason === 'string' ? { unavailableReason: record.unavailable_reason } : {}),
    ...(typeof result.text === 'string' && (result.language === 'ja' || result.language === 'en')
      ? { result: { text: result.text, language: result.language } } : {}),
  }
}

export function putRequest(snapshot: LiveSnapshot, request: LiveHumanRequest): LiveSnapshot {
  const old = snapshot.requests.find(item => item.handoffId === request.handoffId)
  if (old && old.revision > request.revision) return snapshot
  const next = old ? { ...old, ...request } : request
  return { ...snapshot, requests: [...snapshot.requests.filter(item => item.handoffId !== request.handoffId), next].slice(-100) }
}

/** One reducer per case. SSE is global in PR #4, so require its case_id. */
export class LiveEventReducer {
  private seen = new Set<string>()
  private recent = new Map<string, { id: string; at: number; final: boolean }>()
  private sequence = 0

  reset() { this.seen.clear(); this.recent.clear(); this.sequence = 0 }

  apply(snapshot: LiveSnapshot, input: unknown, source: 'server' | 'datachannel', now = Date.now()): LiveSnapshot {
    const event = object(input)
    const body: JsonObject = { ...event, ...object(event.data) }
    const type = typeof event.type === 'string' ? event.type : typeof event.name === 'string' ? event.name : ''
    const request = object(body.request ?? body.handoff ?? body)
    const caseId = body.case_id ?? request.case_id
    if (caseId !== undefined && caseId !== snapshot.caseId) return snapshot
    if (source === 'server' && caseId !== snapshot.caseId) return snapshot
    const eventId = body.event_id ?? event.eventId
    if (typeof eventId === 'string') {
      if (this.seen.has(eventId)) return snapshot
      this.seen.add(eventId)
    }
    if (type === 'routing.updated') {
      const route = ['reception', 'recruiting', 'haas'].includes(String(body.route)) ? body.route as LiveSnapshot['route'] : snapshot.route
      const language = body.language === 'ja' || body.language === 'en' ? body.language : snapshot.language
      return { ...snapshot, route, language }
    }
    if (type.startsWith('human.')) {
      const parsed = readHumanRequest(request, snapshot.caseId)
      return parsed ? putRequest(snapshot, parsed) : snapshot
    }
    if (type === 'backend.started') return { ...snapshot, backend: 'running', backendResult: '' }
    if (type === 'backend.result') {
      const result = object(body.result)
      const text = body.content ?? body.summary ?? result.text ?? result.summary
      return { ...snapshot, backend: 'result', backendResult: typeof text === 'string' ? text : '' }
    }
    if (type === 'backend.error') return { ...snapshot, backend: 'error', error: errorMessage(body) }
    if (type === 'error') return { ...snapshot, error: errorMessage(body) }
    if (!type.includes('transcript')) return snapshot

    const nested = object(body.transcript)
    const deltaValue = typeof body.delta === 'string' ? body.delta : object(body.delta).text ?? object(body.delta).transcript
    const full = typeof body.transcript === 'string' ? body.transcript : body.text ?? nested.text
    const text = deltaValue ?? full
    const speaker = body.role ?? body.speaker ?? nested.role ?? (type.includes('input') ? 'user' : 'assistant')
    const role = speaker === 'user' || speaker === 'human' ? 'user' : speaker === 'system' ? 'system' : 'assistant'
    const recent = this.recent.get(role)
    const explicitId = body.item_id ?? body.utterance_id ?? body.transcript_id ?? body.segment_id ?? nested.id
    let id = typeof explicitId === 'string' ? `${role}:${explicitId}` : ''
    const final = /completed|done|final/.test(type) || body.is_final === true
    if (typeof text !== 'string' || !text) {
      if (!final || (!id && !recent)) return snapshot
      id ||= recent!.id
      if (recent?.id === id) this.recent.set(role, { ...recent, final: true })
      return { ...snapshot, transcripts: snapshot.transcripts.map(item => item.id === id ? { ...item, final: true } : item) }
    }
    if (!id && recent && snapshot.transcripts.at(-1)?.id === recent.id && !recent.final && now - recent.at < 8000) id = recent.id
    if (!id) id = `${role}:live-${++this.sequence}`
    const old = snapshot.transcripts.find(item => item.id === id)
    const entry = { id, role, text: deltaValue !== undefined ? (old?.text ?? '') + text : text, final } as const
    this.recent.set(role, { id, at: now, final })
    const transcripts = old ? snapshot.transcripts.map(item => item.id === id ? entry : item) : [...snapshot.transcripts, entry]
    return { ...snapshot, transcripts }
  }
}

function errorMessage(body: JsonObject) {
  const message = object(body.error).message ?? body.message ?? body.error
  return typeof message === 'string' ? message : '接続先でエラーが発生しました。 / Connection error.'
}
