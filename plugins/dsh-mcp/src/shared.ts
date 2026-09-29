// dsh-mcp 线协议与共享常量：host 桥与 client 面板共用。读写都落在两层
// 用户 patch（profile 层 → home 层，同名 id 后层覆盖前层）；bundle 声明或
// `--patch` 覆盖引入的服务器行只读展示。

import type { Config, StdioConfig, StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import type { FiberStatus } from './live'

/** 官方 MCP client 插件的模块名（patch 行 `name` 字段的匹配值）。 */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** host 桥路由路径（client api.ts 复用，端点单源）。 */
export const LIST_PATH = '/dsh-mcp/list'
export const SAVE_PATH = '/dsh-mcp/save'
export const SET_ENABLED_PATH = '/dsh-mcp/set-enabled'
export const DELETE_PATH = '/dsh-mcp/delete'

/** 官方 mcp-client 对 serverName 的约束（保持模型侧工具名预算）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 面板可编辑的两层 patch 作用域。 */
export type McpScope = 'profile' | 'home'

export type McpReadOnlySource = 'bundle' | 'overlay'

export type McpTransport = Config['transport']

/**
 * 一次 MCP 服务器声明的可编辑字段：官方 Config 的展平投影——除
 * transport / serverName 外全部可缺（行可能声明不完整）。编辑时未知键
 * （reconnect、maxInstructionBytes 等）从现有生效配置原样保留。
 */
export interface McpConfigDraft {
  transport: McpTransport
  serverName: string
  command?: StdioConfig['command']
  args?: StdioConfig['args']
  env?: StdioConfig['env']
  cwd?: StdioConfig['cwd']
  url?: StreamableHttpConfig['url']
  headers?: StreamableHttpConfig['headers']
  toolCallTimeoutMs?: StdioConfig['toolCallTimeoutMs']
  failOnStartupError?: StdioConfig['failOnStartupError']
}

/** 宿主侧生效配置：已知键（均可缺——行可能声明不完整）+ 保留的未知键。 */
export type McpEffectiveConfig = Partial<McpConfigDraft> & Record<string, unknown>

/** 运行态：来自 Loader 条目 fiber 与工具注册表的可观测事实。 */
export interface McpLiveState {
  status: FiberStatus | 'absent'
  /** 该 server 当前注册的模型侧工具名（mcp__<serverName>__*）。 */
  tools: string[]
  /** failed 时的启动错误摘要。 */
  error?: string
}

/** 面板一行：一条 MCP 服务器声明及其运行态。 */
export interface McpRow {
  /** patch 行 id（创建时固定为 mcp-<serverName>）。 */
  id: string
  /** editable 行的可编辑层；只读行标注 bundle / overlay 来源。 */
  scope: McpScope | McpReadOnlySource
  config: McpEffectiveConfig
  /** 组合后的生效停用态。 */
  disabled: boolean
  editable: boolean
  /** 匹配到 Loader 条目时的运行态；文件行尚未生效（或无 HMR）时为 null。 */
  live: McpLiveState | null
}

export interface ListResponse {
  /** 当前 profile 名（host 侧 profileContext 提供）。 */
  profileName: string | null
  /** 两层可编辑 patch 的绝对路径（提示与定位用）。 */
  patchPaths: { profile: string; home: string }
  /** HMR 服务在场：写入可在线生效；否则需重启。 */
  hotApply: boolean
  servers: McpRow[]
}

export interface SaveRequest {
  scope: McpScope
  /** 编辑时的 patch 行 id；缺省为新建。 */
  id?: string
  config: McpConfigDraft
  /**
   * JSON 导入的未知键透传（reconnect / maxInstructionBytes 等高级键）。
   * host 过滤掉与已知键同名的项后合并进写入配置，Loader 的 schema
   * 校验兜底；表单模式不提交此字段。
   */
  extra?: Record<string, unknown>
}

export interface SaveResponse {
  id: string
  scope: McpScope
}

export interface SetEnabledRequest {
  scope: McpScope
  id: string
  enabled: boolean
}

export interface DeleteRequest {
  scope: McpScope
  id: string
}

export function rowIdOf(serverName: string): string {
  return `mcp-${serverName}`
}
