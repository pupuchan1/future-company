import test from 'node:test'
import assert from 'node:assert/strict'
import { ReceptionNavigation } from '../src/lib/reception-navigation.ts'
import type { ReceptionHistory } from '../src/lib/reception-navigation.ts'

function browserAt(path: string) {
  const entries = [path]
  let index = 0
  const listeners = new Set<() => void>()
  const browser: ReceptionHistory = {
    location: { pathname: path },
    history: { pushState(_data, _unused, url) {
      entries.splice(++index)
      entries.push(url)
      browser.location.pathname = url
    } },
    addEventListener(_type, listener) { listeners.add(listener) },
    removeEventListener(_type, listener) { listeners.delete(listener) },
  }
  return { browser, entries, listeners, back() {
    index = Math.max(0, index - 1)
    browser.location.pathname = entries[index]
    listeners.forEach(listener => listener())
  }, forward() {
    index = Math.min(entries.length - 1, index + 1)
    browser.location.pathname = entries[index]
    listeners.forEach(listener => listener())
  } }
}

test('screen navigation uses history without reloading or adding duplicate entries', () => {
  const f = browserAt('/')
  const navigation = new ReceptionNavigation(f.browser)
  let updates = 0
  const unsubscribe = navigation.subscribe(() => updates++)
  navigation.navigate('conversation')
  navigation.navigate('conversation')
  assert.equal(navigation.getScreen(), 'conversation')
  assert.deepEqual(f.entries, ['/', '/conversation'])
  assert.equal(updates, 1)
  navigation.navigate('home')
  assert.equal(navigation.getScreen(), 'home')
  assert.equal(updates, 2)
  unsubscribe()
  assert.equal(f.listeners.size, 0)
})

test('back and forward report the current screen without starting another navigation', () => {
  const f = browserAt('/')
  const navigation = new ReceptionNavigation(f.browser)
  const screens: string[] = []
  const unsubscribe = navigation.subscribe(() => screens.push(navigation.getScreen()))
  navigation.navigate('conversation')
  f.back()
  f.forward()
  assert.deepEqual(screens, ['conversation', 'home', 'conversation'])
  assert.deepEqual(f.entries, ['/', '/conversation'])
  unsubscribe()
})

test('the conversation URL works on direct entry and with a trailing slash', () => {
  assert.equal(new ReceptionNavigation(browserAt('/conversation').browser).getScreen(), 'conversation')
  assert.equal(new ReceptionNavigation(browserAt('/conversation/').browser).getScreen(), 'conversation')
  assert.equal(new ReceptionNavigation(browserAt('/').browser).getScreen(), 'home')
})
