export type LiveLanguage = 'ja' | 'en'
export type LiveLanguagePreference = 'auto' | LiveLanguage
export const LANGUAGE_CHANGE_ERROR = '会話の言語を変更できませんでした。 / Could not change the conversation language.'
export type LiveRoute = 'reception' | 'recruiting' | 'haas'
export type LivePhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'switching' | 'stopping' | 'ended' | 'error'
export type LiveSpeaking = 'user' | 'assistant' | 'both' | 'silent'
export type JsonObject = Record<string, unknown>

export interface LiveTranscript {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  final: boolean
}

export interface LiveHumanRequest {
  handoffId: string
  caseId: string
  summary: string
  targetRole?: string
  task?: string
  expectedResult?: string
  status: string
  revision: number
  simulated?: boolean
  audioConnected?: boolean
  unavailableReason?: string
  result?: { text: string; language: LiveLanguage }
}

export interface LiveSnapshot {
  caseId: string
  phase: LivePhase
  events: 'connecting' | 'connected' | 'reconnecting' | 'closed'
  configured: boolean | null
  mcpConfigured: boolean | null
  route: LiveRoute
  voiceRoute: LiveRoute
  voice: string
  switchConfigured: boolean
  voiceMap: Partial<Record<LiveRoute, string>>
  language: LiveLanguage
  muted: boolean
  playbackBlocked: boolean
  /** Measured RMS amplitude, 0..1; transcripts never change these values. */
  inputLevel: number
  outputLevel: number
  speaking: LiveSpeaking
  meteringAvailable: boolean
  transcripts: LiveTranscript[]
  requests: LiveHumanRequest[]
  backend: 'idle' | 'running' | 'result' | 'error'
  backendResult: string
  error: string
  cleanupWarning: string
}

export function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

export function initialSnapshot(caseId: string, language: LiveLanguage): LiveSnapshot {
  return {
    caseId, language, route: 'reception', voiceRoute: 'reception', voice: '', switchConfigured: false, voiceMap: {}, phase: 'idle', events: 'connecting',
    configured: null, mcpConfigured: null, muted: false, playbackBlocked: false,
    inputLevel: 0, outputLevel: 0, speaking: 'silent', meteringAvailable: false,
    transcripts: [], requests: [], backend: 'idle', backendResult: '', error: '', cleanupWarning: '',
  }
}
