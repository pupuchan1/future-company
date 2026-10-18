type BridgeClaims = { caseId: string; expiresAt: number }
const bytes = new TextEncoder()
const encode = (value: Uint8Array): string => btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))
const key = (secret: string): Promise<CryptoKey> => crypto.subtle.importKey('raw', bytes.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])

export async function issueBridgeProof(caseId: string, secret: string, now = Date.now()): Promise<string> {
  const payload = encode(bytes.encode(JSON.stringify({ caseId, expiresAt: now + 900000 } satisfies BridgeClaims)))
  const signature = await crypto.subtle.sign('HMAC', await key(secret), bytes.encode(`future-company:bridge:v1:${payload}`))
  return `${payload}.${encode(new Uint8Array(signature))}`
}

export async function verifyBridgeProof(token: unknown, caseId: string, secret: string, now = Date.now()): Promise<boolean> {
  if (typeof token !== 'string' || token.length > 1000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return false
  try {
    const [payload, signature] = token.split('.')
    if (!await crypto.subtle.verify('HMAC', await key(secret), decode(signature), bytes.encode(`future-company:bridge:v1:${payload}`))) return false
    const claims: unknown = JSON.parse(new TextDecoder().decode(decode(payload)))
    return typeof claims === 'object' && claims !== null && 'caseId' in claims && claims.caseId === caseId
      && 'expiresAt' in claims && typeof claims.expiresAt === 'number' && Number.isSafeInteger(claims.expiresAt)
      // The Worker issuer and Node verifier can have slightly different clocks.
      && claims.expiresAt > now && claims.expiresAt <= now + 900000 + 30000
  } catch { return false }
}
