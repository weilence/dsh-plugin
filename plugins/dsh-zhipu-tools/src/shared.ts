/** 插件侧常量：两个 provider id 与智谱凭据候选引用名，provider 注册与凭据解析共用。 */

/** 智谱凭据的候选引用名（首选在前），凭据解析按序尝试。 */
export const KEY_REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const

/** 注册进 web 服务的搜索 provider id（官方设置页「网页搜索提供方」的点名值）。 */
export const SEARCH_PROVIDER_ID = 'zhipu-search-api'
/** 注册进 web 服务的抓取 provider id（官方设置页「网页获取提供方」的点名值）。 */
export const FETCH_PROVIDER_ID = 'zhipu-fetch-api'

/**
 * 官方设置页下拉的显示名（按语言各一份）：启动时按宿主 user-settings 的 locale 偏好
 * 取一——seam 的 title 是单字符串（官方 provider 的多语言靠客户端词典按 id 翻译，
 * 插件 provider 无此路径）；偏好缺席（跟随浏览器）时由调用方取英文。
 */
export const SEARCH_PROVIDER_TITLES = { zh: '智谱联网搜索', en: 'Zhipu Web Search' } as const
export const FETCH_PROVIDER_TITLES = { zh: '智谱网页阅读', en: 'Zhipu Web Reader' } as const

/**
 * 选中该 provider 时官方页面在下拉下方展示的说明行（LocalizedText：en 必填，
 * 其余按界面语言小写语言 id 匹配，未命中回退 en）。
 */
export const SEARCH_PROVIDER_DESCRIPTION = {
  en: 'Runs web search through the Zhipu Coding Plan; reuses the zai-coding-cn credential.',
  zh: '经智谱 Coding Plan 执行联网搜索，密钥复用 zai-coding-cn 凭据。',
} as const
export const FETCH_PROVIDER_DESCRIPTION = {
  en: 'Fetches page content through the Zhipu web reader; returns extracted Markdown.',
  zh: '经智谱网页阅读抓取页面，返回提取的 Markdown 正文。',
} as const
