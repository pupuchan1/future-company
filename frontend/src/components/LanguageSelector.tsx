import type { DisplayLanguage, LanguagePreference } from '../lib/locale.ts'
import './language-selector.css'

export function LanguageSelector({ language, preference, onChange }: {
  language: DisplayLanguage
  preference: LanguagePreference
  onChange: (preference: LanguagePreference) => void
}) {
  return <label className="language-selector">
    <span aria-hidden="true">◎</span>
    <span className="language-selector-label">{language === 'ja' ? '言語' : 'Language'}</span>
    <select aria-label={language === 'ja' ? '画面と会話の言語' : 'Display and conversation language'}
      value={preference} onChange={event => onChange(event.target.value as LanguagePreference)}>
      <option value="auto">自動 / Auto</option>
      <option value="ja" lang="ja">日本語</option>
      <option value="en" lang="en">English</option>
    </select>
  </label>
}
