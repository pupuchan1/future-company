import type { LiveLanguage, LiveTranscript } from '../live/types.ts'

export function transcriptText(entries: LiveTranscript[], language: LiveLanguage) {
  return entries.map(entry => `${entry.role === 'user' ? language === 'ja' ? 'あなた' : 'You' : entry.role === 'system' ? language === 'ja' ? 'お知らせ' : 'Notice' : 'AI'}\n${entry.text}`).join('\n\n')
}
