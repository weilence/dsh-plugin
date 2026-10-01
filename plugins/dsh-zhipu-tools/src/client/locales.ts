import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-zhipu-tools'

export type ZhipuT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  title: '智谱搜索',
  subtitle:
    '把官方 web_search 工具的实际搜索后端切换为智谱联网搜索；工具名、参数与结果卡片保持官方原样。智谱搜索 / 网页阅读 MCP 工具不受此开关影响。',
  loading: '正在读取搜索替换状态…',
  'switch.label': '用智谱替换 web_search 搜索',
  'state.replaced': '已替换',
  'state.official': '使用官方搜索',
  'state.waiting': '等待生效',
  'meta.provider': '当前生效搜索提供者',
  'meta.source': '状态来源',
  'meta.effect': '生效方式',
  'meta.writeTarget': '下次开启写入位置',
  'writeTarget.createHome': '新建于 {path}',
  'writeTarget.inPlaceHome': '就地修改 {path}',
  'writeTarget.inPlaceProfile': '就地修改 {path}',
  'provider.unconfigured': '（未配置，自动选择）',
  'source.runtime': '运行时生效值',
  'source.runtimeUnequal': '运行时生效值（两层文件算出 {provider}，尚未一致）',
  'source.fileOnly': '两层文件推算（运行时不可读）',
  'source.fileUnconfigured': '（未配置）',
  'effect.waiting': '等待宿主应用…',
  'effect.hot': '修改可在线生效',
  'effect.restart': '写入后需重启宿主生效',
  'hint.settlingHot': '已写入，宿主正在重新组装配置（约数秒）',
  'hint.settlingRestart': '已写入；当前宿主不支持在线生效，重启后生效',
  'hint.uninstall': '卸载本插件前请先关闭替换，否则残留的 patch 行会让 web_search 找不到智谱提供者',
  'hint.notEditable': '当前不可修改',
  'notice.written': '已写入 {scope} 层 patch，{action}替换',
  'notice.idle': '已处于{action}状态，未改动文件',
  'action.enabled': '开启',
  'action.disabled': '关闭',
} as const

export type ZhipuKey = keyof typeof zh

export const en: { [Key in ZhipuKey]: string } = {
  title: 'Zhipu search',
  subtitle:
    'Switches the actual search backend of the official web_search tool to Zhipu web search; the tool name, parameters, and result cards stay as shipped. The Zhipu search / web reader MCP tools are unaffected by this switch.',
  loading: 'Reading the search override state…',
  'switch.label': 'Replace web_search with Zhipu',
  'state.replaced': 'Replaced',
  'state.official': 'Using official search',
  'state.waiting': 'Waiting to take effect',
  'meta.provider': 'Active search provider',
  'meta.source': 'State source',
  'meta.effect': 'How changes apply',
  'meta.writeTarget': 'Write target of the next enable',
  'writeTarget.createHome': 'Create in {path}',
  'writeTarget.inPlaceHome': 'Edit in place {path}',
  'writeTarget.inPlaceProfile': 'Edit in place {path}',
  'provider.unconfigured': '(unconfigured, auto-selected)',
  'source.runtime': 'Runtime effective value',
  'source.runtimeUnequal': 'Runtime effective value (files resolve to {provider}, not yet in sync)',
  'source.fileOnly': 'Resolved from the two file layers (runtime unreadable)',
  'source.fileUnconfigured': '(unconfigured)',
  'effect.waiting': 'Waiting for the host to apply…',
  'effect.hot': 'Changes apply online',
  'effect.restart': 'Requires a host restart after writing',
  'hint.settlingHot': 'Written; the host is reassembling its configuration (a few seconds)',
  'hint.settlingRestart': 'Written; this host cannot apply online, effective after restart',
  'hint.uninstall':
    'Turn the override off before uninstalling this plugin; a leftover patch row would leave web_search unable to find the Zhipu provider',
  'hint.notEditable': 'Not editable right now',
  'notice.written': 'Wrote the {scope}-layer patch; override {action}',
  'notice.idle': 'Already {action}; no file changed',
  'action.enabled': 'enabled',
  'action.disabled': 'disabled',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-zhipu-tools': ZhipuKey
  }
}
