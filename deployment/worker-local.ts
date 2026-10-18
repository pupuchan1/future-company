import app from '../src/index'
import { authorizeVisitorCase } from '../src/backend/api'
import { createProductionVoiceProxy } from './worker-proxy.mjs'

export { CaseRoom } from '../src/backend/case-room'

// The production entry keeps its HTTPS-only target restriction.
const voice = createProductionVoiceProxy({ authorizeCase: authorizeVisitorCase, allowLoopbackTarget: true })

export default {
  async fetch(request: Request, env: CloudflareBindings, ctx: ExecutionContext): Promise<Response> {
    const response = await voice(request, env)
    return response ?? app.fetch(request, env, ctx)
  },
}
