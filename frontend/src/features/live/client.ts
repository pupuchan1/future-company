import { LiveEventReducer, putRequest, readHumanRequest } from './events.ts'
import { initialSnapshot, object } from './types.ts'
import type { JsonObject, LiveLanguage, LiveRoute, LiveSnapshot, LiveSpeaking } from './types.ts'

export interface LiveAudioLevels { inputLevel: number; outputLevel: number; inputWaveform?: number[] }
export interface LiveAudioMeter {
  setInput: (stream: MediaStream) => void
  setOutput: (stream: MediaStream) => void
  resume?: () => void
  dispose: () => void
}

type MeterSource = {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  samples: Float32Array<ArrayBuffer>
}

// Ignore ordinary near-silence for the speaker label, without inventing speech
// from transcript events or retaining a speaker label after the signal ends.
const SPEAKING_RMS = 0.012
const normalizedLevel = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0

function speakerFor(input: number, output: number): LiveSpeaking {
  const user = input >= SPEAKING_RMS
  const assistant = output >= SPEAKING_RMS
  return user && assistant ? 'both' : user ? 'user' : assistant ? 'assistant' : 'silent'
}

function browserAudioContext() {
  const Constructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Constructor) throw new Error('Web Audio is unavailable')
  return new Constructor()
}

/** Read both streams without connecting the microphone to a speaker. */
export function createAudioMeter(
  onLevels: (levels: LiveAudioLevels) => void,
  createContext: () => AudioContext = browserAudioContext,
): LiveAudioMeter | null {
  let context: AudioContext
  try { context = createContext() } catch { return null }
  let input: MeterSource | undefined
  let output: MeterSource | undefined
  let disposed = false

  const disconnect = (slot?: MeterSource) => {
    try { slot?.source.disconnect() } catch { /* Already disconnected. */ }
    try { slot?.analyser.disconnect() } catch { /* Already disconnected. */ }
  }
  const connect = (stream: MediaStream): MeterSource | undefined => {
    let source: MediaStreamAudioSourceNode | undefined
    let analyser: AnalyserNode | undefined
    try {
      source = context.createMediaStreamSource(stream)
      analyser = context.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0
      source.connect(analyser)
      return { stream, source, analyser, samples: new Float32Array(analyser.fftSize) }
    } catch {
      try { source?.disconnect() } catch { /* Best-effort partial setup cleanup. */ }
      try { analyser?.disconnect() } catch { /* Best-effort partial setup cleanup. */ }
      return undefined
    }
  }
  const read = (slot?: MeterSource) => {
    slot?.samples.fill(0)
    if (!slot || context.state !== 'running') return 0
    if (!slot.stream.getAudioTracks().some(track => track.enabled && track.readyState !== 'ended')) return 0
    try {
      slot.analyser.getFloatTimeDomainData(slot.samples)
      let squares = 0
      for (const sample of slot.samples) squares += Number.isFinite(sample) ? sample * sample : 0
      return Math.round(normalizedLevel(Math.sqrt(squares / slot.samples.length)) * 1000) / 1000
    } catch { return 0 }
  }
  const resume = () => {
    if (disposed || context.state !== 'suspended') return
    try { void context.resume().catch(() => {}) } catch { /* Audio still works without the optional meter. */ }
  }
  resume()
  const timer = setInterval(() => {
    if (disposed) return
    const inputLevel = read(input)
    const outputLevel = read(output)
    const inputSamples = input?.samples
    // Preserve signed peaks from each bucket instead of synthesizing a wave
    // from the RMS level. No additional microphone or animation loop is used.
    const inputWaveform = inputLevel > 0 && inputSamples ? Array.from({ length: 48 }, (_, i) => {
      const start = Math.floor(i * inputSamples.length / 48)
      const end = Math.floor((i + 1) * inputSamples.length / 48)
      let peak = 0
      for (let j = start; j < end; j++) if (Math.abs(inputSamples[j]) > Math.abs(peak)) peak = inputSamples[j]
      return Number.isFinite(peak) ? Math.max(-1, Math.min(1, peak)) : 0
    }) : []
    onLevels({ inputLevel, outputLevel, inputWaveform })
  }, 100)
  return {
    setInput(stream) {
      if (disposed || input?.stream === stream) return
      disconnect(input)
      input = connect(stream)
    },
    setOutput(stream) {
      if (disposed || output?.stream === stream) return
      disconnect(output)
      output = connect(stream)
    },
    resume,
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(timer)
      disconnect(input); disconnect(output)
      input = undefined; output = undefined
      try { void context.close().catch(() => {}) } catch { /* Context is already closed. */ }
    },
  }
}

