import app from '../src/index'
import { authorizeVisitorCase } from '../src/backend/api'
import type { BackendEnv } from '../src/backend/case-room'
import type { OpenAIEnv } from '../src/backend/openai'
import type { StaffAuthEnv } from '../src/backend/auth'
import { createProductionVoiceProxy } from './worker-proxy.mjs'

export { CaseRoom } from '../src/backend/case-room'

type DeploymentEnv = BackendEnv & OpenAIEnv & StaffAuthEnv & {
  ASSETS: Fetcher
  NODE_RELAY_ORIGIN: string
  NODE_RELAY_SECRET: string
  NODE_RELAY_EVENTS_TRANSPORT?: 'websocket' | 'sse'
}

const voice = createProductionVoiceProxy({ authorizeCase: authorizeVisitorCase })

export default {
  async fetch(request: Request, env: DeploymentEnv, ctx: ExecutionContext): Promise<Response> {
    const response = await voice(request, env)
    if (response) return response
    const path = new URL(request.url).pathname
    if (path.startsWith('/api/') || path === '/mcp') return app.fetch(request, env, ctx)
    return env.ASSETS.fetch(request)
  },
}
