import type { Config, StdioConfig, StreamableHttpConfig } from '@deepseek-ai/dsh-mcp-client'
import type { FiberStatus } from './live'

/** 官方 MCP client 插件的模块名（动态挂载 Loader 行时的 `name` 字段）。 */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** 本插件动态挂载的 Loader 行 id 前缀：与 patch 行的 `mcp-` 前缀区分开，
 *  diff 时只增改删自己名下的条目，patch / 其他插件的行一律不碰。 */
export const ENTRY_PREFIX = 'mcpx-'

/** 工作区档文件：工作区根下的惯例名称（对齐 Claude Code / Cursor 的 .mcp.json）。 */
export const WORKSPACE_FILENAME = '.mcp.json'

/** 全局档文件：`~/.dsh` 下的名称，与工作区档同名对称。 */
export const GLOBAL_FILENAME = 'mcp.json'

/** host 路由路径（client api.ts 复用，端点单源）。 */
export const LIST_PATH = '/dsh-mcp/list'
export const SAVE_PATH = '/dsh-mcp/save'
export const CHECK_PATH = '/dsh-mcp/check'
export const SET_ENABLED_PATH = '/dsh-mcp/set-enabled'
export const DELETE_PATH = '/dsh-mcp/delete'
export const CWD_PATH = '/dsh-mcp/cwd'

/** 官方 mcp-client 对 serverName 的约束（保持模型侧工具名预算）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 面板管理的两档：全局档（~/.dsh/mcp.json）与工作区档（<cwd>/.mcp.json）。 */
export type McpScope = 'global' | 'workspace'

export type McpTransport = Config['transport']

/**
 * 一次 MCP 服务器声明的可编辑字段：官方 Config 的展平投影——除
 * transport / serverName 外全部可缺。编辑时未知键（reconnect、
 * maxInstructionBytes 等）从现有配置原样保留。
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

/** 宿主侧生效配置：已知键（均可缺）+ 身份保留的未知键。 */
export type McpEffectiveConfig = Partial<McpConfigDraft> & Record<string, unknown>

/** 运行态：来自 Loader 条目 fiber 与工具注册表的可观测事实。 */
export interface McpLiveState {
  status: FiberStatus | 'absent'
  /** 该 server 当前注册的模型侧工具名（mcp__<serverName>__*）。 */
  tools: string[]
  /** failed 时的启动错误摘要。 */
  error?: string
}

/** 面板一行：一份文件里的 MCP 服务器声明及其运行态。 */
export interface McpRow {
  /** 所属档：全局 / 工作区。 */
  scope: McpScope
  /** 服务器名（.mcp.json 里的键，即 serverName）。 */
  name: string
  /** 映射为 mcp-client Config 形态的配置（含身份保留的未知键）。 */
  config: McpEffectiveConfig
  /** 文件里的 disabled 扩展键。 */
  disabled: boolean
  /** Loader 条目的运行态；loader 服务不可用时为 null。 */
  live: McpLiveState | null
  /** 条目不合法的原因（未挂载，只能展示或删除）。 */
  invalid?: string
  /** 同名被工作区档遮蔽（仅全局行；遮蔽期间不创建运行实例）。 */
  shadowed?: boolean
}

export interface ListResponse {
  /** 当前 profile 名（host 侧 profileContext 提供）。 */
  profileName: string | null
  /** 全局 / 工作区文件的绝对路径（提示与定位用；cwd 未知时 workspacePath 为 null）。 */
  globalPath: string
  workspacePath: string | null
  /** 同步与挂载过程中的非致命告警（loader 缺席、行 id 被占等）。 */
  warnings: string[]
  /** 两份文件的内容版本（乐观并发；文件不存在时为 null）。 */
  revisions: { global: string | null; workspace: string | null }
  servers: McpRow[]
}

/** 一次保存 / 启停 / 删除请求：scope 定位文件，cwd 为工作区档定位工作目录。 */
export interface SaveRequest {
  scope: McpScope
  /** 工作区档必带：主视图会话的工作目录。 */
  cwd?: string
  /** 服务器名（文件里的键）；改名 = 删除后新建，编辑时不可改。 */
  name: string
  config: McpConfigDraft
  /**
   * 表单外的高级键（reconnect / maxInstructionBytes 等）。host 过滤掉与
   * 已知键同名的项后并入写盘条目；表单模式不提交此字段。
   */
  extra?: Record<string, unknown>
  /** 行级停用（文件里的 disabled 扩展键）；缺省不动。 */
  disabled?: boolean
  /** 读取时的文件内容版本，冲突（409）后须刷新重试。 */
  revision: string | null
}

export interface SaveResponse {
  scope: McpScope
  name: string
}

/** 保存前的连接检查请求：对单个服务器配置做 initialize 握手探测。 */
export interface CheckRequest {
  config: McpConfigDraft
}

/** 探测结论（失败是结果不是异常，走 200 应答由前端决定去留）。 */
export interface CheckResponse {
  ok: boolean
  /** ok=false 时的失败原因（带实际错误内容）。 */
  error?: string
}

export interface SetEnabledRequest {
  scope: McpScope
  cwd?: string
  name: string
  enabled: boolean
  revision: string | null
}

export interface DeleteRequest {
  scope: McpScope
  cwd?: string
  name: string
  revision: string | null
}

/** client 启动与会话切换时上报的主视图工作目录（工作区档定位事实源）。 */
export interface CwdRequest {
  cwd?: string
}

/** 动态挂载的 Loader 行 id（scope 内唯一，跨档不冲突）。 */
export function entryIdOf(scope: McpScope, name: string): string {
  return `${ENTRY_PREFIX}${scope}-${name}`
}
