export type CaseKind = 'support' | 'sales' | 'recruitment' | 'haas'
export type Locale = 'en' | 'ja'
export type Actor = { role: 'visitor'; ownerHash: string } | { role: 'staff'; id: string }
export type CaseStatus = 'active' | 'investigating' | 'awaiting_human' | 'ready' | 'resolved'

export type Fact = { label: string; value: string; source: string; observedAt: string }
export type HumanRequest = {
  id: string
  status: 'pending' | 'claimed' | 'answered' | 'cancelled'
  summary: string
  facts: Fact[]
  question: string
  assignedTo?: string
  answer?: string
  result?: { text: string; language: Locale }
  simulated?: boolean
  stockAvailable?: boolean
  createdAt: string
  answeredAt?: string
  origin?: { nodeCaseId: string; handoffId: string; route: 'reception' | 'recruiting' | 'haas'; targetRole: string; expectedResult: string }
  delivery?: { status: 'pending' | 'queued' | 'agent_completed' | 'live_submitted' | 'failed'; updatedAt: string }
}
export type CaseSnapshot = {
  id: string
  kind: CaseKind
  locale: Locale
  status: CaseStatus
  revision: number
  createdAt: string
  updatedAt: string
  messages: { id: string; role: 'visitor' | 'staff'; text: string; createdAt: string }[]
  facts: Fact[]
  requests: HumanRequest[]
  recruitment?: { roleInterest: string; experience: string; questions: string[]; source: 'visitor_self_report'; submittedAt: string }
  investigation?: { id: string; status: 'running' | 'completed' | 'failed'; error?: string }
  orderId?: string
  proposal?: { text: string; canReplace: boolean }
  replacement?: { id: string; orderId: string; status: 'pending' | 'completed' | 'failed' }
  ai: { status: 'unavailable' | 'awaiting_human' | 'resume_pending'; reason: string }
}
export type IntegrationOperation = {
  kind: 'live' | 'agent'
  fingerprint: string
  status: 'pending' | 'completed' | 'failed'
  reservedRevision: number
  sessionId?: string
  sdp?: string
  reason?: string
}
export type IntegrationView = { liveSessionId?: string; agentSessionId?: string; agentStatus?: string; lastEventId?: string }
export type StoredCase = CaseSnapshot & { ownerHash: string; integration?: IntegrationView & { operations: Record<string, IntegrationOperation>; eventIds: string[] } }
export type Command =
  | { type: 'register_handoff'; nodeCaseId: string; handoffId: string; route: 'reception' | 'recruiting' | 'haas'; summary: string; task: string; targetRole: string; expectedResult: string }
  | { type: 'cancel_handoff'; handoffId: string }
  | { type: 'delivery'; handoffId: string; status: NonNullable<HumanRequest['delivery']>['status'] }
  | { type: 'message'; text: string }
  | { type: 'submit_recruitment'; roleInterest: string; experience: string; questions: string[] }
  | { type: 'begin_investigation'; investigationId: string; inputHash: string }
  | { type: 'investigation_result'; investigationId: string; orderId: string; facts: Fact[]; requiresHuman: boolean; summary: string; proposal: string; canReplace: boolean }
  | { type: 'investigation_failed'; investigationId: string; error: string }
  | { type: 'claim'; requestId: string }
  | { type: 'answer'; requestId: string; answer: string; stockAvailable?: boolean; answerLanguage?: Locale; simulated?: boolean }
  | { type: 'begin_replacement'; replacementId: string }
  | { type: 'replacement_result'; replacementId: string; succeeded: boolean }

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError(400, 'invalid_input', 'A JSON object is required.')
  }
  return value as Record<string, unknown>
}

export function textField(value: unknown, field: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ApiError(400, 'invalid_input', `${field} must be a non-empty string of at most ${max} characters.`)
  }
  return value.trim()
}

export function idField(value: unknown, field = 'id'): string {
  const id = textField(value, field, 200)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new ApiError(400, 'invalid_input', `${field} has an invalid format.`)
  return id
}

export function parseCreate(value: unknown): { kind: CaseKind; locale: Locale } {
  const data = object(value)
  const kind = data.kind ?? 'support'
  const locale = data.locale ?? 'en'
  if (kind !== 'support' && kind !== 'sales' && kind !== 'recruitment' && kind !== 'haas') throw new ApiError(400, 'invalid_input', 'Unknown case kind.')
  if (locale !== 'en' && locale !== 'ja') throw new ApiError(400, 'invalid_input', 'Unknown locale.')
  return { kind, locale }
}

