import type { CommonKey } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type McpKey } from '../src/client/locales'

// 测试环境无法取到宿主 common 词典的运行时值；这里按组件实际用到的公共词条
// 快照一份（缺项会以键名落进断言，易于发现）。
const COMMON_ZH: Partial<Record<CommonKey, string>> = {
  cancel: '取消',
  close: '关闭',
  delete: '删除',
  save: '保存',
}
const COMMON_EN: Partial<Record<CommonKey, string>> = {
  cancel: 'Cancel',
  close: 'Close',
  delete: 'Delete',
  save: 'Save',
}

/**
 * 单测取词函数：与宿主 LocaleRuntime.translate 同一种 `{参数}` 插值
 * （未知参数原样保留、缺失键显示键本身），键域覆盖本插件词典与 common 词条。
 */
export function makeT(active: 'zh' | 'en' = 'zh') {
  const own: Record<string, string> = active === 'zh' ? zh : en
  const common = active === 'zh' ? COMMON_ZH : COMMON_EN
  return (key: McpKey | CommonKey, params?: Record<string, unknown>): string => {
    const template = (own as Record<string, string>)[key] ?? common[key as CommonKey] ?? key
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match,
    )
  }
}
