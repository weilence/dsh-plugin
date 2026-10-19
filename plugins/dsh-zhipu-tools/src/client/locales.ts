import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-zhipu-tools'

export type ZhipuT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  loading: '正在读取状态…',
  'credential.label': '智谱凭据',
  'apply.label': '写入 Web 搜索配置',
  'notice.applied': '已写入内置 Web 搜索配置，改动即时生效',
  'credential.ok': '已配置',
  'credential.missing': '未配置（{refs}）',
} as const

export type ZhipuKey = keyof typeof zh

export const en: { [Key in ZhipuKey]: string } = {
  loading: 'Reading the state…',
  'credential.label': 'Zhipu credential',
  'apply.label': 'Apply Web search config',
  'notice.applied': 'Web search config written; effective immediately',
  'credential.ok': 'Configured',
  'credential.missing': 'Not configured ({refs})',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-zhipu-tools': ZhipuKey
  }
}
