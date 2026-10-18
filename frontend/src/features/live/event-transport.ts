/** Only the authenticated demo gateway injects this marker. Normal Worker delivery stays SSE. */
export interface LiveEventTransport {
  readonly readyState: number
  onopen: ((event: Event) => unknown) | null
  onmessage: ((event: MessageEvent<string>) => unknown) | null
  onerror: ((event: Event) => unknown) | null
  close(): void
}

interface Environment {
  href: string
  websocket: boolean
  eventSource(url: string): EventSource
  socket(url: string): WebSocket
}

export function createEventTransport(path = '/api/events', environment: Environment = {
  href: location.href,
  websocket: document.querySelector('meta[name="future-company-events"]')?.getAttribute('content') === 'websocket',
  eventSource: url => new EventSource(url),
  socket: url => new WebSocket(url),
}): LiveEventTransport {
  const url = new URL(path, environment.href)
  const useSocket = environment.websocket && /^\/api\/v1\/cases\/[A-Za-z0-9_-]{1,100}\/voice\/events$/.test(url.pathname)
  if (url.origin !== new URL(environment.href).origin || url.search || url.hash) throw new Error('Events must use the same reception origin.')
  if (useSocket) url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const source = useSocket ? environment.socket(url.href) : environment.eventSource(path)
  let closed = false
  let terminal = false
  const transport: LiveEventTransport = {
    get readyState() { return closed || terminal || (useSocket && source.readyState >= 2) ? 2 : source.readyState },
    onopen: null, onmessage: null, onerror: null,
    close() { closed = true; source.close() },
  }
  source.addEventListener('open', event => { if (!closed) transport.onopen?.(event) })
  source.addEventListener('message', event => {
    if (!closed && !terminal && typeof (event as MessageEvent).data === 'string') transport.onmessage?.(event as MessageEvent<string>)
  })
  const failed = (event: Event) => {
    if (closed || terminal) return
    if (useSocket) { terminal = true; source.close() }
    transport.onerror?.(event)
  }
  source.addEventListener('error', failed)
  if (useSocket) source.addEventListener('close', failed)
  return transport
}