export interface LiveRuntime {
  fetch: typeof fetch
  microphone: () => Promise<MediaStream>
  peer: () => RTCPeerConnection
  events: (url?: string) => EventSource
  audio: () => HTMLAudioElement
  supported: () => boolean
  /** Optional so existing transports and non-Web-Audio runtimes still work. */
  metering?: (onLevels: (levels: LiveAudioLevels) => void) => LiveAudioMeter | null
}

export interface LiveClientOptions {
  /** Omit only for the loopback development API. */
  apiPrefix?: string
}

export function caseVoicePrefix(caseId: string): string {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(caseId)) throw new Error('Invalid Worker case ID.')
  return `/api/v1/cases/${encodeURIComponent(caseId)}/voice`
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
  meter?: LiveAudioMeter | null
  audio?: HTMLAudioElement
  failure?: Error
  ready?: () => void
  rejectReady?: (error: Error) => void
  finalizing?: Promise<void>
}

interface VoiceSwitch {
  previous: Connection
  candidate: Connection
  route: LiveRoute
  muted: boolean
  token?: string
  phase: 'preparing' | 'activating' | 'uncertain'
  cancelled: boolean
  previousEnded: boolean
}

class LiveApiError extends Error {
  status: number
  constructor(message: string, status: number) { super(message); this.status = status }
}

class ActivationUncertainError extends Error {}
const isRoute = (value: unknown): value is LiveRoute => value === 'reception' || value === 'recruiting' || value === 'haas'

const browserRuntime = (): LiveRuntime => ({
  fetch: (...args) => fetch(...args),
  microphone: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
  peer: () => new RTCPeerConnection(),
  events: (url = '/api/events') => new EventSource(url),
  audio: () => { const audio = new Audio(); audio.autoplay = true; return audio },
  supported: () => window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.RTCPeerConnection === 'function',
  metering: createAudioMeter,
})

/** PR #4 transport only. It never sends disallowed frontend Live commands. */
export class LiveClient {
  private state: LiveSnapshot
  private runtime: LiveRuntime
  private listeners = new Set<(snapshot: LiveSnapshot) => void>()
  private reducer = new LiveEventReducer()
  private connection: Connection | null = null
  private voiceSwitch: VoiceSwitch | null = null
  private source: EventSource | null = null
  private poll?: ReturnType<typeof setInterval>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private statusBusy = false
  private statusError = ''
  private observing = false
  private disposed = false
  private closing: Promise<void> | null = null
  private endpoints: { status: string; events: string; session: string }

