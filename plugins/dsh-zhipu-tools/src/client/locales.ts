import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-zhipu-tools'

export type ZhipuT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  loading: '正在读取端点状态…',
  'endpoint.label': '端点地址',
  'apply.label': '写入 Web 搜索配置',
  'notice.applied': '已写入内置 Web 搜索配置，改动即时生效',
  'status.listening': '已监听',
  'status.down': '未监听',
  'credential.ok': '凭据已配置',
  'credential.missing': '凭据未配置（{refs}）',
} as const

export type ZhipuKey = keyof typeof zh

export const en: { [Key in ZhipuKey]: string } = {
  loading: 'Reading the endpoint state…',
  'endpoint.label': 'Endpoint URL',
  'apply.label': 'Apply Web search config',
  'notice.applied': 'Web search config written; effective immediately',
  'status.listening': 'Listening',
  'status.down': 'Not listening',
  'credential.ok': 'Credential configured',
  'credential.missing': 'Credential not configured ({refs})',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-zhipu-tools': ZhipuKey
  }
}
