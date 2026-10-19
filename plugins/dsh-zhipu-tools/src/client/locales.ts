import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-zhipu-tools'

export type ZhipuT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  loading: '正在读取状态…',
  'switch.label': 'Web 搜索走智谱',
  'switch.hint': '开启后 web_search 与 web_fetch 经智谱执行；关闭恢复部署默认的搜索实现。',
  'credential.badge.missing': '未配置',
  'credential.missing': '未配置（{refs}）',
} as const

export type ZhipuKey = keyof typeof zh

export const en: { [Key in ZhipuKey]: string } = {
  loading: 'Reading the state…',
  'switch.label': 'Route web search through Zhipu',
  'switch.hint':
    'When on, web_search and web_fetch run through Zhipu; when off, the deployment defaults apply.',
  'credential.badge.missing': 'Not configured',
  'credential.missing': 'Not configured ({refs})',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-zhipu-tools': ZhipuKey
  }
}
