import { test, expect } from 'bun:test'
import { issueBridgeProof, verifyBridgeProof } from './bridge-proof'
import { applyCommand } from './contracts'
import type { StoredCase } from './contracts'

const secret = 'a'.repeat(64)
const staff = { role: 'staff', id: 'demo-staff' } as const
const now = '2026-10-18T06:00:00Z'
const create = (): StoredCase => ({ id: 'case-1', kind: 'support', locale: 'en', ownerHash: 'owner', revision: 0,
  status: 'active', createdAt: now, updatedAt: now, messages: [], facts: [], requests: [], ai: { status: 'unavailable', reason: 'not connected' } })
const register = { type: 'register_handoff', nodeCaseId: 'case-1', handoffId: 'handoff-1', route: 'haas', summary: 'Ask an engineer', task: '開発環境は？', targetRole: 'Engineer', expectedResult: 'Text answer' } as const

test('case proof is owner-scoped in payload and rejects expiry, tampering and malformed input', async () => {
  const proof = await issueBridgeProof('case-1', secret, 1000)
  expect(await verifyBridgeProof(proof, 'case-1', secret, 1001)).toBe(true)
  expect(await verifyBridgeProof(proof, 'case-2', secret, 1001)).toBe(false)
  expect(await verifyBridgeProof(proof, 'case-1', 'b'.repeat(64), 1001)).toBe(false)
  expect(await verifyBridgeProof(proof, 'case-1', secret, 901000)).toBe(false)
  for (const bad of [null, '', 'x.y', 'a'.repeat(2000), proof.slice(0, -1) + '!']) expect(await verifyBridgeProof(bad, 'case-1', secret, 1001)).toBe(false)
})

test('case proof tolerates a slightly faster issuer clock without accepting expired or distant-future proofs', async () => {
  const verifierNow = 1000000
  const proof = await issueBridgeProof('case-1', secret, verifierNow + 2173)
  expect(await verifyBridgeProof(proof, 'case-1', secret, verifierNow)).toBe(true)
  const boundary = await issueBridgeProof('case-1', secret, verifierNow + 30000)
  expect(await verifyBridgeProof(boundary, 'case-1', secret, verifierNow)).toBe(true)
  const beyond = await issueBridgeProof('case-1', secret, verifierNow + 30001)
  expect(await verifyBridgeProof(beyond, 'case-1', secret, verifierNow)).toBe(false)
  expect(await verifyBridgeProof(proof, 'case-2', secret, verifierNow)).toBe(false)
  expect(await verifyBridgeProof(proof, 'case-1', 'b'.repeat(64), verifierNow)).toBe(false)
  expect(await verifyBridgeProof(proof, 'case-1', secret, verifierNow + 902173)).toBe(false)
})

test('HaaS uses an explicit stable origin and saved result without exchange stock requirements', () => {
  let state = applyCommand(create(), staff, register, now)
  expect(state.requests[0].origin).toEqual({ nodeCaseId: 'case-1', handoffId: 'handoff-1', route: 'haas', targetRole: 'Engineer', expectedResult: 'Text answer' })
  state = applyCommand(state, staff, { type: 'claim', requestId: state.requests[0].id }, now)
  state = applyCommand(state, staff, { type: 'answer', requestId: state.requests[0].id, answer: '【模擬】TypeScriptです。', answerLanguage: 'ja', simulated: true }, now)
  expect(state.requests[0].result).toEqual({ text: '【模擬】TypeScriptです。', language: 'ja' })
  expect(state.ai.status).toBe('resume_pending')
  state = applyCommand(state, staff, { type: 'delivery', handoffId: 'handoff-1', status: 'queued' }, now)
  state = applyCommand(state, staff, { type: 'delivery', handoffId: 'handoff-1', status: 'live_submitted' }, now)
  expect(state.requests[0].delivery?.status).toBe('live_submitted')
  expect(state.ai.status).toBe('resume_pending')
  expect(() => applyCommand(state, staff, { type: 'delivery', handoffId: 'handoff-1', status: 'queued' }, now)).toThrow('consumer')
  expect(() => applyCommand(state, staff, { type: 'delivery', handoffId: 'handoff-1', status: 'failed' }, now)).toThrow('overwritten')
})

test('visitor cannot register a server handoff; cancelled requests cannot be claimed or delivered', () => {
  expect(() => applyCommand(create(), { role: 'visitor', ownerHash: 'owner' }, register, now)).toThrow('Staff')
  let state = applyCommand(create(), staff, register, now)
  state = applyCommand(state, staff, { type: 'cancel_handoff', handoffId: 'handoff-1' }, now)
  expect(() => applyCommand(state, staff, { type: 'claim', requestId: state.requests[0].id }, now)).toThrow('available')
  expect(() => applyCommand(state, staff, { type: 'delivery', handoffId: 'handoff-1', status: 'queued' }, now)).toThrow('saved answer')
})
