export type CaseLanguage = 'ja' | 'en'
export type WorkerCase = { id: string; revision: number; kind: 'support' | 'sales' | 'recruitment'; locale: CaseLanguage }
export type WorkerCaseState = { phase: 'idle' | 'creating' | 'ready' | 'error'; case: WorkerCase | null; error: string }

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
  private controller: AbortController | null = null
  private bridgeController: AbortController | null = null
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

  /** A short-lived proof is fetched for each start and never retained in UI state. */
  getBridgeToken = async (): Promise<string> => {
    const known = this.state.case
    if (!known) throw new WorkerCaseError('先に受付を開始してください。 / Prepare the case before starting audio.')
    this.bridgeController?.abort()
    const controller = new AbortController()
    this.bridgeController = controller
    const generation = this.generation
    const assertCurrent = () => {
      if (controller.signal.aborted || generation !== this.generation || this.state.case?.id !== known.id) throw new DOMException('Cancelled', 'AbortError')
    }
    try {
      const response = await this.fetcher(`/api/v1/cases/${encodeURIComponent(known.id)}/bridge-token`, {
        method: 'POST', credentials: 'same-origin', redirect: 'manual', cache: 'no-store',
        headers: { Accept: 'application/json' }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      })
      assertCurrent()
      if (response.type === 'opaqueredirect' || response.status === 0 || (response.status >= 300 && response.status < 400) || [401,403].includes(response.status)) throw new WorkerCaseError('受付の認証が必要です。認証後に再試行してください。 / Authenticate with the case server, then retry.', response.status)
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new WorkerCaseError('音声接続の認証を確認できません。再試行してください。 / Could not verify audio access. Please retry.', response.status)
      const proof = await response.json() as Record<string, unknown>
      assertCurrent()
      if (!proof || proof.caseId !== known.id || typeof proof.bridgeToken !== 'string' || !proof.bridgeToken.trim() || typeof proof.expiresIn !== 'number' || !Number.isFinite(proof.expiresIn) || proof.expiresIn <= 0) throw new WorkerCaseError('音声接続の認証応答を確認してください。 / Invalid case authorization response.')
      return proof.bridgeToken
    } finally {
      if (this.bridgeController === controller) this.bridgeController = null
    }
  }

  cancel() {
    this.generation++
    this.controller?.abort()
    this.bridgeController?.abort()
    this.bridgeController = null
    this.controller = null; this.pending = null
    this.publish({ ...this.state, phase: this.state.case ? 'ready' : 'idle', error: '' })
  }
  reset() { this.cancel(); this.command = null; this.publish({ phase: 'idle', case: null, error: '' }) }
}
