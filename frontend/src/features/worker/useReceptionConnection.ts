import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveConnection } from '../live/useLiveConnection'
import type { LiveLanguage } from '../live/types'
import { WorkerCaseClient } from './cases'

/** Issue #18: create/verify the Worker case before any Live session POST. */
export function useReceptionConnection(language: LiveLanguage) {
  const [worker] = useState(() => new WorkerCaseClient())
  const [workerState, setWorkerState] = useState(() => worker.getSnapshot())
  const live = useLiveConnection({ caseId: workerState.case?.id ?? '', language })
  const liveRef = useRef(live)
  useEffect(() => { liveRef.current = live }, [live])
  const generation = useRef(0)
  const starting = useRef(false)
  const queued = useRef<number | null>(null)
  const [preparing, setPreparing] = useState(false)
  const invalidate = useCallback(() => { generation.current++; queued.current = null; starting.current = false }, [])
  useEffect(() => {
    const unsubscribe = worker.subscribe(setWorkerState)
    return () => { invalidate(); unsubscribe(); worker.cancel() }
  }, [worker, invalidate])
  useEffect(() => {
    if (queued.current === null || queued.current !== generation.current || workerState.phase !== 'ready' || !workerState.case || live.snapshot.caseId !== workerState.case.id) return
    const ticket = queued.current
    queued.current = null
    void Promise.resolve(live.start()).finally(() => { if (ticket === generation.current) { starting.current = false; setPreparing(false) } })
  }, [workerState, live])
  async function start() {
    const current = liveRef.current.snapshot
    if (starting.current || !current.configured || !current.mcpConfigured || ['connecting','connected','reconnecting','switching','stopping'].includes(current.phase)) return
    const ticket = ++generation.current
    starting.current = true; setPreparing(true)
    try {
      await worker.ensureCase(language)
      if (ticket !== generation.current) return
      queued.current = ticket
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