  constructor(caseId: string, language: LiveLanguage, runtime = browserRuntime(), options: LiveClientOptions = {}) {
    const prefix = options.apiPrefix
    if (prefix !== undefined && prefix !== caseVoicePrefix(caseId)) throw new Error('Voice API must use this Worker case on the same origin.')
    this.endpoints = prefix ? { status: `${prefix}/status`, events: `${prefix}/events`, session: `${prefix}/session` }
      : { status: '/api/status', events: '/api/events', session: '/api/live/session' }
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

  private audioLevels(connection: Connection, levels: LiveAudioLevels) {
    if (this.disposed || this.connection !== connection) return
    const inputLevel = this.state.muted || this.voiceSwitch ? 0 : normalizedLevel(levels.inputLevel)
    const audio = connection.audio
    const audible = audio && !this.voiceSwitch && !this.state.playbackBlocked && !audio.paused && !audio.muted
    const outputLevel = audible ? normalizedLevel(levels.outputLevel) * normalizedLevel(audio!.volume ?? 1) : 0
    const speaking = speakerFor(inputLevel, outputLevel)
    const inputWaveform = inputLevel >= SPEAKING_RMS && Array.isArray(levels.inputWaveform)
      ? levels.inputWaveform.slice(0, 48).map(sample => Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0) : []
    if (inputLevel !== this.state.inputLevel || outputLevel !== this.state.outputLevel || speaking !== this.state.speaking || inputWaveform.length || this.state.inputWaveform.length) {
      this.patch({ inputLevel, outputLevel, inputWaveform, speaking })
    }
  }

  private async api(path: string, options: RequestInit = {}) {
    const response = await this.runtime.fetch(path, {
      credentials: 'same-origin', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(35000),
    })
    let data: JsonObject
    try { data = object(await response.json()) }
    catch { throw new LiveApiError('受付の応答を確認できません。認証・接続先を確認してください。 / Invalid reception response. Check access and the endpoint.', response.status) }
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : typeof data.error === 'string' ? data.error : object(data.error).message
      throw new LiveApiError(`${typeof detail === 'string' ? detail : '接続失敗 / Connection failed'} (HTTP ${response.status})`, response.status)
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
      const source = this.runtime.events(this.endpoints.events)
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
      const data = await this.api(this.endpoints.status, { signal: AbortSignal.timeout(8000) })
      if (this.disposed) return
      if (typeof data.live_configured !== 'boolean' || typeof data.mcp_configured !== 'boolean') throw new Error('接続先の応答が不正です。 / Invalid server status.')
      const voiceMap: LiveSnapshot['voiceMap'] = {}
      for (const [route, voice] of Object.entries(object(data.voice_map))) if (isRoute(route) && typeof voice === 'string') voiceMap[route] = voice
      let next: LiveSnapshot = { ...this.state, configured: data.live_configured, mcpConfigured: data.mcp_configured, switchConfigured: data.handoff_configured === true, voiceMap,
        error: this.state.error === this.statusError ? '' : this.state.error }
      this.statusError = ''
      for (const record of Array.isArray(data.requests) ? data.requests : []) {
        const parsed = readHumanRequest(record, next.caseId)
        if (parsed) next = putRequest(next, parsed)
      }
      this.publish(next)
    } catch (error) {
      const message = error instanceof Error ? error.message : '受付へ接続できません。 / Cannot reach reception.'
      const replaceError = !this.state.error || this.state.error === this.statusError
      this.statusError = message
      this.patch({ configured: null, mcpConfigured: null, switchConfigured: false, error: replaceError ? message : this.state.error })
    } finally { this.statusBusy = false }
  }

  private receive(value: unknown, source: 'server' | 'datachannel', connection?: Connection) {
    if (this.disposed || (connection && !this.tracked(connection))) return
    const event = object(value)
    const body = { ...event, ...object(event.data) }
    const type = event.type ?? event.name
    // Lifecycle events from the shared SSE may belong to another browser/case.
    if (source === 'server' && body.case_id !== this.state.caseId && object(body.request).case_id !== this.state.caseId && object(body.handoff).case_id !== this.state.caseId) return
    if (body.case_id !== undefined && body.case_id !== this.state.caseId) return
    const sessionId = object(body.session).id ?? body.session_id
    const closed = type === 'session.closed' || type === 'session.ended' || type === 'live.closed'
    const lifecycle = type === 'session.started' || closed
    let current = connection ?? this.connection
    if (!connection && sessionId && sessionId === this.voiceSwitch?.candidate.sessionId) current = this.voiceSwitch.candidate
    if (lifecycle && sessionId && current?.sessionId && sessionId !== current.sessionId) return
    if (closed && source === 'server' && !sessionId) return
    if (type === 'session.started' && current) {
      current.started = true
      if (this.voiceSwitch?.candidate === current) this.checkCandidateReady(current)
      else if (!this.voiceSwitch) { clearTimeout(current.startTimer); this.patch({ phase: 'connected' }) }
    }
    // A candidate is silent until activation. Its transcripts are not spoken output.
    if (this.voiceSwitch?.candidate === current) {
      if (closed || type === 'error') this.failCandidate(current, '切替先の音声接続が終了しました。 / Candidate voice connection ended.')
      return
    }
    // Activation closes the old server session before its HTTP reply can arrive.
    if (this.voiceSwitch && current === this.voiceSwitch.previous && (closed || type === 'error')) {
      this.voiceSwitch.previousEnded = true
      return
    }
    this.publish(this.reducer.apply(this.state, event, source))
    if (closed) void this.stop()
    if (type === 'error' && source === 'datachannel') void this.stop(this.state.error)
  }