export function snapshotFor(state: StoredCase, actor: Actor): CaseSnapshot {
  if (actor.role === 'visitor' && actor.ownerHash !== state.ownerHash) {
    throw new ApiError(404, 'case_not_found', 'Case not found.')
  }
  const { ownerHash: _, integration: __, ...snapshot } = state
  if (actor.role === 'staff') return snapshot
  return { ...snapshot, requests: snapshot.requests.map(({ assignedTo: _, ...request }) => request) }
}

export function applyCommand(state: StoredCase, actor: Actor, command: Command, now: string): StoredCase {
  snapshotFor(state, actor)
  if (state.status === 'resolved') throw new ApiError(409, 'case_resolved', 'This case is already resolved.')
  const next = structuredClone(state)
  const staffCommand = ['claim', 'answer', 'register_handoff', 'cancel_handoff', 'delivery'].includes(command.type)
  if (staffCommand && actor.role !== 'staff') throw new ApiError(403, 'staff_required', 'Staff authentication is required.')
  if (!staffCommand && actor.role !== 'visitor') throw new ApiError(403, 'visitor_required', 'This action belongs to the visitor.')

  switch (command.type) {
    case 'register_handoff': {
      if (next.requests.some(item => item.origin?.handoffId === command.handoffId)) throw new ApiError(409, 'handoff_exists', 'This handoff already has a request. Reuse its original command.')
      next.requests.push({ id: `request-handoff-${command.handoffId}`, status: 'pending', summary: command.summary, question: command.task, facts: [], createdAt: now,
        origin: { nodeCaseId: command.nodeCaseId, handoffId: command.handoffId, route: command.route, targetRole: command.targetRole, expectedResult: command.expectedResult } })
      next.status = 'awaiting_human'
      next.ai = { status: 'awaiting_human', reason: 'A linked Agent requires a human response.' }
      break
    }
    case 'cancel_handoff': {
      const request = next.requests.find(item => item.origin?.handoffId === command.handoffId)
      if (!request) throw new ApiError(404, 'request_not_found', 'Linked request not found.')
      if (request.delivery?.status === 'live_submitted') throw new ApiError(409, 'already_delivered', 'This result was already submitted to Live.')
      request.status = 'cancelled'
      next.ai = { status: 'unavailable', reason: 'The linked request was cancelled before delivery.' }
      break
    }
    case 'delivery': {
      const request = next.requests.find(item => item.origin?.handoffId === command.handoffId)
      if (!request || request.status !== 'answered' || !request.result) throw new ApiError(409, 'answer_required', 'Only a saved answer on an active linked request can be delivered.')
      const order = ['pending', 'queued', 'agent_completed', 'live_submitted']
      if (request.delivery?.status === 'failed' || (command.status !== 'failed' && request.delivery && order.indexOf(command.status) < order.indexOf(request.delivery.status))) throw new ApiError(409, 'stale_delivery', 'Delivery cannot be repeated or moved backwards.')
      request.delivery = { status: command.status, updatedAt: now }
      break
    }
    case 'message':
      next.messages.push({ id: `message-${state.revision + 1}`, role: 'visitor', text: command.text, createdAt: now })
      break
    case 'submit_recruitment': {
      if (state.kind !== 'recruitment') throw new ApiError(409, 'case_kind_mismatch', 'Recruitment intake requires a recruitment case.')
      next.recruitment = { roleInterest: command.roleInterest, experience: command.experience, questions: command.questions, source: 'visitor_self_report', submittedAt: now }
      next.facts = [
        { label: 'Role of interest', value: command.roleInterest, source: 'visitor_self_report', observedAt: now },
        { label: 'Experience', value: command.experience, source: 'visitor_self_report', observedAt: now },
        ...command.questions.map((value, index) => ({ label: `Candidate question ${index + 1}`, value, source: 'visitor_self_report', observedAt: now }))
      ]
      for (const request of next.requests) if (request.status === 'pending' || request.status === 'claimed') request.status = 'cancelled'
      next.requests.push({ id: `request-recruitment-${state.id}-${state.revision + 1}`, status: 'pending', summary: `A candidate submitted self-reported recruitment information for ${command.roleInterest}.`, facts: next.facts, question: command.questions.length ? command.questions.join('\n') : 'Review the candidate’s self-reported information and provide the next steps.', createdAt: now })
      delete next.proposal
      next.status = 'awaiting_human'
      next.ai = { status: 'awaiting_human', reason: 'The candidate’s self-reported recruitment information requires a staff response.' }
      break
    }
    case 'begin_investigation':
      if (state.replacement?.status === 'pending') throw new ApiError(409, 'replacement_pending', 'An exchange is already being recorded.')
      next.investigation = { id: command.investigationId, status: 'running' }
      next.status = 'investigating'
      next.ai = { status: 'unavailable', reason: 'The GPT-Live and Agents adapters are not connected.' }
      next.facts = []
      delete next.orderId
      delete next.proposal
      for (const request of next.requests) if (request.status === 'pending' || request.status === 'claimed') request.status = 'cancelled'
      break
    case 'investigation_result':
      if (state.investigation?.id !== command.investigationId || state.investigation.status !== 'running') throw new ApiError(409, 'stale_investigation', 'This investigation has been superseded.')
      next.investigation = { ...state.investigation, status: 'completed' }
      next.orderId = command.orderId
      next.facts = command.facts
      if (command.requiresHuman) {
        next.requests.push({ id: `request-${command.investigationId}`, status: 'pending', summary: command.summary, facts: command.facts, question: 'Check the physical replacement stock and decide whether an urgent exchange can be offered.', createdAt: now })
        next.status = 'awaiting_human'
        next.ai = { status: 'awaiting_human', reason: 'Physical stock or an exception requires a staff decision.' }
      } else {
        next.status = 'ready'
        next.proposal = { text: command.proposal, canReplace: command.canReplace }
      }
      break
    case 'investigation_failed':
      if (state.investigation?.id !== command.investigationId || state.investigation.status !== 'running') throw new ApiError(409, 'stale_investigation', 'This investigation has been superseded.')
      next.investigation = { id: command.investigationId, status: 'failed', error: command.error }
      next.status = 'active'
      break
    case 'claim': {
      const request = next.requests.find((item) => item.id === command.requestId)
      if (!request) throw new ApiError(404, 'request_not_found', 'Request not found.')
      if (request.status !== 'pending') throw new ApiError(409, 'already_claimed', 'This request is no longer available.')
      if (actor.role === 'staff') request.assignedTo = actor.id
      request.status = 'claimed'
      break
    }
    case 'answer': {
      const request = next.requests.find((item) => item.id === command.requestId)
      if (!request) throw new ApiError(404, 'request_not_found', 'Request not found.')
      if (actor.role !== 'staff' || request.status !== 'claimed' || request.assignedTo !== actor.id) throw new ApiError(409, 'claim_required', 'Only the assigned staff member can answer this request.')
      if (!request.origin && state.kind !== 'recruitment' && typeof command.stockAvailable !== 'boolean') throw new ApiError(400, 'invalid_input', 'stockAvailable must be a boolean.')
      const answer = textField(command.answer, 'answer')
      if (command.answerLanguage !== undefined || command.simulated !== undefined) {
        if ((command.answerLanguage !== 'en' && command.answerLanguage !== 'ja') || typeof command.simulated !== 'boolean') throw new ApiError(400, 'invalid_input', 'A result requires an explicit answerLanguage and simulated flag.')
        request.result = { text: answer, language: command.answerLanguage }
        request.simulated = command.simulated
      }
      request.status = 'answered'
      if (request.origin) request.delivery = { status: 'pending', updatedAt: now }
      request.answer = answer
      if (state.kind !== 'recruitment') request.stockAvailable = command.stockAvailable
      request.answeredAt = now
      next.messages.push({ id: `message-${state.revision + 1}`, role: 'staff', text: answer, createdAt: now })
      next.proposal = { text: answer, canReplace: state.kind !== 'recruitment' && command.stockAvailable === true }
      next.status = 'ready'
      next.ai = { status: 'resume_pending', reason: 'Staff has answered. Business continuation is pending.' }
      break
    }
    case 'begin_replacement':
      if (!state.orderId || !state.proposal?.canReplace || state.status !== 'ready') throw new ApiError(409, 'replacement_not_available', 'An approved exchange proposal is required.')
      if (state.replacement && state.replacement.status !== 'failed') throw new ApiError(409, 'replacement_exists', 'An exchange has already been requested.')
      next.replacement = { id: command.replacementId, orderId: state.orderId, status: 'pending' }
      break
    case 'replacement_result':
      if (state.replacement?.id !== command.replacementId || state.replacement.status !== 'pending') throw new ApiError(409, 'stale_replacement', 'This exchange is no longer pending.')
      next.replacement = { ...state.replacement, status: command.succeeded ? 'completed' : 'failed' }
      if (command.succeeded) next.status = 'resolved'
      break
  }
  next.revision += 1
  next.updatedAt = now
  return next
}
