import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** 本插件的词典命名空间：注册进宿主 locale 服务，语言选择与回退由其统一裁决。 */
export const NS = 'dsh-zhipu-tools'

export type ZhipuT = TranslateNS<typeof NS>

/** zh 是键集的事实源；en 逐键补全，缺失键在编译期报错。 */
export const zh = {
  title: '智谱搜索端点',
  subtitle:
    '在内置 Web 搜索设置里把 Search / Fetch API base URL 指向本端点，官方 web_search 即经智谱联网搜索返回结果；不替换内置搜索插件，zhipu_search / zhipu_reader MCP 工具不受影响。',
  loading: '正在读取端点状态…',
  'endpoint.label': '端点地址',
  'endpoint.copy': '复制地址',
  'endpoint.key': 'API 密钥',
  'endpoint.copyKey': '复制密钥',
  'notice.copied': '已复制端点地址',
  'notice.copiedKey': '已复制 API 密钥',
  'meta.listen': '监听状态',
  'meta.credential': '智谱凭据',
  'meta.mcp': 'MCP 工具',
  'meta.fetchBackend': '抓取后端',
  'status.listening': '已监听 127.0.0.1:{port}',
  'status.down': '未监听',
  'credential.ok': '已配置',
  'credential.missing': '未配置（{refs}）',
  'steps.title': '接入步骤',
  'step.open': '打开 设置 → 插件 → 内置插件设置 → Web search。',
  'step.enable': '开启「启用新版 Web 搜索 API」。',
  'step.paste': '把上面的端点地址粘贴到「Search / Fetch API base URL」。',
  'step.key': '把上面的 API 密钥粘贴到同一页的密钥栏并保存。',
  'note.deepseekKey':
    'API 密钥同时充当内置提供方要求的凭据：填进密钥栏即可通过其派发前检查，无需 DeepSeek 账号或真实 API Key，任意模型的会话都生效。',
  'note.security': 'API 密钥即端点的访问令牌，请勿提交到版本库或粘贴到不可信位置。',
  'note.fetch':
    '搜索与网页抓取（web_fetch）都走智谱：搜索经联网搜索、抓取经网页阅读（webReader），不经过 DeepSeek。',
} as const

export type ZhipuKey = keyof typeof zh

export const en: { [Key in ZhipuKey]: string } = {
  title: 'Zhipu search endpoint',
  subtitle:
    'Point the Search / Fetch API base URL in the built-in Web search settings at this endpoint and the official web_search returns Zhipu web results; the built-in search plugin is not replaced, and the zhipu_search / zhipu_reader MCP tools are unaffected.',
  loading: 'Reading the endpoint state…',
  'endpoint.label': 'Endpoint URL',
  'endpoint.copy': 'Copy URL',
  'endpoint.key': 'API key',
  'endpoint.copyKey': 'Copy key',
  'notice.copied': 'Endpoint URL copied',
  'notice.copiedKey': 'API key copied',
  'meta.listen': 'Listening',
  'meta.credential': 'Zhipu credential',
  'meta.mcp': 'MCP tools',
  'meta.fetchBackend': 'Fetch backend',
  'status.listening': 'Listening on 127.0.0.1:{port}',
  'status.down': 'Not listening',
  'credential.ok': 'Configured',
  'credential.missing': 'Not configured ({refs})',
  'steps.title': 'Setup steps',
  'step.open': 'Open Settings → Plugins → Built-in plugin settings → Web search.',
  'step.enable': 'Turn on "Use the new Web Search API".',
  'step.paste': 'Paste the endpoint URL above into "Search / Fetch API base URL".',
  'step.key': 'Paste the API key above into the key field on the same page and save.',
  'note.deepseekKey':
    'The API key also serves as the credential the built-in provider demands: filling it into the key field passes its pre-dispatch check — no DeepSeek account or real API key needed, and it applies to conversations on any model.',
  'note.security':
    'The API key is the endpoint access token; keep it out of version control and untrusted paste targets.',
  'note.fetch':
    'Both search and page fetches (web_fetch) go through Zhipu: search via web search, fetch via webReader — never through DeepSeek.',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-zhipu-tools': ZhipuKey
  }
}
