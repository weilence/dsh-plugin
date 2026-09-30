import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type NotifyKey } from '../src/client/locales'

/**
 * 单测取词函数：与宿主 LocaleRuntime.translate 同一种 `{参数}` 插值
 * （未知参数原样保留、缺失键显示键本身）。dsh-notify 不使用 common 词条，
 * 键域仍按契约覆盖它。
 */
export function makeT(active: 'zh' | 'en' = 'zh') {
  const dict: Record<string, string> = active === 'zh' ? zh : en
  return (key: NotifyKey | CommonKey, params?: Record<string, unknown>): string => {
    const template = dict[key] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    )
  }
}
