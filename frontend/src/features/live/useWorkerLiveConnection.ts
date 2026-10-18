import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { caseVoicePrefix } from './client'
import { WorkerCaseClient } from './worker-case'
import { initialSnapshot } from './types'
import type { LiveLanguage } from './types'
import { useLiveConnection } from './useLiveConnection'

export function useWorkerLiveConnection({ conversationKey, language, kind }: { conversationKey: string; language: LiveLanguage; kind: string }) {
  const client = useMemo(() => new WorkerCaseClient(conversationKey, kind), [conversationKey, kind])
  const worker = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot)
  useEffect(() => {
    void client.ensure(language)
  }, [client, language])
  const ready = worker.status === 'ready'
  const live = useLiveConnection({
    caseId: ready ? worker.caseId : '', language,
    apiPrefix: ready ? caseVoicePrefix(worker.caseId) : undefined,
    enabled: ready,
  })
  return {
    ...live,
    snapshot: ready ? live.snapshot.caseId === worker.caseId ? live.snapshot : initialSnapshot(worker.caseId, language)
      : { ...initialSnapshot('', language), phase: worker.status === 'error' ? 'error' as const : 'idle' as const, error: worker.error },
    caseStatus: worker.status,
    refreshStatus: () => ready ? live.refreshStatus() : client.ensure(language),
  }
}
