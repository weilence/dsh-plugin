import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type SessionsKey } from '../src/client/locales'

export function makeT(language: 'zh' | 'en' = 'zh') {
  const dictionary: Record<string, string> = {
    close: language === 'zh' ? '关闭' : 'Close',
    ...(language === 'zh' ? zh : en),
  }
  return (key: SessionsKey | CommonKey, params?: Record<string, unknown>): string => {
    const text = dictionary[key] ?? key
    return params === undefined
      ? text
      : text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }
}
