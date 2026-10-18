import { ApiError } from './contracts'
import type { Actor } from './contracts'
import type { BackendEnv } from './case-room'
import { parseSigned, serializeSigned } from 'hono/utils/cookie'
import { timingSafeEqual } from 'hono/utils/buffer'

export type StaffIdentity = { id: string }
export type AuthorizeStaff = (request: Request, env: BackendEnv) => Promise<StaffIdentity | null>
export type StaffAuthEnv = { STAFF_API_TOKEN?: string }
const staffCookieName = 'future_company_staff'

export function isDemoStaffConfigured(env: StaffAuthEnv): env is StaffAuthEnv & { STAFF_API_TOKEN: string } {
  return typeof env.STAFF_API_TOKEN === 'string' && /^[A-Za-z0-9_-]{32,200}$/.test(env.STAFF_API_TOKEN)
}

function staffSecret(env: StaffAuthEnv): string {
  if (!isDemoStaffConfigured(env)) throw new ApiError(503, 'staff_auth_unconfigured', 'Configure STAFF_API_TOKEN with 32 to 200 URL-safe characters.')
  return env.STAFF_API_TOKEN
}

async function validBearer(request: Request, secret: string): Promise<boolean> {
  const match = /^Bearer ([A-Za-z0-9_-]{32,200})$/i.exec(request.headers.get('Authorization') ?? '')
  return match !== null && await timingSafeEqual(match[1], secret)
}

export async function authorizeDemoStaff(request: Request, env: BackendEnv & StaffAuthEnv): Promise<StaffIdentity | null> {
  const secret = staffSecret(env)
  if (request.headers.has('Authorization')) return await validBearer(request, secret) ? { id: 'demo-staff' } : null
  const cookie = await parseSigned(request.headers.get('Cookie') ?? '', secret, staffCookieName)
  return cookie[staffCookieName] === 'demo-staff' ? { id: 'demo-staff' } : null
}

export async function staffSessionCookie(request: Request, env: StaffAuthEnv): Promise<string> {
  const secret = staffSecret(env)
  if (!await validBearer(request, secret)) throw new ApiError(401, 'staff_auth_required', 'Staff authentication is required.')
  return serializeSigned(staffCookieName, 'demo-staff', secret, { httpOnly: true, secure: new URL(request.url).protocol === 'https:', sameSite: 'Strict', path: '/api/v1/staff' })
}

export async function requireStaffIdentity(request: Request, env: BackendEnv, authorize: AuthorizeStaff): Promise<Actor & { role: 'staff' }> {
  const identity = await authorize(request, env)
  if (!identity || typeof identity.id !== 'string' || !identity.id || identity.id !== identity.id.trim() || identity.id.length > 200 || /[\u0000-\u001f\u007f]/.test(identity.id)) {
    throw new ApiError(401, 'staff_auth_required', 'Staff authentication is required.')
  }
  return { role: 'staff', id: identity.id }
}
