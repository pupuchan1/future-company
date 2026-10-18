export type CaseLanguage = 'ja' | 'en'
export type WorkerCase = { id: string; revision: number; kind: 'support' | 'sales' | 'recruitment'; locale: CaseLanguage }
export type WorkerCaseState = { phase: 'idle' | 'creating' | 'ready' | 'error'; case: WorkerCase | null; error: string }
export type WorkerVoiceAuthorization = { case: WorkerCase; bridgeToken: string }

export class WorkerCaseError extends Error {
  readonly status: number
  constructor(message: string, status = 0) { super(message); this.name = 'WorkerCaseError'; this.status = status }
}

function readCase(body: unknown): WorkerCase {
  const value = body && typeof body === 'object' ? (body as { case?: unknown }).case : null
  if (!value || typeof value !== 'object') throw new WorkerCaseError('案件サーバーの応答を確認してください。 / Invalid case response.')
  const c = value as Record<string, unknown>
  if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.id) || !Number.isSafeInteger(c.revision) || (c.revision as number) < 0 || !['support','sales','recruitment'].includes(String(c.kind)) || !['ja','en'].includes(String(c.locale))) throw new WorkerCaseError('案件サーバーの応答を確認してください。 / Invalid case response.')
  return { id: c.id, revision: c.revision as number, kind: c.kind as WorkerCase['kind'], locale: c.locale as CaseLanguage }
}

