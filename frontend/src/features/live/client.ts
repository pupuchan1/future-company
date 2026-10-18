import { LiveEventReducer, putRequest, readHumanRequest } from './events.ts'
import { initialSnapshot, object } from './types.ts'
import type { LiveLanguage, LiveSnapshot } from './types.ts'

export interface LiveRuntime {
  fetch: typeof fetch
  microphone: () => Promise<MediaStream>
  peer: () => RTCPeerConnection
  events: () => EventSource
  audio: () => HTMLAudioElement
  supported: () => boolean
}

interface Connection {
  stream?: MediaStream
  peer?: RTCPeerConnection
  channel?: RTCDataChannel
  sessionId?: string
  started: boolean
  startTimer?: ReturnType<typeof setTimeout>
  disconnectTimer?: ReturnType<typeof setTimeout>
  cancelIce?: () => void
}

const browserRuntime = (): LiveRuntime => ({
  fetch: (...args) => fetch(...args),
  microphone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
  peer: () => new RTCPeerConnection(),
  events: () => new EventSource('/api/events'),
  audio: () => { const audio = new Audio(); audio.autoplay = true; return audio },
  supported: () => window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.RTCPeerConnection === 'function',
})

/** PR #4 transport only. It never sends disallowed frontend Live commands. */
export class LiveClient {
  private state: LiveSnapshot
  private runtime: LiveRuntime
  private listeners = new Set<(snapshot: LiveSnapshot) => void>()
  private reducer = new LiveEventReducer()
  private connection: Connection | null = null
  private source: EventSource | null = null
  private audio: HTMLAudioElement | null = null
  private poll?: ReturnType<typeof setInterval>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private statusBusy = false
  private observing = false
  private disposed = false
  private closing: Promise<void> | null = null

  constructor(caseId: string, language: LiveLanguage, runtime = browserRuntime()) {
    this.state = initialSnapshot(caseId, language)
    this.runtime = runtime
  }

  getSnapshot = () => this.state
  subscribe(listener: (snapshot: LiveSnapshot) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: LiveSnapshot) {
    if (this.disposed || next === this.state) return
    this.state = next
    this.listeners.forEach(listener => listener(next))
  }
  private patch(next: Partial<LiveSnapshot>) { this.publish({ ...this.state, ...next }) }

  private async api(path: string, options: RequestInit = {}) {
    const response = await this.runtime.fetch(path, {
      credentials: 'same-origin', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(35000),
    })
    const data = object(await response.json().catch(() => null))
    if (!response.ok) {
      const detail = typeof data.error === 'string' ? data.error : object(data.error).message
      throw new Error(`${typeof detail === 'string' ? detail : '接続失敗 / Connection failed'} (HTTP ${response.status})`)
    }
    return data
  }

  observe() {
    if (this.disposed || this.observing) return
    this.observing = true
    void this.refreshStatus()
    this.openEvents()
    this.poll = setInterval(() => void this.refreshStatus(), 10000)
  }

