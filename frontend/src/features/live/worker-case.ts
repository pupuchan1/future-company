import { caseVoicePrefix } from './client.ts'
import { object } from './types.ts'
import type { LiveLanguage } from './types.ts'

export interface WorkerCaseSnapshot {
  commandId: string
  status: 'preparing' | 'ready' | 'error'
  caseId: string
  revision: number | null
  error: string
}

/** One creation command per conversation, including Strict Mode and retries. */
export class WorkerCaseClient {
  private state: WorkerCaseSnapshot
  private listeners = new Set<(value: WorkerCaseSnapshot) => void>()
  private pending: Promise<void> | null = null
  private locale?: LiveLanguage
  private kind: string
  private fetcher: typeof fetch

  constructor(commandId: string, kind: string, fetcher: typeof fetch = fetch) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(commandId)) throw new Error('Invalid case creation command.')
    this.state = { commandId, status: 'preparing', caseId: '', revision: null, error: '' }
    this.kind = kind
    this.fetcher = fetcher
  }

  getSnapshot = () => this.state
  subscribe = (listener: (value: WorkerCaseSnapshot) => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(value: Partial<WorkerCaseSnapshot>) {
    this.state = { ...this.state, ...value }
    this.listeners.forEach(listener => listener(this.state))
  }

  ensure(language: LiveLanguage): Promise<void> {
    if (this.state.status === 'ready') return Promise.resolve()
    if (this.pending) return this.pending
    this.locale ??= language
    this.publish({ status: 'preparing', error: '' })
    this.pending = this.create().finally(() => { this.pending = null })
    return this.pending
  }

  private async create() {
    try {
      const response = await this.fetcher('/api/v1/cases', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandId: this.state.commandId, expectedRevision: 0, kind: this.kind, locale: this.locale }),
        signal: AbortSignal.timeout(15000),
      })
      const value = object(await response.json().catch(() => null))
      if (!response.ok) {
        const detail = typeof value.detail === 'string' ? value.detail : typeof value.error === 'string' ? value.error : ''
        throw new Error(`受付を準備できません。認証・接続を確認してください。 / Cannot prepare reception. Check access and connection. (HTTP ${response.status})${detail ? ` ${detail}` : ''}`)
      }
      const record = object(value.case)
      if (typeof record.id !== 'string' || !record.id || record.kind !== this.kind || record.locale !== this.locale || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
        throw new Error('受付の応答を確認できません。認証・接続先を確認してください。 / Invalid reception response. Check access and the endpoint.')
      }
      caseVoicePrefix(record.id)
      this.publish({ status: 'ready', caseId: record.id, revision: Number(record.revision), error: '' })
    } catch (error) {
      this.publish({ status: 'error', caseId: '', revision: null, error: error instanceof Error ? error.message : '受付へ接続できません。 / Cannot reach reception.' })
    }
  }
}
