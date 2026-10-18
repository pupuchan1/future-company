import { Hono } from 'hono'
import { createProductionVoiceProxy } from '../deployment/worker-proxy.mjs'
import { renderer } from './renderer'
import { authorizeVisitorCase, createBackendApi, projectCase } from './backend/api'
import { authorizeDemoStaff } from './backend/auth'
import type { StaffAuthEnv } from './backend/auth'
import type { BackendEnv } from './backend/case-room'
import { handleMcpRequest } from './backend/mcp-events'
import { createOpenAIApi } from './backend/openai'
import type { OpenAIEnv } from './backend/openai'

export { CaseRoom } from './backend/case-room'

type VoiceEnv = { NODE_RELAY_ORIGIN?: string; NODE_RELAY_SECRET?: string; NODE_RELAY_EVENTS_TRANSPORT?: 'websocket' | 'sse' }
const app = new Hono<{ Bindings: BackendEnv & OpenAIEnv & StaffAuthEnv & VoiceEnv }>()
const voice = createProductionVoiceProxy({ authorizeCase: authorizeVisitorCase, allowLoopbackTarget: !import.meta.env.PROD })
app.use('/api/v1/cases/*', async (c, next) => {
  const response = await voice(c.req.raw, c.env)
  if (response) return response
  await next()
})

app.route('/api/v1', createBackendApi({ authorizeStaff: authorizeDemoStaff }))
app.route('/api/v1', createOpenAIApi({ authorizeCase: authorizeVisitorCase, projectCase }))
app.post('/mcp', (c) => handleMcpRequest(c.req.raw, c.env.DB, {}))

app.use(renderer)

app.get('/', (c) => {
  return c.render(<h1>Hello!</h1>)
})

export default app