  private openEvents() {
    if (this.disposed || this.source) return
    try {
      const source = this.runtime.events()
      this.source = source
      source.onopen = () => { this.patch({ events: 'connected' }); void this.refreshStatus() }
      source.onmessage = event => {
        try { this.receive(JSON.parse(event.data), 'server') } catch { /* Ignore malformed SSE frames. */ }
      }
      source.onerror = () => {
        this.patch({ events: 'reconnecting' })
        // A proxy 5xx can close EventSource permanently rather than retry it.
        if (source.readyState === 2) {
          source.onopen = null; source.onmessage = null; source.onerror = null
          source.close()
          this.source = null
          this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.openEvents() }, 3000)
        }
      }
    } catch { this.patch({ events: 'closed', error: 'イベント接続を開始できません。 / Cannot connect to events.' }) }
  }

  async refreshStatus() {
    if (this.disposed || this.statusBusy) return
    this.statusBusy = true
    try {
      const data = await this.api('/api/status', { signal: AbortSignal.timeout(8000) })
      if (this.disposed) return
      if (typeof data.live_configured !== 'boolean' || typeof data.mcp_configured !== 'boolean') throw new Error('接続先の応答が不正です。 / Invalid server status.')
      let next: LiveSnapshot = { ...this.state, configured: data.live_configured, mcpConfigured: data.mcp_configured }
      for (const record of Array.isArray(data.requests) ? data.requests : []) {
        const parsed = readHumanRequest(record, next.caseId)
        if (parsed) next = putRequest(next, parsed)
      }
      this.publish(next)
    } catch {
      this.patch({ configured: null, mcpConfigured: null })
    } finally { this.statusBusy = false }
  }

  private receive(value: unknown, source: 'server' | 'datachannel', connection?: Connection) {
    if (this.disposed || (connection && this.connection !== connection)) return
    const event = object(value)
    const body = { ...event, ...object(event.data) }
    const type = event.type ?? event.name
    // Lifecycle events from the shared SSE may belong to another browser/case.
    if (source === 'server' && body.case_id !== this.state.caseId && object(body.request).case_id !== this.state.caseId && object(body.handoff).case_id !== this.state.caseId) return
    if (body.case_id !== undefined && body.case_id !== this.state.caseId) return
    const current = connection ?? this.connection
    const sessionId = object(body.session).id ?? body.session_id
    if ((type === 'session.started' || type === 'session.closed' || type === 'session.ended') && sessionId && current?.sessionId && sessionId !== current.sessionId) return
    if (type === 'session.started' && current) {
      current.started = true
      clearTimeout(current.startTimer)
      this.patch({ phase: 'connected' })
    }
    this.publish(this.reducer.apply(this.state, event, source))
    if (type === 'session.closed' || type === 'session.ended' || type === 'live.closed') void this.stop()
    if (type === 'error' && source === 'datachannel') void this.stop(this.state.error)
  }

  async start(language = this.state.language) {
    if (this.disposed || this.connection || this.closing) return
    if (!this.state.configured || !this.state.mcpConfigured) {
      this.patch({ error: '音声サーバーの設定・接続を確認してください。 / Check voice server configuration.' })
      return
    }
    if (!this.runtime.supported()) {
      this.patch({ error: 'HTTPSまたはlocalhostと、マイク・WebRTC対応ブラウザが必要です。 / Use HTTPS or localhost with WebRTC.' })
      return
    }
    const connection: Connection = { started: false }
    this.connection = connection
    this.reducer.reset()
    this.patch({ phase: 'connecting', language, route: 'reception', transcripts: [], muted: false, playbackBlocked: false, error: '', backend: 'idle', backendResult: '', cleanupWarning: '' })
    try {
      const stream = await this.runtime.microphone()
      if (this.connection !== connection) { stream.getTracks().forEach(track => track.stop()); return }
      connection.stream = stream
      const peer = this.runtime.peer()
      connection.peer = peer
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream)
      peer.ontrack = event => {
        if (this.connection !== connection) return
        this.audio ??= this.runtime.audio()
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void this.playAudio()
      }
      peer.onconnectionstatechange = () => {
        if (this.connection !== connection) return
        clearTimeout(connection.disconnectTimer)
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') void this.stop('音声接続が終了しました。 / Voice connection ended.')
        else if (peer.connectionState === 'disconnected') {
          this.patch({ phase: 'reconnecting' })
          connection.disconnectTimer = setTimeout(() => void this.stop('音声接続が切断されました。 / Voice connection lost.'), 10000)
        } else if (peer.connectionState === 'connected' && connection.started) this.patch({ phase: 'connected' })
      }
      const channel = peer.createDataChannel('oai-events')
      connection.channel = channel
      channel.onmessage = event => {
        try { this.receive(JSON.parse(event.data), 'datachannel', connection) } catch { /* Ignore malformed frames. */ }
      }
      channel.onclose = () => { if (this.connection === connection) void this.stop('音声イベント接続が終了しました。 / Voice event connection closed.') }
      const offer = await peer.createOffer()
      if (this.connection !== connection) return
      await peer.setLocalDescription(offer)
      await this.waitForIce(connection)
      if (this.connection !== connection) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('音声接続情報を作成できません。 / No SDP offer.')
      // Do not abort this request on Stop: a late response still needs DELETE.
      const created = await this.api('/api/live/session', { method: 'POST', body: JSON.stringify({ sdp, language, case_id: this.state.caseId }) })
      const id = object(created.session).id ?? created.session_id
      if (typeof id === 'string') connection.sessionId = id
      if (this.connection !== connection) { if (connection.sessionId) await this.deleteSession(connection.sessionId); return }
      const answer = object(created.transport).sdp
      if (!connection.sessionId || typeof answer !== 'string' || (created.case_id !== undefined && created.case_id !== this.state.caseId)) throw new Error('音声サーバーの応答が不正です。 / Invalid voice session response.')
      await peer.setRemoteDescription({ type: 'answer', sdp: answer })
      if (this.connection !== connection) return
      // HTTP creation starts Live. Wait for session.started; never send session.start.
      if (!connection.started) connection.startTimer = setTimeout(() => void this.stop('音声の開始を確認できませんでした。 / Voice session did not start.'), 20000)
    } catch (error) {
      if (this.connection === connection) await this.stop(microphoneError(error))
    }
  }

  private waitForIce(connection: Connection) {
    const peer = connection.peer!
    if (peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', changed); connection.cancelIce = undefined; resolve() }
      const changed = () => { if (peer.iceGatheringState === 'complete') done() }
      const timer = setTimeout(done, 2000)
      connection.cancelIce = done
      peer.addEventListener('icegatheringstatechange', changed)
    })
  }

  setMuted(muted: boolean) {
    if (!this.connection?.stream) return
    this.connection.stream.getAudioTracks().forEach(track => { track.enabled = !muted })
    this.patch({ muted })
  }

  async playAudio() {
    const audio = this.audio
    const connection = this.connection
    if (!audio || !connection) return
    try { await audio.play(); if (this.connection === connection) this.patch({ playbackBlocked: false }) }
    catch { if (this.connection === connection) this.patch({ playbackBlocked: true }) }
  }

  private async deleteSession(id: string, keepalive = false) {
    try {
      const result = await this.api(`/api/live/session/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive })
      const warnings = []
      if (result.live_finalized !== true) warnings.push('音声セッションの最終応答は未確認です。 / Live finalization is unconfirmed.')
      if (Array.isArray(result.cleanup_pending) && result.cleanup_pending.length) warnings.push('サーバーで終了処理が残っています。 / Server cleanup is pending.')
      if (warnings.length) this.patch({ cleanupWarning: warnings.join(' ') })
    } catch { this.patch({ cleanupWarning: 'マイクは停止しましたが、サーバー側の終了を確認できません。 / Microphone stopped; server cleanup could not be confirmed.' }) }
  }

  async stop(error = '', keepalive = false) {
    if (this.closing) return this.closing
    const connection = this.connection
    if (!connection) return
    this.connection = null
    clearTimeout(connection.startTimer)
    clearTimeout(connection.disconnectTimer)
    connection.cancelIce?.()
    connection.stream?.getTracks().forEach(track => track.stop())
    if (connection.channel) { connection.channel.onmessage = null; connection.channel.onclose = null }
    if (connection.peer) { connection.peer.ontrack = null; connection.peer.onconnectionstatechange = null }
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null }
    this.patch({ phase: 'stopping', error, muted: false, playbackBlocked: false })
    // Stop capture immediately, retain transport until backend finalization, then close it.
    this.closing = (async () => {
      try { if (connection.sessionId) await this.deleteSession(connection.sessionId, keepalive) }
      finally {
        connection.channel?.close()
        connection.peer?.close()
        this.patch({ phase: error ? 'error' : 'ended' })
      }
    })()
    try { await this.closing } finally { this.closing = null }
  }

  dispose() {
    if (this.disposed) return
    this.source?.close()
    if (this.source) { this.source.onopen = null; this.source.onmessage = null; this.source.onerror = null }
    clearInterval(this.poll)
    clearTimeout(this.reconnectTimer)
    void this.stop('', true)
    this.disposed = true
    this.listeners.clear()
  }
}

function microphoneError(error: unknown) {
  const name = error instanceof Error ? error.name : ''
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return 'マイクが許可されていません。 / Microphone permission denied.'
  if (name === 'NotFoundError') return '使用できるマイクが見つかりません。 / No microphone found.'
  if (name === 'NotReadableError') return 'マイクを使用できません。 / Microphone is unavailable.'
  return error instanceof Error ? error.message : '音声接続を開始できません。 / Cannot start voice connection.'
}
