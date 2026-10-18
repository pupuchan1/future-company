import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { systemMessage } from '../src/lib/system-message.ts'
import {
  browserLanguage,
  LANGUAGE_PREFERENCE_KEY,
  languagePreference,
  readLanguagePreference,
  resolveLocale,
  saveLanguagePreference,
} from '../src/lib/locale.ts'

function replaceGlobal(t: TestContext, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(globalThis, key)
  Object.defineProperty(globalThis, key, { configurable: true, value })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, key, original)
    else Reflect.deleteProperty(globalThis, key)
  })
}

test('matches Japanese and English regional locales in preference order', () => {
  assert.equal(resolveLocale(['ja-JP', 'en-US']), 'ja')
  assert.equal(resolveLocale(['en-GB', 'ja-JP']), 'en')
  assert.equal(resolveLocale(['fr-FR', 'ja', 'en']), 'ja')
  assert.equal(resolveLocale(['zh-Hant', 'en-AU', 'ja']), 'en')
  assert.equal(resolveLocale(['JA-jp']), 'ja')
  assert.equal(resolveLocale(['ja_JP']), 'ja')
})

test('falls back to English without misidentifying unsupported language prefixes', () => {
  for (const locales of [[], [''], ['fr-FR', 'de-DE'], ['javanese'], ['jafoo']]) {
    assert.equal(resolveLocale(locales), 'en')
  }
})

test('uses navigator.languages, falls back to language, and supports a non-browser environment', t => {
  replaceGlobal(t, 'navigator', { languages: ['fr-FR', 'ja-JP'], language: 'en-US' })
  assert.equal(browserLanguage(), 'ja')
  Object.defineProperty(globalThis, 'navigator', { value: { languages: [], language: 'ja-JP' } })
  assert.equal(browserLanguage(), 'ja')
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-GB' } })
  assert.equal(browserLanguage(), 'en')
  Object.defineProperty(globalThis, 'navigator', { value: undefined })
  assert.equal(browserLanguage(), 'en')
})

test('only explicit supported saved preferences override automatic detection', () => {
  assert.equal(languagePreference('ja'), 'ja')
  assert.equal(languagePreference('en'), 'en')
  for (const value of [null, '', 'auto', 'ja-JP', 'fr', 'corrupt']) {
    assert.equal(languagePreference(value), 'auto')
  }
})

test('persists manual selection and removes it when returning to automatic', t => {
  const values = new Map<string, string>()
  replaceGlobal(t, 'localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  })
  assert.equal(readLanguagePreference(), 'auto')
  saveLanguagePreference('ja')
  assert.equal(readLanguagePreference(), 'ja')
  saveLanguagePreference('en')
  assert.equal(readLanguagePreference(), 'en')
  saveLanguagePreference('auto')
  assert.equal(values.has(LANGUAGE_PREFERENCE_KEY), false)
  assert.equal(readLanguagePreference(), 'auto')
})

test('disabled storage cannot break detection or manual selection', t => {
  const blocked = () => { throw new Error('Storage access denied') }
  replaceGlobal(t, 'localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked })
  assert.equal(readLanguagePreference(), 'auto')
  assert.doesNotThrow(() => saveLanguagePreference('ja'))
  assert.doesNotThrow(() => saveLanguagePreference('auto'))
})

test('system errors follow the selected language without splitting ordinary English paths', () => {
  const message = '会話の言語を変更できませんでした。 / Could not change the conversation language.'
  assert.equal(systemMessage(message, 'en'), 'Could not change the conversation language.')
  assert.equal(systemMessage(message, 'ja'), '会話の言語を変更できませんでした。')
  assert.equal(systemMessage('Connection failed / retry at /api/live', 'en'), 'Connection failed / retry at /api/live')
})
