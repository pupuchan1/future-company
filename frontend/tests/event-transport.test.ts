import test from 'node:test'
import assert from 'node:assert/strict'
import { createEventTransport } from '../src/features/live/event-transport.ts'

class Source extends EventTarget {
  readyState = 0
  closes = 0
  close() { this.closes++; this.readyState = 3 }
}
function fixture(websocket: boolean) {
  const source = new Source()
  const calls: { kind: string; url: string }[] = []
  const environment = { href: 'https://private-demo.test/', websocket,
    eventSource(url: string) { calls.push({ kind: 'sse', url }); return source as unknown as EventSource },
    socket(url: string) { calls.push({ kind: 'ws', url }); return source as unknown as WebSocket },
  }
  return { source, calls, environment }
}
test('normal Worker delivery stays SSE and preserves native retry state', () => {
  const f = fixture(false)
  const events = createEventTransport('/api/v1/cases/owned/voice/events', f.environment)
  let failures = 0
  events.onerror = () => { failures++ }
  f.source.dispatchEvent(new Event('error'))
  assert.deepEqual(f.calls, [{ kind: 'sse', url: '/api/v1/cases/owned/voice/events' }])
  assert.equal(events.readyState, 0); assert.equal(failures, 1); assert.equal(f.source.closes, 0)
  events.close(); assert.equal(events.readyState, 2)
})
test('gateway marker selects same-origin WSS only for case voice events', () => {
  const f = fixture(true)
  const events = createEventTransport('/api/v1/cases/owned/voice/events', f.environment)
  let message = ''
  events.onmessage = event => { message = event.data }
  f.source.dispatchEvent(new MessageEvent('message', { data: '{"case_id":"owned"}' }))
  assert.equal(message, '{"case_id":"owned"}')
  assert.deepEqual(f.calls, [{ kind: 'ws', url: 'wss://private-demo.test/api/v1/cases/owned/voice/events' }])
  const legacy = fixture(true); createEventTransport('/api/events', legacy.environment)
  assert.equal(legacy.calls[0].kind, 'sse')
})
test('closed WS is reported once as terminal so LiveClient reconnects, intentional close stays silent', () => {
  const f = fixture(true)
  const events = createEventTransport('/api/v1/cases/owned/voice/events', f.environment)
  let failures = 0
  events.onerror = () => { failures++; assert.equal(events.readyState, 2) }
  f.source.dispatchEvent(new Event('error')); f.source.dispatchEvent(new Event('close'))
  assert.equal(failures, 1)
  const other = fixture(true)
  const stopped = createEventTransport('/api/v1/cases/owned/voice/events', other.environment)
  stopped.onerror = () => assert.fail('Intentional stop must not reconnect')
  stopped.close(); other.source.dispatchEvent(new Event('close'))
})
test('event transport refuses external origins or query credentials', () => {
  const f = fixture(true)
  for (const path of ['https://other.test/api/events', '/api/v1/cases/a/voice/events?token=secret', '/api/events#token']) assert.throws(() => createEventTransport(path, f.environment), /same reception origin/)
  assert.equal(f.calls.length, 0)
})
