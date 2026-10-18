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
    document.title = language === 'ja' ? 'Future Company | AI受付' : 'Future Company | AI Reception'
    document.querySelector('meta[name="description"]')?.setAttribute('content', language === 'ja'
      ? 'Future CompanyのAI受付。仕事の相談から、人への確認、会話メモまで。'
      : 'Future Company AI reception. Discuss work, ask the team, and keep track of your conversation.')
  }, [language])

  function selectLanguage(next: LanguagePreference) {
    setPreference(next)
    if (next === 'auto') setLocale(browserLanguage())
    saveLanguagePreference(next)
  }

  return { language, preference, selectLanguage }
}
