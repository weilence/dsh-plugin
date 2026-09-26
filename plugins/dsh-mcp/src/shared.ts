/**
 * dsh-mcp 线协议与共享常量：host 桥与 client 面板共用的类型和规则。
 *
 * DSH 的 MCP 服务器即 cordis patch 里的一个 `@deepseek-ai/dsh-mcp-client`
 * 插件行（stdio 子进程或 streamable-http 端点），本插件不做第二套配置
 * 存储——读写都落在 profile 的两层用户 patch 上：
 *
 * - profile 层：<profile>/cordis.patch.yml，仅当前 profile 生效；
 * - home 层：<DSH_HOME>/cordis.patch.yml，所有 profile 共享（应用顺序在
 *   profile 层之后，同名 id 的后层覆盖前层）。
 *
 * bundle 声明或 `--patch` 覆盖引入的服务器行只读展示。
 */

/** 官方 MCP client 插件的模块名（patch 行 `name` 字段的匹配值）。 */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** 官方 mcp-client 对 serverName 的约束（保持模型侧工具名预算）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** 面板可编辑的两层 patch 作用域。 */
export type McpScope = 'profile' | 'home'

/** 只读来源的标注。 */
export type McpReadOnlySource = 'bundle' | 'overlay'

export type McpTransport = 'stdio' | 'streamable-http'

/**
 * 一次 MCP 服务器声明的可编辑字段。编辑时未知字段（reconnect、
 * maxInstructionBytes 等）从现有生效配置原样保留，客户端只提交已知键。
 */
export interface McpConfigDraft {
  transport: McpTransport
  /** 模型侧工具名前缀（mcp__<serverName>__*）。 */
  serverName: string
  /** stdio：可执行文件。 */
  command?: string
  /** stdio：参数（不经 shell 插值）。 */
  args?: string[]
  /** stdio：附加环境变量。 */
  env?: Record<string, string>
  /** stdio：子进程工作目录。 */
  cwd?: string
  /** streamable-http：MCP 端点 URL。 */
  url?: string
  /** streamable-http：附加请求头。 */
  headers?: Record<string, string>
  /** 单次工具调用 / 资源请求超时（毫秒），缺省 60000。 */
  toolCallTimeoutMs?: number
  /** 初始连接或工具同步失败时让插件行失败（阻止激活），缺省 false。 */
  failOnStartupError?: boolean
}

/** 宿主侧生效配置：已知键（均可缺——行可能声明不完整）+ 保留的未知键。 */
export type McpEffectiveConfig = Partial<McpConfigDraft> & Record<string, unknown>

/** 运行态：来自 Loader 条目 fiber 与工具注册表的可观测事实。 */
export interface McpLiveState {
  status: 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'absent'
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

/** 作用域展示名。 */
export const SCOPE_LABELS: Record<McpScope | McpReadOnlySource, string> = {
  profile: '本 Profile',
  home: '全局（~/.dsh）',
  bundle: 'Bundle 声明',
  overlay: '运行时覆盖（--patch）',
}

/** serverName → 稳定 patch 行 id。 */
export function rowIdOf(serverName: string): string {
  return `mcp-${serverName}`
}
