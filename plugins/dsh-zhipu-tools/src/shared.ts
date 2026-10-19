/** 双端 wire 类型与常量：端点状态面板 ↔ host 路由。 */

export const ENDPOINT_STATUS_PATH = '/dsh-zhipu-tools/endpoint'
export const APPLY_WEB_CONFIG_PATH = '/dsh-zhipu-tools/apply-web-config'

/** 智谱凭据的候选引用名（首选在前），面板提示与端点鉴权共用。 */
export const KEY_REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const

/** GET endpoint 响应：面板据此渲染端点地址与运行状态。 */
export interface EndpointStatusView {
  /** 填入内置 Web 搜索设置的基础地址（null = 端点未在监听）。 */
  baseUrl: string | null
  /** 实际监听端口（null = 未监听）。 */
  port: number | null
  /** 端点启动失败原因（errMsg 原文）。 */
  failure: string | null
  /** 智谱凭据解析结果（每次状态读取时现查）。 */
  credential: {
    configured: boolean
    /** 解析故障说明（未配置时为 undefined）。 */
    failure: string | undefined
  }
  /** `/fetch` 的实际后端（透明展示）。 */
  fetchBackend: 'zhipu-reader'
  /** profile patch 文件的 mtime（apply 的乐观并发基线；文件缺失为 null）。 */
  patchMtimeMs: number | null
}

/** POST apply-web-config 请求体。 */
export interface ApplyWebConfigBody {
  /** 状态读取时见到的 patch mtime；不符即 409，防止覆盖外部修改。 */
  expectedMtimeMs?: number
}
