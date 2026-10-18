import { ApiError } from './contracts'
import type { CaseSnapshot, IntegrationView } from './contracts'
import type { BackendEnv } from './case-room'

export async function persistCase(env: Pick<BackendEnv, 'DB'>, snapshot: CaseSnapshot, integration?: IntegrationView): Promise<void> {
  const summary = {
    id: snapshot.id, kind: snapshot.kind, locale: snapshot.locale, status: snapshot.status,
    revision: snapshot.revision, createdAt: snapshot.createdAt, updatedAt: snapshot.updatedAt,
    recruitment: snapshot.recruitment,
    requests: snapshot.requests.map(({ assignedTo: _, ...request }) => request), ai: snapshot.ai,
    integration: integration && {
      liveSessionId: integration.liveSessionId, agentSessionId: integration.agentSessionId,
      agentStatus: integration.agentStatus, lastEventId: integration.lastEventId,
    },
  }
  try {
    await env.DB.prepare('INSERT INTO cases(id,created_at,updated_at,revision,summary) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at, revision=excluded.revision, summary=excluded.summary WHERE excluded.revision > cases.revision')
      .bind(snapshot.id, snapshot.createdAt, snapshot.updatedAt, snapshot.revision, JSON.stringify(summary)).run()
  } catch {
    throw new ApiError(503, 'projection_failed', 'The case was saved but its staff list could not be updated. Resend the same command ID.')
  }
}
