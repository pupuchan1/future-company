export function createProductionVoiceProxy<Env>(options: {
  authorizeCase: (request: Request, env: Env, caseId: string) => Promise<unknown>
  fetchImpl?: typeof fetch
  clock?: () => number
  allowLoopbackTarget?: boolean
}): (request: Request, env: Env) => Promise<Response | undefined>
