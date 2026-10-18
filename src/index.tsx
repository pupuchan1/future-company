import { Hono } from 'hono'
import { renderer } from './renderer'
import { authorizeVisitorCase, createBackendApi, projectCase } from './backend/api'
import { authorizeDemoStaff } from './backend/auth'
import type { StaffAuthEnv } from './backend/auth'
import type { BackendEnv } from './backend/case-room'
import { handleMcpRequest } from './backend/mcp-events'
import { createOpenAIApi } from './backend/openai'
import type { OpenAIEnv } from './backend/openai'

export { CaseRoom } from './backend/case-room'

const app = new Hono<{ Bindings: BackendEnv & OpenAIEnv & StaffAuthEnv }>()

app.route('/api/v1', createBackendApi({ authorizeStaff: authorizeDemoStaff }))
app.route('/api/v1', createOpenAIApi({ authorizeCase: authorizeVisitorCase, projectCase }))
app.post('/mcp', (c) => handleMcpRequest(c.req.raw, c.env.DB, {}))

app.use(renderer)

app.get('/', (c) => {
  return c.render(<h1>Hello!</h1>)
})

export default app