  private tracked(connection: Connection) {
    return this.connection === connection || this.voiceSwitch?.candidate === connection
  }

  private createMeter(connection: Connection) {
    try { connection.meter = this.runtime.metering?.(levels => this.audioLevels(connection, levels)) }
    catch { connection.meter = null }
  }

  private failCandidate(connection: Connection, message: string) {
    connection.failure = new Error(message)
    connection.rejectReady?.(connection.failure)
  }

  private checkCandidateReady(connection: Connection) {
    if (connection.failure) connection.rejectReady?.(connection.failure)
    else if (connection.started && connection.peer?.connectionState === 'connected') connection.ready?.()
  }

  private createPeer(connection: Connection) {
    const peer = this.runtime.peer()
    connection.peer = peer
    for (const track of connection.stream!.getAudioTracks()) peer.addTrack(track, connection.stream!)
    peer.ontrack = event => {
      if (!this.tracked(connection)) return
      connection.audio ??= this.runtime.audio()
      const candidate = this.voiceSwitch?.candidate === connection
      connection.audio.autoplay = !candidate
      const remoteStream = event.streams[0] ?? new MediaStream([event.track])
      connection.audio.srcObject = remoteStream
      connection.meter?.setOutput(remoteStream)
      if (!candidate && !this.voiceSwitch) void this.playAudio()
    }
    peer.onconnectionstatechange = () => {
      if (!this.tracked(connection)) return
      if (this.voiceSwitch?.candidate === connection) {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.failCandidate(connection, '切替先の接続を確認できません。 / Candidate connection failed.')
        this.checkCandidateReady(connection)
        return
      }
      if (this.voiceSwitch) {
        if (peer.connectionState === 'failed' || peer.connectionState === 'closed') this.voiceSwitch.previousEnded = true
        return
      }
      clearTimeout(connection.disconnectTimer)
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') void this.stop('音声接続が終了しました。 / Voice connection ended.')
      else if (peer.connectionState === 'disconnected') {
        this.patch({ phase: 'reconnecting' })
        connection.disconnectTimer = setTimeout(() => {
          if (this.connection === connection && !this.voiceSwitch) void this.stop('音声接続が切断されました。 / Voice connection lost.')
        }, 10000)
      } else if (peer.connectionState === 'connected' && connection.started) this.patch({ phase: 'connected' })
    }
    const channel = peer.createDataChannel('oai-events')
    connection.channel = channel
    channel.onmessage = event => {
      try { this.receive(JSON.parse(event.data), 'datachannel', connection) } catch { /* Ignore malformed frames. */ }
    }
    channel.onclose = () => {
      if (this.voiceSwitch?.candidate === connection) this.failCandidate(connection, '切替先のイベント接続が終了しました。 / Candidate event connection closed.')
      else if (this.voiceSwitch?.previous === connection) this.voiceSwitch.previousEnded = true
      else if (this.connection === connection) void this.stop('音声イベント接続が終了しました。 / Voice event connection closed.')
    }
    return peer
  }

  private async offer(connection: Connection) {
    const peer = this.createPeer(connection)
    const offer = await peer.createOffer()
    if (!this.tracked(connection)) return null
    await peer.setLocalDescription(offer)
    await this.waitForIce(connection)
    if (!this.tracked(connection)) return null
    const sdp = peer.localDescription?.sdp
    if (!sdp) throw new Error('音声接続情報を作成できません。 / No SDP offer.')
    return sdp
  }