/** Same-origin, cookie-authenticated visitor cases. No secrets or local IDs are passed as real cases. */
export class WorkerCaseClient {
  private state: WorkerCaseState = { phase: 'idle', case: null, error: '' }
  private listeners = new Set<(state: WorkerCaseState) => void>()
  private command: { commandId: string; expectedRevision: 0; kind: 'support'; locale: CaseLanguage } | null = null
  private pending: Promise<WorkerCase> | null = null
  private voicePending: Promise<WorkerVoiceAuthorization> | null = null
  private voiceGeneration = 0
  private controller: AbortController | null = null
  private generation = 0
  private readonly fetcher: typeof fetch
  constructor(fetcher: typeof fetch = (...args) => fetch(...args)) { this.fetcher = fetcher }
  getSnapshot() { return this.state }
  subscribe(listener: (state: WorkerCaseState) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(state: WorkerCaseState) { this.state = state; for (const listener of this.listeners) listener(state) }

  ensureCase(locale: CaseLanguage): Promise<WorkerCase> {
    if (this.pending) return this.pending
    const known = this.state.case
    // Reception has no employment intent yet. 'support' is the Worker's general
    // consultation category; the AI's recruitment/HaaS route remains independent.
    this.command ??= { commandId: `voice-intake-${crypto.randomUUID()}`, expectedRevision: 0, kind: 'support', locale }
    const controller = new AbortController()
    this.controller = controller
    const generation = ++this.generation
    this.publish({ phase: 'creating', case: known, error: '' })
    const operation = (async () => {
      try {
        const response = await this.fetcher(known ? `/api/v1/cases/${encodeURIComponent(known.id)}` : '/api/v1/cases', {
          method: known ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: controller.signal,
          headers: known ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
          ...(known ? {} : { body: JSON.stringify(this.command) }),
        })
        if (controller.signal.aborted || generation !== this.generation) throw new DOMException('Cancelled', 'AbortError')
        if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400) || [401,403].includes(response.status)) throw new WorkerCaseError('案件サーバーの認証が必要です。認証後に再試行してください。 / Authenticate with the case server, then retry.', response.status)
        if (!response.ok) throw new WorkerCaseError(`案件を準備できませんでした。再試行してください。 / Could not prepare the case (HTTP ${response.status}).`, response.status)
        if (!response.headers.get('content-type')?.includes('application/json')) throw new WorkerCaseError('案件サーバーへの認証または接続を確認してください。 / Check case server authentication or connectivity.')
        const result = readCase(await response.json())
        if (controller.signal.aborted || generation !== this.generation) throw new DOMException('Cancelled', 'AbortError')
        if (known && result.id !== known.id) throw new WorkerCaseError('異なる案件の応答を受け取りました。 / Case response does not match.')
        this.publish({ phase: 'ready', case: result, error: '' })
        return result
      } catch (error) {
        if (generation === this.generation && !controller.signal.aborted) this.publish({ phase: 'error', case: known, error: error instanceof WorkerCaseError ? error.message : '案件サーバーに接続できません。接続を確認して再試行してください。 / Could not reach the case server. Please retry.' })
        throw error
      } finally {
        if (generation === this.generation) { this.pending = null; this.controller = null }
      }
    })()
    this.pending = operation
    return operation
  }
  /** Issue #19: a case ID alone is not proof that the visitor owns it. */
  prepareVoice(locale: CaseLanguage): Promise<WorkerVoiceAuthorization> {
    if (this.voicePending) return this.voicePending
    const generation = ++this.voiceGeneration
    const operation = (async () => {
      let controller: AbortController | null = null
      try {
        const known = await this.ensureCase(locale)
        if (generation !== this.voiceGeneration) throw new DOMException('Cancelled', 'AbortError')
        controller = new AbortController()
        this.controller = controller
        this.publish({ phase: 'creating', case: known, error: '' })
        const response = await this.fetcher(`/api/v1/cases/${encodeURIComponent(known.id)}/bridge-token`, {
          method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        })
        if (controller.signal.aborted || generation !== this.voiceGeneration) throw new DOMException('Cancelled', 'AbortError')
        if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400) || [401, 403].includes(response.status)) {
          throw new WorkerCaseError('音声を開始するには案件の認証が必要です。 / Authenticate with the case server before starting voice.', response.status)
        }
        if (!response.ok) throw new WorkerCaseError(`音声接続の準備ができません。再試行してください。 / Could not authorize voice (HTTP ${response.status}).`, response.status)
        if (!response.headers.get('content-type')?.includes('application/json')) throw new WorkerCaseError('音声接続の認証応答を確認できません。 / Invalid voice authorization response.')
        const body = await response.json() as Record<string, unknown> | null
        if (controller.signal.aborted || generation !== this.voiceGeneration) throw new DOMException('Cancelled', 'AbortError')
        if (!body || body.caseId !== known.id || typeof body.bridgeToken !== 'string' || !body.bridgeToken.trim() || body.bridgeToken.length > 1000
          || !Number.isSafeInteger(body.expiresIn) || Number(body.expiresIn) <= 0 || Number(body.expiresIn) > 900) {
          throw new WorkerCaseError('音声接続の認証応答を確認できません。 / Invalid voice authorization response.')
        }
        this.publish({ phase: 'ready', case: known, error: '' })
        // The short-lived proof stays in this start operation, never in a UI snapshot or storage.
        return { case: known, bridgeToken: body.bridgeToken }
      } catch (error) {
        if (generation === this.voiceGeneration && !controller?.signal.aborted) {
          this.publish({ phase: 'error', case: this.state.case, error: error instanceof WorkerCaseError ? error.message : '音声接続を準備できません。接続を確認して再試行してください。 / Could not authorize voice. Check the connection and retry.' })
        }
        throw error
      } finally {
        if (generation === this.voiceGeneration) {
          this.voicePending = null
          if (this.controller === controller) this.controller = null
        }
      }
    })()
    this.voicePending = operation
    return operation
  }

  cancel() {
    this.generation++
    this.voiceGeneration++
    this.controller?.abort()
    this.controller = null; this.pending = null; this.voicePending = null
    this.publish({ ...this.state, phase: this.state.case ? 'ready' : 'idle', error: '' })
  }
  reset() { this.cancel(); this.command = null; this.publish({ phase: 'idle', case: null, error: '' }) }
}
