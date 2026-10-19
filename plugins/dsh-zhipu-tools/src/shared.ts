/** 双端 wire 类型与常量：插件面板 ↔ host 路由，provider 注册与写入共用。 */

export const STATUS_PATH = '/dsh-zhipu-tools/status'
export const APPLY_WEB_CONFIG_PATH = '/dsh-zhipu-tools/apply-web-config'

/** 智谱凭据的候选引用名（首选在前），面板提示与凭据解析共用。 */
export const KEY_REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const

/** 注册进 web 服务的搜索 provider id（写入 web 行 searchProvider 的值）。 */
export const SEARCH_PROVIDER_ID = 'zhipu-search-api'
/** 注册进 web 服务的抓取 provider id（写入 web 行 fetchProvider 的值）。 */
export const FETCH_PROVIDER_ID = 'zhipu-fetch-api'

/** GET status 响应：面板据此渲染凭据状态并决定按钮可用性。 */
export interface StatusView {
  /** 智谱凭据解析结果（每次状态读取时现查）。 */
  credential: {
    configured: boolean
    /** 解析故障说明（未配置时为 undefined）。 */
    failure: string | undefined
  }
}