  async start(language = this.state.language, route: LiveRoute = 'reception') {
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
    this.patch({ phase: 'connecting', language, route, voiceRoute: route, voice: '', transcripts: [], muted: false, playbackBlocked: false, error: '', backend: 'idle', backendResult: '', cleanupWarning: '', inputLevel: 0, outputLevel: 0, inputWaveform: [], speaking: 'silent', meteringAvailable: false })
    try {
      // Construct/resume inside the user's Start gesture, before microphone await.
      this.createMeter(connection)
      this.patch({ meteringAvailable: !!connection.meter })
      const stream = await this.runtime.microphone()
      if (this.connection !== connection) { stream.getTracks().forEach(track => track.stop()); return }
      connection.stream = stream
      connection.meter?.setInput(stream)
      const sdp = await this.offer(connection)
      if (!sdp || this.connection !== connection) return
      // Do not abort this request on Stop: a late response still needs DELETE.
      const created = await this.api(this.endpoints.session, { method: 'POST', body: JSON.stringify({ sdp, language, case_id: this.state.caseId, ...(route === 'reception' ? {} : { route }) }) })
      const id = object(created.session).id ?? created.session_id
      if (typeof id === 'string') connection.sessionId = id
      if (this.connection !== connection) { await this.finalize(connection); return }
      const answer = object(created.transport).sdp
      if (!connection.sessionId || typeof answer !== 'string' || (created.case_id !== undefined && created.case_id !== this.state.caseId)) throw new Error('音声サーバーの応答が不正です。 / Invalid voice session response.')
      this.patch({ voiceRoute: isRoute(created.route) ? created.route : route, voice: typeof created.voice === 'string' ? created.voice : '' })
      await connection.peer!.setRemoteDescription({ type: 'answer', sdp: answer })
      if (this.connection !== connection) return
      // HTTP creation starts Live. Wait for session.started; never send session.start.
      if (!connection.started) connection.startTimer = setTimeout(() => void this.stop('音声の開始を確認できませんでした。 / Voice session did not start.'), 20000)
    } catch (error) {
      if (this.connection === connection) await this.stop(microphoneError(error))
    }
  }

