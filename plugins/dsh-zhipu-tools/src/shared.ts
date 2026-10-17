/** 双端 wire 类型与常量：端点状态面板 ↔ host 路由。 */

export const ENDPOINT_STATUS_PATH = '/dsh-zhipu-tools/endpoint'

/** 智谱凭据的候选引用名（首选在前），面板提示用。 */
export const KEY_REFS = ['ZAI_CODING_CN_API_KEY', 'ZAI_API_KEY'] as const

/** GET endpoint 响应：面板据此渲染端点地址、接入步骤与运行状态。 */
export interface EndpointStatusView {
  /** 填入内置 Web 搜索设置的基础地址（null = 端点未在监听）。 */
  baseUrl: string | null
  /** 填进内置密钥栏的 API 密钥——同时是端点的 Bearer 访问令牌（null = 未监听）。 */
  token: string | null
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
  /** 两台 MCP 服务器的挂载结果。 */
  mcp: readonly { server: string; mounted: boolean }[]
}
