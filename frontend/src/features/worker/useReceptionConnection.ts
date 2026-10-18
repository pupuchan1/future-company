import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveConnection } from '../live/useLiveConnection'
import { caseVoicePrefix } from '../live/client'
import type { LiveLanguage } from '../live/types'
import { WorkerCaseClient } from './cases'

/** Issue #18: create/verify the Worker case before any Live session POST. */
export function useReceptionConnection(language: LiveLanguage) {
  const [worker] = useState(() => new WorkerCaseClient())
  const [workerState, setWorkerState] = useState(() => worker.getSnapshot())
  const caseId = workerState.case?.id ?? ''
  const live = useLiveConnection({ caseId, language, enabled: Boolean(caseId), apiPrefix: caseId ? caseVoicePrefix(caseId) : undefined })
  const liveRef = useRef(live)
  useEffect(() => { liveRef.current = live }, [live])
  const generation = useRef(0)
  const starting = useRef(false)
  const queued = useRef<{ ticket: number; caseId: string; bridgeToken: string } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const invalidate = useCallback(() => { generation.current++; queued.current = null; starting.current = false }, [])
  useEffect(() => {
    const unsubscribe = worker.subscribe(setWorkerState)
    return () => { invalidate(); unsubscribe(); worker.cancel() }
  }, [worker, invalidate])
  useEffect(() => {
    const authorization = queued.current
    if (!authorization || authorization.ticket !== generation.current || workerState.phase !== 'ready' || !workerState.case || live.snapshot.caseId !== authorization.caseId || workerState.case.id !== authorization.caseId) return
    // A new case creates a new LiveClient whose status fetch may finish after the proof.
    if (live.snapshot.configured === null || live.snapshot.mcpConfigured === null) {
      if (live.snapshot.error) {
        const ticket = authorization.ticket
        queued.current = null; starting.current = false
        queueMicrotask(() => { if (ticket === generation.current) setPreparing(false) })
      }
      return
    }
    const { ticket, bridgeToken } = authorization
    queued.current = null
    const operation = live.snapshot.configured && live.snapshot.mcpConfigured ? live.start(undefined, bridgeToken) : undefined
    void Promise.resolve(operation).finally(() => { if (ticket === generation.current) { starting.current = false; setPreparing(false) } })
  }, [workerState, live])
  async function start() {
    const current = liveRef.current.snapshot
    if (starting.current || ['connecting','connected','reconnecting','switching','stopping'].includes(current.phase)) return
    const ticket = ++generation.current
    starting.current = true; setPreparing(true)
    try {
      const authorization = await worker.prepareVoice(language)
      if (ticket !== generation.current) return
      queued.current = { ticket, caseId: authorization.case.id, bridgeToken: authorization.bridgeToken }
      // Ensure React commits the new case ID before its Live hook starts.
      setWorkerState({ ...worker.getSnapshot() })
    } catch {
      if (ticket === generation.current) { starting.current = false; setPreparing(false) }
    }
  }
  async function stop() {
    invalidate()
    worker.cancel(); setPreparing(false)
    await liveRef.current.stop()
  }
  async function resetCase() {
    await stop()
    worker.reset()
  }
  return { ...live, start, stop, resetCase, preparing, worker: workerState, caseId: workerState.case?.id ?? null }
}
