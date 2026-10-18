export type DisplayLanguage = 'ja' | 'en'
export type LanguagePreference = 'auto' | DisplayLanguage

export const LANGUAGE_PREFERENCE_KEY = 'future-company.display-language'

/** Match supported base languages in browser preference order. */
export function resolveLocale(locales: readonly string[]): DisplayLanguage {
  for (const locale of locales) {
    const language = locale.trim().toLowerCase().split(/[-_]/)[0]
    if (language === 'ja' || language === 'en') return language
  }
  return 'en'
}

export function browserLanguage(): DisplayLanguage {
  if (typeof navigator === 'undefined') return 'en'
  return resolveLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
}

export function languagePreference(value: string | null): LanguagePreference {
  return value === 'ja' || value === 'en' ? value : 'auto'
}

export function readLanguagePreference(): LanguagePreference {
  try {
    return languagePreference(localStorage.getItem(LANGUAGE_PREFERENCE_KEY))
  } catch {
    // Storage can be disabled; automatic detection still works.
    return 'auto'
  }
}

export function saveLanguagePreference(preference: LanguagePreference): void {
  try {
    if (preference === 'auto') localStorage.removeItem(LANGUAGE_PREFERENCE_KEY)
    else localStorage.setItem(LANGUAGE_PREFERENCE_KEY, preference)
  } catch {
    // Keep the current tab's selection even when it cannot be persisted.
  }
}