  private waitForCandidate(connection: Connection) {
    if (connection.failure) return Promise.reject(connection.failure)
    if (connection.started && connection.peer?.connectionState === 'connected') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const clear = () => {
        clearTimeout(connection.startTimer)
        connection.ready = undefined; connection.rejectReady = undefined
      }
      connection.ready = () => { clear(); resolve() }
      connection.rejectReady = error => { clear(); reject(error) }
      connection.startTimer = setTimeout(() => connection.rejectReady?.(new Error('切替先の音声開始を確認できませんでした。 / Candidate voice did not become ready.')), 20000)
      this.checkCandidateReady(connection)
    })
  }

  private async activate(attempt: VoiceSwitch): Promise<JsonObject> {
    for (let retry = 0; retry < 3; retry++) {
      if (attempt.cancelled || this.voiceSwitch !== attempt) throw new Error('Voice switch cancelled')
      try {
        const result = await this.api(`${this.endpoints.session}/${encodeURIComponent(attempt.candidate.sessionId!)}/activate`, {
          method: 'POST', body: JSON.stringify({ handoff_token: attempt.token }),
        })
        if (result.active !== true || object(result.session).id !== attempt.candidate.sessionId || result.old_session_id !== attempt.previous.sessionId || result.case_id !== this.state.caseId || result.route !== attempt.route) {
          throw new Error('Invalid activation response')
        }
        return result
      } catch (error) {
        // Only a definite client rejection permits deleting the candidate.
        // Retrying the same token resolves a response lost after server commit.
        if (error instanceof LiveApiError && error.status < 500 && ![408, 429].includes(error.status)) throw error
        if (retry < 2) await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    throw new ActivationUncertainError('担当の声の切替結果を確認できません。音声は一時停止しています。終了して再接続してください。 / Voice switch outcome is unconfirmed. End the call and reconnect.')
  }

  async switchDepartment(route: LiveRoute) {
    const previous = this.connection
    if (this.disposed || !previous?.stream || !previous.sessionId || this.closing || this.voiceSwitch) return
    if (route === this.state.voiceRoute) return
    if (!this.state.switchConfigured || this.state.phase !== 'connected') {
      this.patch({ error: '現在は担当の声を切り替えられません。 / Department voice switching is unavailable.' })
      return
    }
    const candidate: Connection = { started: false, stream: previous.stream }
    const attempt: VoiceSwitch = { previous, candidate, route, muted: this.state.muted, phase: 'preparing', cancelled: false, previousEnded: false }
    this.voiceSwitch = attempt
    previous.stream.getAudioTracks().forEach(track => { track.enabled = false })
    if (previous.audio) { previous.audio.autoplay = false; previous.audio.pause() }
    clearTimeout(previous.disconnectTimer)
    this.patch({ phase: 'switching', muted: true, playbackBlocked: false, error: '', inputLevel: 0, outputLevel: 0, inputWaveform: [], speaking: 'silent' })
    try {
      this.createMeter(candidate)
      candidate.meter?.setInput(previous.stream)
      const sdp = await this.offer(candidate)
      if (!sdp || attempt.cancelled || this.voiceSwitch !== attempt) return
      const created = await this.api(`${this.endpoints.session}/${encodeURIComponent(previous.sessionId)}/handoff`, {
        method: 'POST', body: JSON.stringify({ sdp, route }),
      })
      const id = object(created.session).id
      if (typeof id !== 'string' || !id || id === previous.sessionId) throw new Error('切替先のセッションIDが不正です。 / Invalid candidate session ID.')
      candidate.sessionId = id
      if (attempt.cancelled || this.voiceSwitch !== attempt) { await this.finalize(candidate); return }
      const answer = object(created.transport).sdp
      if (!candidate.sessionId || typeof answer !== 'string' || typeof created.handoff_token !== 'string'
        || created.case_id !== this.state.caseId || created.old_session_id !== previous.sessionId || created.route !== route) {
        throw new Error('担当の声の切替情報が不正です。 / Invalid voice handoff response.')
      }
      attempt.token = created.handoff_token
      await candidate.peer!.setRemoteDescription({ type: 'answer', sdp: answer })
      if (attempt.cancelled || this.voiceSwitch !== attempt) return
      await this.waitForCandidate(candidate)
      if (attempt.cancelled || this.voiceSwitch !== attempt) return
      attempt.phase = 'activating'
      const active = await this.activate(attempt)
      if (attempt.cancelled || this.voiceSwitch !== attempt) { await this.finalize(candidate); return }
      this.connection = candidate
      this.voiceSwitch = null
      // Both peers use the same capture tracks. Switching must not stop them.
      this.releaseTransport(previous)
      candidate.stream!.getAudioTracks().forEach(track => { track.enabled = !attempt.muted })
      this.patch({
        phase: candidate.peer?.connectionState === 'connected' ? 'connected' : 'reconnecting',
        voiceRoute: route, voice: typeof active.voice === 'string' ? active.voice : typeof created.voice === 'string' ? created.voice : '',
        muted: attempt.muted, playbackBlocked: false, meteringAvailable: !!candidate.meter,
        inputLevel: 0, outputLevel: 0, inputWaveform: [], speaking: 'silent', error: '',
      })
      if (candidate.failure || candidate.peer?.connectionState === 'failed' || candidate.peer?.connectionState === 'closed') {
        await this.stop('切替先の音声接続が終了しました。再接続してください。 / The new voice connection ended. Please reconnect.')
        return
      }
      if (candidate.peer?.connectionState !== 'connected') candidate.disconnectTimer = setTimeout(() => {
        if (this.connection === candidate && !this.voiceSwitch) void this.stop('切替先の音声が切断されました。 / The new voice connection was lost.')
      }, 10000)
      if (candidate.audio) candidate.audio.autoplay = true
      await this.playAudio()
    } catch (error) {
      if (attempt.cancelled || this.voiceSwitch !== attempt) return
      if (error instanceof ActivationUncertainError) {
        // The server may have committed: deleting this session could kill the
        // new active call. Keep both muted until the user explicitly ends it.
        attempt.phase = 'uncertain'
        this.patch({ phase: 'switching', error: error.message })
        return
      }
      this.releaseTransport(candidate)
      await this.finalize(candidate)
      if (attempt.cancelled || this.voiceSwitch !== attempt) return
      if (attempt.previousEnded) {
        await this.stop('担当の声を切り替えられず、元の音声も終了しました。再接続してください。 / Both voice connections ended. Please reconnect.')
        return
      }
      this.voiceSwitch = null
      previous.stream.getAudioTracks().forEach(track => { track.enabled = !attempt.muted })
      this.patch({ phase: previous.peer?.connectionState === 'disconnected' ? 'reconnecting' : 'connected', muted: attempt.muted, error: `担当の声を切り替えられませんでした。元の声で続けます。 / Voice unchanged. ${microphoneError(error)}` })
      if (previous.audio) previous.audio.autoplay = true
      await this.playAudio()
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
    if (!this.connection?.stream || this.voiceSwitch) return
    this.connection.stream.getAudioTracks().forEach(track => { track.enabled = !muted })
    const inputLevel = muted ? 0 : this.state.inputLevel
    this.patch({ muted, inputLevel, inputWaveform: muted ? [] : this.state.inputWaveform, speaking: speakerFor(inputLevel, this.state.outputLevel) })
  }

  async playAudio() {
    const connection = this.connection
    const audio = connection?.audio
    if (!audio || !connection || this.voiceSwitch) return
    connection.meter?.resume?.()
    try { await audio.play(); if (this.connection === connection) this.patch({ playbackBlocked: false }) }
    catch { if (this.connection === connection) this.patch({ playbackBlocked: true }) }
  }

  private async deleteSession(id: string, keepalive = false) {
    try {
      const result = await this.api(`${this.endpoints.session}/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive })
      const warnings = []
      if (result.live_finalized !== true) warnings.push('音声セッションの最終応答は未確認です。 / Live finalization is unconfirmed.')
      if (Array.isArray(result.cleanup_pending) && result.cleanup_pending.length) warnings.push('サーバーで終了処理が残っています。 / Server cleanup is pending.')
      if (warnings.length) this.patch({ cleanupWarning: warnings.join(' ') })
    } catch (error) {
      if (error instanceof LiveApiError && error.status === 404) return
      this.patch({ cleanupWarning: 'サーバー側の音声セッション終了を確認できません。 / Server voice cleanup could not be confirmed.' })
    }
  }

  private finalize(connection: Connection, keepalive = false) {
    if (!connection.sessionId) return Promise.resolve()
    connection.finalizing ??= this.deleteSession(connection.sessionId, keepalive)
    return connection.finalizing
  }

  private releaseTransport(connection: Connection) {
    clearTimeout(connection.startTimer)
    clearTimeout(connection.disconnectTimer)
    connection.cancelIce?.()
    connection.meter?.dispose(); connection.meter = null
    if (connection.channel) { connection.channel.onmessage = null; connection.channel.onclose = null; connection.channel.close() }
    if (connection.peer) { connection.peer.ontrack = null; connection.peer.onconnectionstatechange = null; connection.peer.close() }
    if (connection.audio) { connection.audio.pause(); connection.audio.srcObject = null }
  }

  async stop(error = '', keepalive = false) {
    if (this.closing) return this.closing
    const connection = this.connection
    if (!connection) return
    const attempt = this.voiceSwitch
    const connections = attempt ? [attempt.candidate, connection] : [connection]
    this.connection = null
    this.voiceSwitch = null
    if (attempt) { attempt.cancelled = true; attempt.candidate.failure = new Error('Voice switch cancelled'); attempt.candidate.rejectReady?.(attempt.candidate.failure) }
    const tracks = new Set(connections.flatMap(item => item.stream?.getTracks() ?? []))
    tracks.forEach(track => track.stop())
    for (const item of connections) {
      item.meter?.dispose(); item.meter = null
      clearTimeout(item.startTimer); clearTimeout(item.disconnectTimer); item.cancelIce?.()
      if (item.channel) { item.channel.onmessage = null; item.channel.onclose = null }
      if (item.peer) { item.peer.ontrack = null; item.peer.onconnectionstatechange = null }
      if (item.audio) { item.audio.pause(); item.audio.srcObject = null }
    }
    this.patch({ phase: 'stopping', error, muted: false, playbackBlocked: false, inputLevel: 0, outputLevel: 0, inputWaveform: [], speaking: 'silent', meteringAvailable: false })
    // Stop capture immediately, retain transport until backend finalization, then close it.
    this.closing = (async () => {
      try { for (const item of connections) await this.finalize(item, keepalive) }
      finally {
        connections.forEach(item => this.releaseTransport(item))
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
