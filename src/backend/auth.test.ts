import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorizeDemoStaff, isDemoStaffConfigured, requireStaffIdentity, staffSessionCookie } from './auth'
import type { BackendEnv } from './case-room'

const request = new Request('https://example.test/api/v1/staff/cases', { headers: { 'x-internal-staff-id': 'forged', 'Cf-Access-Authenticated-User-Email': 'forged@example.test' } })
const env = {} as BackendEnv

test('staff identities only come from the injected verifier', async () => {
  assert.deepEqual(await requireStaffIdentity(request, env, async (actual, bindings) => {
    assert.equal(actual, request)
    assert.equal(bindings, env)
    return { id: 'employee@example.test' }
  }), { role: 'staff', id: 'employee@example.test' })
  await assert.rejects(requireStaffIdentity(request, env, async () => null), { code: 'staff_auth_required', status: 401 })
})

test('invalid verifier identities fail closed and verifier failures propagate', async () => {
  for (const id of ['', ' ', ' employee', 'employee ', 'line\nbreak', 'a'.repeat(201)]) {
    await assert.rejects(requireStaffIdentity(request, env, async () => ({ id })), { code: 'staff_auth_required', status: 401 })
  }
  const error = new Error('Identity service unavailable')
  await assert.rejects(requireStaffIdentity(request, env, async () => { throw error }), error)
})

const token = 'test-only-demo-credential-0123456789'
const demoEnv = { ...env, STAFF_API_TOKEN: token }
test('demo authentication requires a configured secret and accepts only a valid credential', async () => {
  for (const secret of [undefined, '', 'short', 'a'.repeat(201), 'a'.repeat(31) + ' ', 'あ'.repeat(32)]) assert.equal(isDemoStaffConfigured({ STAFF_API_TOKEN: secret }), false)
  for (const secret of ['a'.repeat(32), 'z'.repeat(200), token]) assert.equal(isDemoStaffConfigured({ STAFF_API_TOKEN: secret }), true)
  await assert.rejects(authorizeDemoStaff(request, env), { code: 'staff_auth_unconfigured', status: 503 })
  await assert.rejects(authorizeDemoStaff(request, { ...env, STAFF_API_TOKEN: 'short' }), { code: 'staff_auth_unconfigured', status: 503 })
  assert.equal(await authorizeDemoStaff(request, demoEnv), null)
  for (const authorization of ['Basic forged', 'Bearer invalid', `Bearer ${token}suffix`]) {
    assert.equal(await authorizeDemoStaff(new Request(request.url, { headers: { Authorization: authorization } }), demoEnv), null)
  }
  assert.deepEqual(await authorizeDemoStaff(new Request(request.url, { headers: { Authorization: `Bearer ${token}` } }), demoEnv), { id: 'demo-staff' })
})

test('signed staff sessions survive reloads, reject tampering, and are invalidated by token rotation', async () => {
  const login = new Request('https://example.test/api/v1/staff/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  const cookie = await staffSessionCookie(login, demoEnv)
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /SameSite=Strict/)
  assert.match(cookie, /Secure/)
  assert.match(cookie, /Path=\/api\/v1\/staff/)
  assert.doesNotMatch(cookie, /Max-Age|Expires/)
  assert.ok(!cookie.includes(token))
  const authenticated = new Request(request.url, { headers: { Cookie: cookie.split(';')[0] } })
  assert.deepEqual(await authorizeDemoStaff(authenticated, demoEnv), { id: 'demo-staff' })
  assert.equal(await authorizeDemoStaff(authenticated, { ...demoEnv, STAFF_API_TOKEN: 'changed-demo-credential-0123456789' }), null)
  assert.equal(await authorizeDemoStaff(new Request(request.url, { headers: { Cookie: 'future_company_staff=demo-staff.forged' } }), demoEnv), null)
  await assert.rejects(staffSessionCookie(request, demoEnv), { code: 'staff_auth_required', status: 401 })
})
