/** Observe only the active call. The observer never owns or stops Live tracks. */
export interface LiveMediaObserver {
  setInput(stream: MediaStream): void
  setOutput(stream: MediaStream | null): void
  setEnabled(input: boolean, output: boolean): void
  stop(): void
}

export type RecordingPhase = 'idle' | 'preparing' | 'recording' | 'encoding' | 'ready' | 'unavailable' | 'error'
export interface RecordingSnapshot {
  phase: RecordingPhase
  url: string | null
  filename: string
  seconds: number
  bytes: number
}

export type EncoderInput =
  | { type: 'start'; sampleRate: number }
  | { type: 'pcm'; samples: Float32Array }
  | { type: 'finish' }
export type EncoderOutput =
  | { type: 'progress'; seconds: number }
  | { type: 'finished'; blob: Blob; seconds: number }
  | { type: 'error' }
