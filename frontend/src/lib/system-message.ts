import type { DisplayLanguage } from './locale.ts'

/** Only system alerts use this formatter; conversation and human replies stay original. */
export function systemMessage(message: string, language: DisplayLanguage): string {
  const separator = message.indexOf(' / ')
  if (separator < 0 || !/[\u3040-\u30ff\u3400-\u9fff]/u.test(message.slice(0, separator))) return message
  return language === 'en' ? message.slice(separator + 3) : message.slice(0, separator)
}
