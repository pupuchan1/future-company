import { useEffect, useState } from 'react'
import {
  browserLanguage,
  LANGUAGE_PREFERENCE_KEY,
  languagePreference,
  readLanguagePreference,
  saveLanguagePreference,
} from './locale.ts'
import type { LanguagePreference } from './locale.ts'

export function useDisplayLanguage() {
  const [preference, setPreference] = useState(readLanguagePreference)
  const [locale, setLocale] = useState(browserLanguage)
  const language = preference === 'auto' ? locale : preference

  useEffect(() => {
    const onLanguageChange = () => setLocale(browserLanguage())
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea !== window.localStorage) return
      } catch {
        return
      }
      if (event.key === LANGUAGE_PREFERENCE_KEY || event.key === null) {
        setPreference(languagePreference(event.newValue))
      }
    }
    window.addEventListener('languagechange', onLanguageChange)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('languagechange', onLanguageChange)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = language
    document.title = language === 'ja' ? '株式会社HaaS | 人の力につながるAI受付' : 'HaaS | Human as a Service · AI Reception'
    document.querySelector('meta[name="description"]')?.setAttribute('content', language === 'ja'
      ? 'AIの先に、人がいる。株式会社HaaSのAI総合受付。採用の相談も、仕事の依頼も。'
      : 'Beyond AI, there are people. The HaaS AI front desk welcomes job inquiries and work requests.')
  }, [language])

  function selectLanguage(next: LanguagePreference) {
    setPreference(next)
    if (next === 'auto') setLocale(browserLanguage())
    saveLanguagePreference(next)
  }

  return { language, preference, selectLanguage }
}
